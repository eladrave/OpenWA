import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DataSource, MoreThan, Repository } from 'typeorm';
import type { EntityManager } from 'typeorm';
import type { ApiKey } from '../auth/entities/api-key.entity';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { GroupService } from '../group/group.service';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { SessionService } from '../session/session.service';
import { chatKind } from '../../engine/identity/wa-id';
import { monitorError } from './monitoring.errors';
import { evaluateMonitorRule } from './monitoring.evaluator';
import type { MonitorEnvelope, MonitorRuleConfig } from './monitoring.types';
import {
  MONITOR_DIGEST_BATCH_MAX,
  MONITOR_PREVIEW_MESSAGES_MAX,
  MONITOR_RULES_PER_GROUP_MAX,
  MONITOR_RULES_PER_SESSION_MAX,
} from './monitoring.types';
import { MonitorCursor, MonitorGroup, MonitorMatch, MonitorProfile, MonitorRule } from './entities';
import { setMonitorDigestBacklog } from '../../common/metrics/monitoring-metrics';
import { MonitoringWorkerHealthService } from './monitoring-worker-health.service';

const secureEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const digestHex = (value: string): string => createHash('sha256').update(value).digest('hex');
const processBatchSecret = randomBytes(32);
const opaqueCursorId = (principalId: string, sessionId: string): string => {
  const hex = digestHex(`monitor-cursor-v1|${principalId}|${sessionId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const digestBatchToken = (cursor: string, version: number, matchIds: string[]): string =>
  createHmac('sha256', process.env.MCP_MONITOR_CURSOR_SECRET || process.env.API_KEY_PEPPER || processBatchSecret)
    .update(`monitor-batch-v1|${cursor}|${version}|${matchIds.join('|')}`)
    .digest('hex');

const asMedia = (metadata: Record<string, unknown>): Record<string, unknown> | null => {
  const media = metadata.media;
  if (!media || typeof media !== 'object') return null;
  const record = media as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['mimetype', 'filename', 'sizeBytes', 'omitted']) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return Object.keys(out).length ? out : null;
};

@Injectable()
export class MonitoringService {
  constructor(
    @InjectDataSource('data') private readonly dataSource: DataSource,
    @InjectRepository(MonitorProfile, 'data') private readonly profiles: Repository<MonitorProfile>,
    @InjectRepository(MonitorGroup, 'data') private readonly groups: Repository<MonitorGroup>,
    @InjectRepository(MonitorRule, 'data') private readonly rules: Repository<MonitorRule>,
    @InjectRepository(MonitorMatch, 'data') private readonly matches: Repository<MonitorMatch>,
    @InjectRepository(MonitorCursor, 'data') private readonly cursors: Repository<MonitorCursor>,
    @InjectRepository(Message, 'data') private readonly messages: Repository<Message>,
    private readonly groupService: GroupService,
    private readonly sessionService: SessionService,
    private readonly audit: AuditService,
    @Optional() private readonly workerHealth?: MonitoringWorkerHealthService,
  ) {}

  assertMonitoringScope(apiKey: ApiKey, sessionId: string): string {
    if (apiKey.allowedSessions?.includes(sessionId)) return apiKey.id;
    const unscopedAdminAllowed =
      apiKey.role === ApiKeyRole.ADMIN && process.env.MCP_MONITOR_ALLOW_UNSCOPED_ADMIN === 'true';
    if (unscopedAdminAllowed) return apiKey.id;
    throw monitorError(
      'AUTH_REQUIRED',
      HttpStatus.FORBIDDEN,
      'Monitoring requires an API key explicitly scoped to this session',
    );
  }

  async listAvailableGroups(
    apiKey: ApiKey,
    sessionId: string,
    options: { limit?: number; offset?: number },
  ): Promise<object[]> {
    const principalId = this.assertMonitoringScope(apiKey, sessionId);
    await this.sessionService.findOne(sessionId);
    const available = await this.groupService.getGroups(sessionId, options);
    const selected = await this.groups.find({ where: { principalId, sessionId } });
    const selectedByJid = new Map(selected.map(group => [group.groupJid, group]));
    const counts = await this.ruleCounts(principalId, sessionId);
    return available.map(group => ({
      sessionId,
      groupJid: group.id,
      name: group.name,
      ...(group.participantsCount != null ? { participantCount: group.participantsCount } : {}),
      currentlyMonitored: selectedByJid.get(group.id)?.enabled === true,
      ruleCount: counts.get(group.id) ?? 0,
    }));
  }

  async listGroups(apiKey: ApiKey, sessionId: string): Promise<object[]> {
    const principalId = this.assertMonitoringScope(apiKey, sessionId);
    const groups = await this.groups.find({ where: { principalId, sessionId, enabled: true }, order: { name: 'ASC' } });
    const counts = await this.ruleCounts(principalId, sessionId);
    return groups.map(group => ({
      sessionId,
      groupJid: group.groupJid,
      name: group.name,
      currentlyMonitored: true,
      ruleCount: counts.get(group.groupJid) ?? 0,
      updatedAt: group.updatedAt,
    }));
  }

  async setGroup(apiKey: ApiKey, sessionId: string, groupJid: string, expectedName?: string): Promise<object> {
    const principalId = this.assertMonitoringScope(apiKey, sessionId);
    if (chatKind(groupJid) !== 'group') {
      throw monitorError('GROUP_NOT_FOUND', HttpStatus.NOT_FOUND, 'The requested monitored group was not found');
    }
    const current = await this.groupService.getGroupInfo(sessionId, groupJid).catch(() => {
      throw monitorError('GROUP_NOT_FOUND', HttpStatus.NOT_FOUND, 'The requested monitored group was not found');
    });
    if (expectedName != null && current.name !== expectedName) {
      throw monitorError(
        'GROUP_RENAMED',
        HttpStatus.CONFLICT,
        `The group is now named ${JSON.stringify(current.name)}; confirm the current name before monitoring it`,
      );
    }
    const session = await this.sessionService.findOne(sessionId);
    const profile = await this.profiles.findOne({ where: { principalId, sessionId } });
    if (!profile) {
      await this.profiles.save(
        this.profiles.create({ principalId, sessionId, ownerJid: session.phone, enabled: true, retentionDays: 7 }),
      );
    } else if (!profile.ownerJid && session.phone) {
      await this.profiles.update(profile.id, { ownerJid: session.phone });
    }
    let group = await this.groups.findOne({ where: { principalId, sessionId, groupJid } });
    if (group) {
      await this.groups.update(group.id, {
        name: current.name,
        enabled: true,
        ...(group.enabled ? {} : { lastReconciledCreatedAt: new Date(), lastReconciledMessageRowId: null }),
      });
      group = (await this.groups.findOne({ where: { id: group.id } }))!;
    } else {
      group = await this.groups.save(
        this.groups.create({
          principalId,
          sessionId,
          groupJid,
          name: current.name,
          enabled: true,
          lastReconciledCreatedAt: new Date(),
          lastReconciledMessageRowId: null,
        }),
      );
    }
    await this.audit.logInfo(AuditAction.MONITOR_GROUP_SET, {
      apiKey,
      sessionId,
      metadata: { monitorGroupId: group.id },
    });
    return { sessionId, groupJid: group.groupJid, name: group.name, currentlyMonitored: true };
  }

  async removeGroup(apiKey: ApiKey, sessionId: string, groupJid: string): Promise<object> {
    const principalId = this.assertMonitoringScope(apiKey, sessionId);
    const group = await this.groups.findOne({ where: { principalId, sessionId, groupJid, enabled: true } });
    if (!group) throw monitorError('GROUP_NOT_MONITORED', HttpStatus.NOT_FOUND, 'The requested group is not monitored');
    await this.dataSource.transaction(async manager => {
      await manager.update(MonitorGroup, { id: group.id, principalId, sessionId }, { enabled: false });
      await manager
        .createQueryBuilder()
        .update(MonitorRule)
        .set({ enabled: false, version: () => '"version" + 1' })
        .where('"principalId" = :principalId AND "sessionId" = :sessionId AND "groupJid" = :groupJid', {
          principalId,
          sessionId,
          groupJid,
        })
        .execute();
    });
    await this.audit.logInfo(AuditAction.MONITOR_GROUP_REMOVED, {
      apiKey,
      sessionId,
      metadata: { monitorGroupId: group.id },
    });
    return { removed: true, historicalMatchesRetainedUntilExpiry: true };
  }

  async listRules(apiKey: ApiKey, sessionId: string, groupJid?: string): Promise<object[]> {
    const principalId = this.assertMonitoringScope(apiKey, sessionId);
    const where = groupJid ? { principalId, sessionId, groupJid } : { principalId, sessionId };
    const rules = await this.rules.find({ where, order: { updatedAt: 'DESC' } });
    return rules.map(rule => this.safeRule(rule));
  }

  async getRule(apiKey: ApiKey, sessionId: string, ruleId: string): Promise<object> {
    const principalId = this.assertMonitoringScope(apiKey, sessionId);
    return this.safeRule(await this.requireRule(principalId, sessionId, ruleId));
  }

  async upsertRule(
    apiKey: ApiKey,
    sessionId: string,
    groupJid: string,
    config: MonitorRuleConfig,
    options: { ruleId?: string; expectedVersion?: number },
  ): Promise<object> {
    const principalId = this.assertMonitoringScope(apiKey, sessionId);
    await this.requireMonitoredGroup(principalId, sessionId, groupJid);
    let saved: MonitorRule;
    if (options.ruleId) {
      const current = await this.requireRule(principalId, sessionId, options.ruleId);
      if (current.groupJid !== groupJid) {
        throw monitorError('RULE_NOT_FOUND', HttpStatus.NOT_FOUND, 'The requested monitoring rule was not found');
      }
      if (options.expectedVersion == null || options.expectedVersion !== current.version) {
        throw monitorError(
          'RULE_INVALID',
          HttpStatus.CONFLICT,
          'Rule version conflict; reload the rule before updating it',
        );
      }
      const result = await this.rules
        .createQueryBuilder()
        .update(MonitorRule)
        .set({
          ...config,
          activeHours: config.activeHours ?? null,
          quietHours: config.quietHours ?? null,
          retentionDays: config.retentionDays ?? null,
          version: () => '"version" + 1',
        })
        .where('"id" = :id AND "principalId" = :principalId AND "sessionId" = :sessionId AND "version" = :version', {
          id: current.id,
          principalId,
          sessionId,
          version: current.version,
        })
        .andWhere(
          'EXISTS (SELECT 1 FROM "monitor_groups" monitor_group WHERE monitor_group."principalId" = :principalId AND monitor_group."sessionId" = :sessionId AND monitor_group."groupJid" = :groupJid AND monitor_group."enabled" = :groupEnabled)',
          { groupJid, groupEnabled: true },
        )
        .execute();
      if (!result.affected) {
        throw monitorError(
          'RULE_INVALID',
          HttpStatus.CONFLICT,
          'Rule version conflict; reload the rule before updating it',
        );
      }
      saved = await this.requireRule(principalId, sessionId, current.id);
    } else {
      saved = await this.dataSource.transaction(async manager => {
        await this.lockMonitoredGroup(manager, principalId, sessionId, groupJid);
        const profileQuery = manager
          .getRepository(MonitorProfile)
          .createQueryBuilder('monitorProfile')
          .where('monitorProfile.principalId = :principalId AND monitorProfile.sessionId = :sessionId', {
            principalId,
            sessionId,
          });
        if (this.dataSource.options.type === 'postgres') profileQuery.setLock('pessimistic_write');
        if (!(await profileQuery.getOne())) {
          throw monitorError('GROUP_NOT_MONITORED', HttpStatus.NOT_FOUND, 'The requested group is not monitored');
        }
        const ruleRepository = manager.getRepository(MonitorRule);
        const sessionCount = await ruleRepository.count({ where: { principalId, sessionId } });
        const groupCount = await ruleRepository.count({ where: { principalId, sessionId, groupJid } });
        if (sessionCount >= MONITOR_RULES_PER_SESSION_MAX || groupCount >= MONITOR_RULES_PER_GROUP_MAX) {
          throw monitorError('RULE_LIMIT', HttpStatus.CONFLICT, 'Monitoring rule limit reached');
        }
        return ruleRepository.save(
          ruleRepository.create({
            principalId,
            sessionId,
            groupJid,
            ...config,
            activeHours: config.activeHours ?? null,
            quietHours: config.quietHours ?? null,
            retentionDays: config.retentionDays ?? null,
            version: 1,
          }),
        );
      });
    }
    await this.audit.logInfo(AuditAction.MONITOR_RULE_UPSERTED, {
      apiKey,
      sessionId,
      metadata: { ruleId: saved.id, version: saved.version },
    });
    return this.safeRule(saved);
  }

  async deleteRule(apiKey: ApiKey, sessionId: string, ruleId: string): Promise<object> {
    const principalId = this.assertMonitoringScope(apiKey, sessionId);
    const rule = await this.requireRule(principalId, sessionId, ruleId);
    await this.rules.remove(rule);
    await this.audit.logInfo(AuditAction.MONITOR_RULE_DELETED, { apiKey, sessionId, metadata: { ruleId } });
    return { deleted: true, historicalMatchesRetainedUntilExpiry: true };
  }

  async setRuleEnabled(
    apiKey: ApiKey,
    sessionId: string,
    ruleId: string,
    enabled: boolean,
    expectedVersion: number,
  ): Promise<object> {
    const principalId = this.assertMonitoringScope(apiKey, sessionId);
    const current = await this.requireRule(principalId, sessionId, ruleId);
    if (enabled) await this.requireMonitoredGroup(principalId, sessionId, current.groupJid);
    const result = await this.rules
      .createQueryBuilder()
      .update(MonitorRule)
      .set({ enabled, version: () => '"version" + 1' })
      .where('"id" = :ruleId AND "principalId" = :principalId AND "sessionId" = :sessionId AND "version" = :version', {
        ruleId,
        principalId,
        sessionId,
        version: expectedVersion,
      })
      .execute();
    if (!result.affected) throw monitorError('RULE_INVALID', HttpStatus.CONFLICT, 'Rule version conflict');
    const saved = await this.requireRule(principalId, sessionId, ruleId);
    await this.audit.logInfo(AuditAction.MONITOR_RULE_UPSERTED, {
      apiKey,
      sessionId,
      metadata: { ruleId, version: saved.version, enabled },
    });
    return this.safeRule(saved);
  }

  async previewRule(
    apiKey: ApiKey,
    sessionId: string,
    groupJid: string,
    options: { ruleId?: string; config?: MonitorRuleConfig; limit?: number },
  ): Promise<object> {
    const principalId = this.assertMonitoringScope(apiKey, sessionId);
    const group = await this.requireMonitoredGroup(principalId, sessionId, groupJid);
    let config = options.config;
    if (options.ruleId) {
      const savedRule = await this.requireRule(principalId, sessionId, options.ruleId);
      if (savedRule.groupJid !== groupJid) {
        throw monitorError('RULE_NOT_FOUND', HttpStatus.NOT_FOUND, 'The requested monitoring rule was not found');
      }
      config = this.entityConfig(savedRule);
    }
    if (!config) throw monitorError('RULE_INVALID', HttpStatus.BAD_REQUEST, 'Provide a saved ruleId or a rule config');
    const profile = await this.profiles.findOne({ where: { principalId, sessionId } });
    const session = await this.sessionService.findOne(sessionId);
    const rows = await this.messages.find({
      where: { sessionId, chatId: groupJid, direction: MessageDirection.INCOMING },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: Math.min(options.limit ?? 50, MONITOR_PREVIEW_MESSAGES_MAX),
    });
    const samples: object[] = [];
    let deterministicMatches = 0;
    let semanticCandidates = 0;
    for (const row of rows.reverse()) {
      const envelope = this.storedEnvelope(row);
      const evaluation = evaluateMonitorRule(config, envelope, profile?.ownerJid ?? session.phone);
      if (!evaluation.matched && !evaluation.candidate) continue;
      if (evaluation.matched) deterministicMatches += 1;
      if (evaluation.candidate) semanticCandidates += 1;
      if (samples.length < 20) {
        samples.push({
          messageId: row.waMessageId,
          groupName: group.name,
          sender: row.author ?? row.from,
          timestamp: row.timestamp,
          type: row.type,
          body: row.body?.slice(0, 500) ?? '',
          evidence: evaluation.evidence,
          semanticAssessmentRequired: evaluation.candidate,
        });
      }
    }
    return {
      source: 'persisted_recent_history',
      examined: rows.length,
      deterministicMatches,
      semanticCandidates,
      samples,
      warning: 'Preview is bounded and may miss older examples; semantic candidates require client assessment.',
    };
  }

  async getMatches(
    apiKey: ApiKey,
    sessionId: string,
    options: { state?: 'pending' | 'acknowledged'; limit?: number; offset?: number },
  ): Promise<object[]> {
    const principalId = this.assertMonitoringScope(apiKey, sessionId);
    const now = new Date();
    const matches = await this.matches.find({
      where: { principalId, sessionId, state: options.state ?? 'pending', expiresAt: MoreThan(now) },
      order: { createdAt: 'ASC', id: 'ASC' },
      take: Math.min(options.limit ?? 50, MONITOR_DIGEST_BATCH_MAX),
      skip: options.offset ?? 0,
    });
    return matches.map(match => this.safeMatch(match));
  }

  async getMatch(apiKey: ApiKey, sessionId: string, matchId: string): Promise<object> {
    const principalId = this.assertMonitoringScope(apiKey, sessionId);
    const match = await this.matches.findOne({
      where: { id: matchId, principalId, sessionId, expiresAt: MoreThan(new Date()) },
    });
    if (!match)
      throw monitorError('RULE_NOT_FOUND', HttpStatus.NOT_FOUND, 'The requested monitoring match was not found');
    return this.safeMatch(match);
  }

  async getDigestBatch(
    apiKey: ApiKey,
    sessionId: string,
    options: { cursor?: string; limit?: number },
  ): Promise<object> {
    const principalId = this.assertMonitoringScope(apiKey, sessionId);
    const limit = Math.min(options.limit ?? 25, MONITOR_DIGEST_BATCH_MAX);
    const cursorId = opaqueCursorId(principalId, sessionId);
    if (options.cursor && options.cursor !== cursorId) {
      throw monitorError('CURSOR_NOT_FOUND', HttpStatus.NOT_FOUND, 'The digest cursor was not found');
    }
    const cursor = await this.cursors.findOne({ where: { id: cursorId, principalId, sessionId } });
    const version = cursor?.version ?? 0;
    const matches = await this.matches.find({
      where: { principalId, sessionId, state: 'pending', expiresAt: MoreThan(new Date()) },
      order: { createdAt: 'ASC', id: 'ASC' },
      take: limit,
    });
    const matchIds = matches.map(match => match.id);
    return {
      cursor: cursorId,
      cursorVersion: version,
      batchToken: matchIds.length ? digestBatchToken(cursorId, version, matchIds) : null,
      matches: matches.map(match => this.safeMatch(match)),
    };
  }

  async acknowledgeMatches(
    apiKey: ApiKey,
    sessionId: string,
    input: { cursor: string; cursorVersion: number; batchToken: string; matchIds: string[] },
  ): Promise<object> {
    const principalId = this.assertMonitoringScope(apiKey, sessionId);
    const result = await this.dataSource.transaction(async manager => {
      const cursorRepo = manager.getRepository(MonitorCursor);
      const matchRepo = manager.getRepository(MonitorMatch);
      const expectedCursor = opaqueCursorId(principalId, sessionId);
      if (input.cursor !== expectedCursor || input.matchIds.length === 0) {
        throw monitorError('CURSOR_CONFLICT', HttpStatus.CONFLICT, 'The digest batch does not match the cursor state');
      }
      const cursor = await cursorRepo.findOne({ where: { id: input.cursor, principalId, sessionId } });
      const currentVersion = cursor?.version ?? 0;
      const expectedToken = digestBatchToken(input.cursor, currentVersion, input.matchIds);
      if (currentVersion !== input.cursorVersion || !secureEqual(expectedToken, input.batchToken)) {
        throw monitorError('CURSOR_CONFLICT', HttpStatus.CONFLICT, 'The digest batch does not match the cursor state');
      }
      const now = new Date();
      const acknowledged = await matchRepo
        .createQueryBuilder()
        .update(MonitorMatch)
        .set({ state: 'acknowledged', acknowledgedAt: now })
        .where('"principalId" = :principalId AND "sessionId" = :sessionId AND "state" = :state', {
          principalId,
          sessionId,
          state: 'pending',
        })
        .andWhere({ expiresAt: MoreThan(now) })
        .andWhereInIds(input.matchIds)
        .execute();
      if ((acknowledged.affected ?? 0) !== input.matchIds.length) {
        throw monitorError(
          'CURSOR_CONFLICT',
          HttpStatus.CONFLICT,
          'One or more digest matches changed before acknowledgment',
        );
      }
      if (!cursor) {
        try {
          await cursorRepo.insert({
            id: input.cursor,
            principalId,
            sessionId,
            name: 'default',
            version: 1,
            lastAcknowledgedMatchId: input.matchIds[input.matchIds.length - 1],
          });
        } catch {
          throw monitorError('CURSOR_CONFLICT', HttpStatus.CONFLICT, 'The digest cursor changed concurrently');
        }
      } else {
        const advanced = await cursorRepo
          .createQueryBuilder()
          .update(MonitorCursor)
          .set({
            lastAcknowledgedMatchId: input.matchIds[input.matchIds.length - 1],
            version: () => '"version" + 1',
          })
          .where('"id" = :id AND "principalId" = :principalId AND "sessionId" = :sessionId AND "version" = :version', {
            id: cursor.id,
            principalId,
            sessionId,
            version: cursor.version,
          })
          .execute();
        if (!advanced.affected)
          throw monitorError('CURSOR_CONFLICT', HttpStatus.CONFLICT, 'The digest cursor changed concurrently');
      }
      return { acknowledged: input.matchIds.length, cursor: input.cursor, cursorVersion: currentVersion + 1 };
    });
    await this.audit.logInfo(AuditAction.MONITOR_MATCHES_ACKNOWLEDGED, {
      apiKey,
      sessionId,
      metadata: { count: result.acknowledged, cursor: result.cursor },
    });
    const [pending, oldest] = await Promise.all([
      this.matches.count({ where: { state: 'pending' } }),
      this.matches.findOne({ where: { state: 'pending' }, order: { createdAt: 'ASC' } }),
    ]);
    setMonitorDigestBacklog(pending, oldest?.createdAt ?? null);
    return result;
  }

  async getHealth(apiKey: ApiKey, sessionId: string): Promise<object> {
    const principalId = this.assertMonitoringScope(apiKey, sessionId);
    const session = await this.sessionService.findOne(sessionId);
    const [groups, rules, pending, oldest] = await Promise.all([
      this.groups.count({ where: { principalId, sessionId, enabled: true } }),
      this.rules.count({ where: { principalId, sessionId, enabled: true } }),
      this.matches.count({ where: { principalId, sessionId, state: 'pending' } }),
      this.matches.findOne({ where: { principalId, sessionId, state: 'pending' }, order: { createdAt: 'ASC' } }),
    ]);
    setMonitorDigestBacklog(pending, oldest?.createdAt ?? null);
    return {
      sessionState: session.status,
      monitoredGroups: groups,
      enabledRules: rules,
      pendingMatches: pending,
      oldestPendingAt: oldest?.createdAt ?? null,
      semanticStage: 'client',
      pollingRequired: true,
      backgroundWorkers: this.workerHealth?.snapshot() ?? { status: 'unknown', workers: {} },
    };
  }

  private async ruleCounts(principalId: string, sessionId: string): Promise<Map<string, number>> {
    const rows = await this.rules
      .createQueryBuilder('rule')
      .select('rule.groupJid', 'groupJid')
      .addSelect('COUNT(*)', 'count')
      .where('rule.principalId = :principalId AND rule.sessionId = :sessionId', { principalId, sessionId })
      .groupBy('rule.groupJid')
      .getRawMany<{ groupJid: string; count: string }>();
    return new Map(rows.map(row => [row.groupJid, Number(row.count)]));
  }

  private requireMonitoredGroup(principalId: string, sessionId: string, groupJid: string): Promise<MonitorGroup> {
    return this.groups.findOne({ where: { principalId, sessionId, groupJid, enabled: true } }).then(group => {
      if (!group)
        throw monitorError('GROUP_NOT_MONITORED', HttpStatus.NOT_FOUND, 'The requested group is not monitored');
      return group;
    });
  }

  private requireRule(principalId: string, sessionId: string, ruleId: string): Promise<MonitorRule> {
    return this.rules.findOne({ where: { id: ruleId, principalId, sessionId } }).then(rule => {
      if (!rule)
        throw monitorError('RULE_NOT_FOUND', HttpStatus.NOT_FOUND, 'The requested monitoring rule was not found');
      return rule;
    });
  }

  private async lockMonitoredGroup(
    manager: EntityManager,
    principalId: string,
    sessionId: string,
    groupJid: string,
  ): Promise<MonitorGroup> {
    const query = manager
      .getRepository(MonitorGroup)
      .createQueryBuilder('monitorGroup')
      .where(
        'monitorGroup.principalId = :principalId AND monitorGroup.sessionId = :sessionId AND monitorGroup.groupJid = :groupJid AND monitorGroup.enabled = :enabled',
        { principalId, sessionId, groupJid, enabled: true },
      );
    if (this.dataSource.options.type === 'postgres') query.setLock('pessimistic_read');
    const group = await query.getOne();
    if (!group) throw monitorError('GROUP_NOT_MONITORED', HttpStatus.NOT_FOUND, 'The requested group is not monitored');
    return group;
  }

  private entityConfig(rule: MonitorRule): MonitorRuleConfig {
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

  private safeRule(rule: MonitorRule): object {
    return {
      id: rule.id,
      sessionId: rule.sessionId,
      groupJid: rule.groupJid,
      ...this.entityConfig(rule),
      version: rule.version,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    };
  }

  private safeMatch(match: MonitorMatch): object {
    return {
      id: match.id,
      sessionId: match.sessionId,
      groupJid: match.groupJid,
      groupName: match.groupName,
      ruleId: match.ruleId,
      ruleVersion: match.ruleVersion,
      matchMode: match.matchMode,
      messageId: match.messageId,
      sender: { jid: match.senderJid, ...(match.senderLabel ? { label: match.senderLabel } : {}) },
      timestamp: match.messageTimestamp,
      type: match.messageType,
      body: match.body ?? '',
      media: match.media,
      evidence: match.evidence,
      semanticConditions: match.semanticConditions,
      urgency: match.urgency,
      priority: match.priority,
      tags: match.tags,
      state: match.state,
      untrustedContent: true,
    };
  }

  private storedEnvelope(row: Message): MonitorEnvelope {
    const metadata = row.metadata ?? {};
    const mentionedJids = Array.isArray(metadata.mentionedIds)
      ? metadata.mentionedIds.filter((value): value is string => typeof value === 'string').slice(0, 50)
      : [];
    const media = asMedia(metadata);
    return {
      sessionId: row.sessionId,
      groupJid: row.chatId,
      messageId: row.waMessageId,
      senderJid: row.author ?? row.from,
      senderLabel: row.chatName,
      timestamp: row.timestamp,
      type: row.type,
      body: row.body ?? '',
      mentionedJids,
      hasMedia: Boolean(media),
      isReply: metadata.quotedMessage != null,
      fromMe: row.direction === MessageDirection.OUTGOING,
      revoked: row.type === 'revoked',
    };
  }
}
