import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Repository, type QueryDeepPartialEntity } from 'typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type { EditedMessage, IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { chatKind } from '../../engine/identity/wa-id';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { evaluateMonitorRule } from './monitoring.evaluator';
import {
  MONITOR_BODY_MAX,
  MONITOR_MATCHES_RETAINED_PER_SESSION_MAX,
  type MonitorEnvelope,
  type MonitorRuleConfig,
} from './monitoring.types';
import { MonitorGroup, MonitorMatch, MonitorProfile, MonitorRule } from './entities';
import { recordMonitorDeduplication, recordMonitorMatch } from '../../common/metrics/monitoring-metrics';

const truncatedBody = (body: string | null | undefined): string | null => {
  if (!body) return null;
  return body.length <= MONITOR_BODY_MAX ? body : `${body.slice(0, MONITOR_BODY_MAX)}\n[truncated]`;
};

const compactMedia = (
  media: IncomingMessage['media'] | Record<string, unknown> | null | undefined,
): Record<string, unknown> | null => {
  if (!media || typeof media !== 'object') return null;
  const record = media as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['mimetype', 'filename', 'sizeBytes', 'omitted']) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return Object.keys(out).length ? out : null;
};

function ruleConfig(rule: MonitorRule): MonitorRuleConfig {
  return {
    name: rule.name,
    enabled: rule.enabled,
    matchMode: rule.matchMode,
    conditions: rule.conditions,
    exclusions: rule.exclusions,
    priority: rule.priority,
    tags: rule.tags,
    timezone: rule.timezone,
    ...(rule.activeHours ? { activeHours: rule.activeHours } : {}),
    ...(rule.quietHours ? { quietHours: rule.quietHours } : {}),
    ...(rule.retentionDays ? { retentionDays: rule.retentionDays } : {}),
  };
}

@Injectable()
export class MonitoringIngestService {
  constructor(
    @InjectDataSource('data') private readonly dataSource: DataSource,
    @InjectRepository(MonitorGroup, 'data') private readonly groups: Repository<MonitorGroup>,
    @InjectRepository(MonitorMatch, 'data') private readonly matches: Repository<MonitorMatch>,
  ) {}

  async ingestIncoming(sessionId: string, message: IncomingMessage): Promise<void> {
    if (message.fromMe || !message.isGroup || chatKind(message.chatId) !== 'group' || !message.id) return;
    const envelope: MonitorEnvelope = {
      sessionId,
      groupJid: message.chatId,
      messageId: message.id,
      senderJid: message.author ?? message.from,
      senderLabel: message.contact?.pushName ?? message.contact?.name,
      timestamp: message.timestamp,
      type: message.type,
      body: message.body ?? '',
      mentionedJids: message.mentionedIds ?? [],
      hasMedia: Boolean(message.media),
      media: message.media
        ? {
            mimetype: message.media.mimetype,
            filename: message.media.filename,
            size: message.media.sizeBytes,
            omitted: message.media.omitted,
          }
        : undefined,
      isReply: Boolean(message.quotedMessage),
      fromMe: false,
    };
    await this.ingestEnvelope(envelope, compactMedia(message.media), true);
  }

  async ingestStored(message: Message): Promise<void> {
    if (
      message.direction !== MessageDirection.INCOMING ||
      !message.waMessageId ||
      chatKind(message.chatId) !== 'group'
    ) {
      return;
    }
    const metadata = message.metadata ?? {};
    const mentionedJids = Array.isArray(metadata.mentionedIds)
      ? metadata.mentionedIds.filter((value): value is string => typeof value === 'string').slice(0, 50)
      : [];
    const media = compactMedia(metadata.media as Record<string, unknown> | undefined);
    const envelope: MonitorEnvelope = {
      sessionId: message.sessionId,
      groupJid: message.chatId,
      messageId: message.waMessageId,
      senderJid: message.author ?? message.from,
      senderLabel: message.chatName,
      timestamp: message.timestamp,
      type: message.type,
      body: message.body ?? '',
      mentionedJids,
      hasMedia: Boolean(media),
      media: media
        ? {
            mimetype: typeof media.mimetype === 'string' ? media.mimetype : undefined,
            filename: typeof media.filename === 'string' ? media.filename : undefined,
            size: typeof media.sizeBytes === 'number' ? media.sizeBytes : undefined,
            omitted: media.omitted === true,
          }
        : undefined,
      isReply: metadata.quotedMessage != null,
      fromMe: false,
      revoked: message.type === 'revoked',
    };
    await this.ingestEnvelope(envelope, media, false);
  }

  async reconcileEdit(sessionId: string, message: EditedMessage): Promise<void> {
    await this.dataSource.transaction(manager => this.reconcileEditInTransaction(manager, sessionId, message));
  }

  async reconcileEditInTransaction(manager: EntityManager, sessionId: string, message: EditedMessage): Promise<void> {
    if (message.fromMe || !message.isGroup) return;
    await manager.getRepository(MonitorMatch).delete({
      sessionId,
      messageId: message.messageId,
      state: 'pending',
    });
    await this.ingestEnvelope(
      {
        sessionId,
        groupJid: message.chatId,
        messageId: message.messageId,
        senderJid: message.author ?? message.senderId,
        timestamp: message.timestamp,
        type: message.type,
        body: message.body,
        mentionedJids: message.mentionedIds ?? [],
        hasMedia: message.hasMedia,
        isReply: false,
        fromMe: false,
      },
      message.hasMedia ? { omitted: true } : null,
      false,
      manager,
    );
  }

  async reconcileRevoke(sessionId: string, messageId: string): Promise<void> {
    await this.dataSource.transaction(manager => this.reconcileRevokeInTransaction(manager, sessionId, messageId));
  }

