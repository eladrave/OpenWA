import { DataSource } from 'typeorm';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { Message } from '../message/entities/message.entity';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { MonitorAuthFlow, MonitorCursor, MonitorGroup, MonitorMatch, MonitorProfile, MonitorRule } from './entities';
import { MonitoringService } from './monitoring.service';

describe('MonitoringService cursor and isolation', () => {
  let dataSource: DataSource;
  let service: MonitoringService;
  const sessionId = '11111111-1111-4111-a111-111111111111';
  const key = {
    id: 'principal-1',
    name: 'monitor',
    role: ApiKeyRole.OPERATOR,
    allowedSessions: [sessionId],
  } as ApiKey;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [
        Session,
        Message,
        MonitorProfile,
        MonitorGroup,
        MonitorRule,
        MonitorMatch,
        MonitorCursor,
        MonitorAuthFlow,
      ],
    });
    await dataSource.initialize();
    await dataSource.getRepository(Session).save({
      id: sessionId,
      name: 'monitoring-service-test',
      status: SessionStatus.CREATED,
      phone: null,
      pushName: null,
      config: {},
      proxyUrl: null,
      proxyType: null,
      connectedAt: null,
      lastActiveAt: null,
      nodeId: null,
      claimedAt: null,
      nodeUrl: null,
      leaseExpiresAt: null,
    });
    service = new MonitoringService(
      dataSource,
      dataSource.getRepository(MonitorProfile),
      dataSource.getRepository(MonitorGroup),
      dataSource.getRepository(MonitorRule),
      dataSource.getRepository(MonitorMatch),
      dataSource.getRepository(MonitorCursor),
      dataSource.getRepository(Message),
      {} as never,
      { findOne: jest.fn().mockResolvedValue({ status: 'ready' }) } as never,
      { logInfo: jest.fn().mockResolvedValue(null) } as never,
    );
    await dataSource.getRepository(MonitorMatch).save({
      principalId: key.id,
      sessionId,
      groupJid: '120363000@g.us',
      groupName: 'Test Group',
      ruleId: '22222222-2222-4222-a222-222222222222',
      ruleVersion: 1,
      matchMode: 'all',
      messageId: 'wa-1',
      senderJid: '15550001111@c.us',
      senderLabel: null,
      messageTimestamp: 1_777_000_000,
      messageType: 'text',
      body: 'untrusted body',
      media: null,
      evidence: ['keyword "outage" matched body'],
      semanticConditions: [],
      urgency: { level: 'none', score: 0, reasons: [], requiresResponse: false, confidence: 0.5 },
      priority: 'normal',
      tags: [],
      state: 'pending',
      acknowledgedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
  });

  afterEach(async () => dataSource.destroy());

  it('keeps digest reads pure and advances the cursor only after exact acknowledgment', async () => {
    const batch = (await service.getDigestBatch(key, sessionId, {})) as {
      cursor: string;
      cursorVersion: number;
      batchToken: string;
      matches: Array<{ id: string }>;
    };
    expect(batch.cursorVersion).toBe(0);
    expect(batch.matches).toHaveLength(1);
    expect(await dataSource.getRepository(MonitorCursor).count()).toBe(0);

    const acknowledged = await service.acknowledgeMatches(key, sessionId, {
      cursor: batch.cursor,
      cursorVersion: batch.cursorVersion,
      batchToken: batch.batchToken,
      matchIds: batch.matches.map(match => match.id),
    });
    expect(acknowledged).toMatchObject({ acknowledged: 1, cursorVersion: 1 });
    expect(await dataSource.getRepository(MonitorCursor).count()).toBe(1);
    expect(((await service.getDigestBatch(key, sessionId, {})) as { matches: unknown[] }).matches).toEqual([]);
  });

  it('rejects stale or tampered batches without advancing state', async () => {
    const batch = (await service.getDigestBatch(key, sessionId, {})) as {
      cursor: string;
      cursorVersion: number;
      batchToken: string;
      matches: Array<{ id: string }>;
    };
    await expect(
      service.acknowledgeMatches(key, sessionId, {
        cursor: batch.cursor,
        cursorVersion: batch.cursorVersion,
        batchToken: '0'.repeat(64),
        matchIds: batch.matches.map(match => match.id),
      }),
    ).rejects.toThrow(/digest batch does not match/i);
    expect(await dataSource.getRepository(MonitorCursor).count()).toBe(0);
    expect(await dataSource.getRepository(MonitorMatch).countBy({ state: 'pending' })).toBe(1);
  });

  it('never serves or acknowledges logically expired matches before physical cleanup runs', async () => {
    const matchRepository = dataSource.getRepository(MonitorMatch);
    const expired = await matchRepository.save({
      ...(await matchRepository.findOneByOrFail({ messageId: 'wa-1' })),
      id: '33333333-3333-4333-a333-333333333333',
      messageId: 'wa-expired',
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await service.getMatches(key, sessionId, {})).toHaveLength(1);
    await expect(service.getMatch(key, sessionId, expired.id)).rejects.toThrow(/match was not found/i);

    const batch = (await service.getDigestBatch(key, sessionId, {})) as {
      cursor: string;
      cursorVersion: number;
      batchToken: string;
      matches: Array<{ id: string }>;
    };
    expect(batch.matches).toHaveLength(1);
    await matchRepository.update(batch.matches[0].id, { expiresAt: new Date(Date.now() - 1) });
    await expect(
      service.acknowledgeMatches(key, sessionId, {
        cursor: batch.cursor,
        cursorVersion: batch.cursorVersion,
        batchToken: batch.batchToken,
        matchIds: [batch.matches[0].id],
      }),
    ).rejects.toThrow(/changed before acknowledgment/i);
  });

  it('requires an explicit session grant even for an operator key', () => {
    const unscoped = { ...key, id: 'principal-2', allowedSessions: null } as ApiKey;
    expect(() => service.assertMonitoringScope(unscoped, sessionId)).toThrow(/explicitly scoped/i);
  });

  it('refuses to preview a saved rule against a different monitored group', async () => {
    await dataSource.getRepository(MonitorGroup).save({
      principalId: key.id,
      sessionId,
      groupJid: 'group-b@g.us',
      name: 'Group B',
      enabled: true,
      lastReconciledCreatedAt: new Date(),
      lastReconciledMessageRowId: null,
    });
    const savedRule = await dataSource.getRepository(MonitorRule).save({
      principalId: key.id,
      sessionId,
      groupJid: 'group-a@g.us',
      name: 'Group A rule',
      enabled: true,
      matchMode: 'all',
      conditions: [{ type: 'keyword', values: ['outage'] }],
      exclusions: [],
      priority: 'normal',
      tags: [],
      timezone: 'UTC',
      activeHours: null,
      quietHours: null,
      retentionDays: null,
      version: 1,
    });
    await expect(service.previewRule(key, sessionId, 'group-b@g.us', { ruleId: savedRule.id })).rejects.toThrow(
      /rule was not found/i,
    );
  });

  it('versions disabled rules on group removal and cannot re-enable them while the group is removed', async () => {
    const group = await dataSource.getRepository(MonitorGroup).save({
      principalId: key.id,
      sessionId,
      groupJid: 'group-remove@g.us',
      name: 'Removed Group',
      enabled: true,
      lastReconciledCreatedAt: new Date(),
      lastReconciledMessageRowId: null,
    });
    const rule = await dataSource.getRepository(MonitorRule).save({
      principalId: key.id,
      sessionId,
      groupJid: group.groupJid,
      name: 'stale rule',
      enabled: true,
      matchMode: 'all',
      conditions: [{ type: 'keyword', values: ['outage'] }],
      exclusions: [],
      priority: 'normal',
      tags: [],
      timezone: 'UTC',
      activeHours: null,
      quietHours: null,
      retentionDays: null,
      version: 1,
    });
    await service.removeGroup(key, sessionId, group.groupJid);
    expect(await dataSource.getRepository(MonitorRule).findOneByOrFail({ id: rule.id })).toMatchObject({
      enabled: false,
      version: 2,
    });
    await expect(service.setRuleEnabled(key, sessionId, rule.id, true, 1)).rejects.toThrow(/not monitored/i);
  });
});
