import type { Repository, UpdateResult } from 'typeorm';
import type { Message } from '../message/entities/message.entity';
import type { MonitorGroup, MonitorMatch } from './entities';
import type { MonitoringIngestService } from './monitoring-ingest.service';
import { MonitoringReconcilerService } from './monitoring-reconciler.service';

describe('MonitoringReconcilerService', () => {
  it('persists a per-group checkpoint and resumes beyond the 1,000-row run cap without gaps or duplicates', async () => {
    const baseline = new Date('2026-08-23T00:00:00.000Z');
    const messageTime = new Date('2026-08-23T00:01:00.000Z');
    const group = {
      id: 'group-row-1',
      principalId: 'principal-1',
      sessionId: 'session-1',
      groupJid: 'group@g.us',
      name: 'Important group',
      enabled: true,
      lastReconciledCreatedAt: baseline,
      lastReconciledMessageRowId: null,
      createdAt: baseline,
    } as MonitorGroup;
    const messages = Array.from({ length: 1_005 }, (_, index) => ({
      id: `message-${String(index + 1).padStart(4, '0')}`,
      sessionId: group.sessionId,
      chatId: group.groupJid,
      createdAt: messageTime,
    })) as Message[];

    let checkpointAt = group.lastReconciledCreatedAt as Date;
    let checkpointId = '';
    interface QueryBuilderHarness {
      where: () => QueryBuilderHarness;
      andWhere: (sql: string, values: { checkpointAt: Date; checkpointId: string }) => QueryBuilderHarness;
      orderBy: () => QueryBuilderHarness;
      addOrderBy: () => QueryBuilderHarness;
      take: () => QueryBuilderHarness;
      getMany: () => Promise<Message[]>;
    }
    const queryBuilder: QueryBuilderHarness = {
      where: () => queryBuilder,
      andWhere: (_sql: string, values: { checkpointAt: Date; checkpointId: string }) => {
        checkpointAt = values.checkpointAt;
        checkpointId = values.checkpointId;
        return queryBuilder;
      },
      orderBy: () => queryBuilder,
      addOrderBy: () => queryBuilder,
      take: () => queryBuilder,
      getMany: () =>
        Promise.resolve(
          messages
            .filter(
              message =>
                message.createdAt > checkpointAt ||
                (message.createdAt.getTime() === checkpointAt.getTime() && message.id > checkpointId),
            )
            .slice(0, 100),
        ),
    };
    const groups = {
      find: jest.fn(() => Promise.resolve([{ ...group }])),
      update: jest.fn(
        (
          _criteria: { id: string; enabled: boolean },
          patch: Pick<MonitorGroup, 'lastReconciledCreatedAt' | 'lastReconciledMessageRowId'>,
        ) => {
          group.lastReconciledCreatedAt = patch.lastReconciledCreatedAt;
          group.lastReconciledMessageRowId = patch.lastReconciledMessageRowId;
          return Promise.resolve({ affected: 1 } as UpdateResult);
        },
      ),
    };
    const messageRepository = { createQueryBuilder: jest.fn(() => queryBuilder) };
    const matches = {
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
    };
    const processed: string[] = [];
    const ingest = {
      ingestStored: jest.fn((message: Message) => {
        processed.push(message.id);
        return Promise.resolve();
      }),
    };
    const reconciler = new MonitoringReconcilerService(
      groups as unknown as Repository<MonitorGroup>,
      messageRepository as unknown as Repository<Message>,
      matches as unknown as Repository<MonitorMatch>,
      ingest as unknown as MonitoringIngestService,
    );

    await reconciler.reconcile();
    expect(processed).toHaveLength(1_000);
    expect(group.lastReconciledMessageRowId).toBe('message-1000');
    expect(groups.update).toHaveBeenCalledTimes(10);

    await reconciler.reconcile();
    expect(processed).toHaveLength(1_005);
    expect(new Set(processed).size).toBe(1_005);
    expect(processed).toEqual(messages.map(message => message.id));
    expect(group.lastReconciledMessageRowId).toBe('message-1005');
    expect(groups.update).toHaveBeenCalledTimes(11);
  });
});