  async reconcileRevokeInTransaction(manager: EntityManager, sessionId: string, messageId: string): Promise<void> {
    await manager
      .getRepository(MonitorMatch)
      .update(
        { sessionId, messageId },
        { body: null, messageType: 'revoked', media: null, evidence: ['source message revoked'] },
      );
  }

  private async ingestEnvelope(
    envelope: MonitorEnvelope,
    media: Record<string, unknown> | null,
    countDeduplication: boolean,
    manager?: EntityManager,
  ): Promise<void> {
    if (envelope.revoked) return;
    const selectedGroups = await (manager?.getRepository(MonitorGroup) ?? this.groups).find({
      where: { sessionId: envelope.sessionId, groupJid: envelope.groupJid, enabled: true },
    });
    if (!selectedGroups.length) return;

    for (const group of selectedGroups) {
      if (manager) {
        await this.ingestForLockedGroup(manager, group, envelope, media, countDeduplication);
      } else {
        await this.dataSource.transaction(transactionManager =>
          this.ingestForLockedGroup(transactionManager, group, envelope, media, countDeduplication),
        );
      }
    }
  }

  /**
   * Re-read configuration and hold shared row locks through match insertion. PostgreSQL updates that
   * disable/remove a group or rule wait for this transaction, so no insert can commit after the
   * control-plane operation returns. SQLite serializes the competing write transactions globally.
   */
  private async ingestForLockedGroup(
    manager: EntityManager,
    selected: MonitorGroup,
    envelope: MonitorEnvelope,
    media: Record<string, unknown> | null,
    countDeduplication: boolean,
  ): Promise<void> {
    const supportsRowLocks = this.dataSource.options.type === 'postgres';
    const groupQuery = manager
      .getRepository(MonitorGroup)
      .createQueryBuilder('monitorGroup')
      .where(
        'monitorGroup.id = :id AND monitorGroup.principalId = :principalId AND monitorGroup.sessionId = :sessionId AND monitorGroup.enabled = :enabled',
        {
          id: selected.id,
          principalId: selected.principalId,
          sessionId: selected.sessionId,
          enabled: true,
        },
      );
    if (supportsRowLocks) groupQuery.setLock('pessimistic_read');
    const group = await groupQuery.getOne();
    if (!group) return;

    const ruleQuery = manager
      .getRepository(MonitorRule)
      .createQueryBuilder('monitorRule')
      .where(
        'monitorRule.principalId = :principalId AND monitorRule.sessionId = :sessionId AND monitorRule.groupJid = :groupJid AND monitorRule.enabled = :enabled',
        {
          principalId: group.principalId,
          sessionId: group.sessionId,
          groupJid: group.groupJid,
          enabled: true,
        },
      );
    if (supportsRowLocks) ruleQuery.setLock('pessimistic_read');
    const profileQuery = manager
      .getRepository(MonitorProfile)
      .createQueryBuilder('monitorProfile')
      .where(
        'monitorProfile.principalId = :principalId AND monitorProfile.sessionId = :sessionId AND monitorProfile.enabled = :enabled',
        { principalId: group.principalId, sessionId: group.sessionId, enabled: true },
      );
    // Serializing through the one profile row makes the retained-row cap exact even when messages
    // for different monitored groups arrive concurrently.
    if (supportsRowLocks) profileQuery.setLock('pessimistic_write');
    const profile = await profileQuery.getOne();
    const session = await manager.getRepository(Session).findOne({ where: { id: envelope.sessionId } });
    const rules = await ruleQuery.getMany();
    if (!profile || !session) return;
    const ownerJid = profile.ownerJid ?? session.phone;
    const matchRepository = manager.getRepository(MonitorMatch);
    let retainedMatches = await matchRepository
      .createQueryBuilder('monitorMatch')
      .where('monitorMatch.principalId = :principalId AND monitorMatch.sessionId = :sessionId', {
        principalId: group.principalId,
        sessionId: group.sessionId,
      })
      .andWhere('monitorMatch.expiresAt > :now', { now: new Date() })
      .getCount();

    for (const rule of rules) {
      if (retainedMatches >= MONITOR_MATCHES_RETAINED_PER_SESSION_MAX) break;
      const evaluation = evaluateMonitorRule(ruleConfig(rule), envelope, ownerJid);
      if (!evaluation.matched && !evaluation.candidate) continue;
      const retentionDays = rule.retentionDays ?? profile.retentionDays;
      const expiresAt = new Date(Date.now() + retentionDays * 86_400_000);
      const row = matchRepository.create({
        id: randomUUID(),
        principalId: rule.principalId,
        sessionId: rule.sessionId,
        groupJid: rule.groupJid,
        groupName: group.name,
        ruleId: rule.id,
        ruleVersion: rule.version,
        matchMode: rule.matchMode,
        messageId: envelope.messageId,
        senderJid: envelope.senderJid,
        senderLabel: envelope.senderLabel ?? null,
        messageTimestamp: envelope.timestamp,
        messageType: envelope.type,
        body: truncatedBody(envelope.body),
        media,
        evidence: evaluation.evidence,
        semanticConditions: evaluation.semanticConditions,
        urgency: evaluation.urgency,
        priority: rule.priority,
        tags: rule.tags,
        state: 'pending',
        acknowledgedAt: null,
        expiresAt,
      });
      await matchRepository
        .createQueryBuilder()
        .insert()
        .into(MonitorMatch)
        .values(row as unknown as QueryDeepPartialEntity<MonitorMatch>)
        .orIgnore()
        .execute();
      if (await matchRepository.existsBy({ id: row.id })) {
        retainedMatches += 1;
        recordMonitorMatch(rule.priority, evaluation.candidate);
      } else if (countDeduplication) recordMonitorDeduplication();
    }
  }
}
