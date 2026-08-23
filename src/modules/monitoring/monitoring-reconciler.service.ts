import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { Message } from '../message/entities/message.entity';
import { MonitorGroup, MonitorMatch } from './entities';
import { MonitoringIngestService } from './monitoring-ingest.service';
import { setMonitorDigestBacklog } from '../../common/metrics/monitoring-metrics';
import { MonitoringWorkerHealthService } from './monitoring-worker-health.service';

const RECONCILE_INTERVAL_MS = 5 * 60_000;
const RECONCILE_PAGE_SIZE = 100;
const RECONCILE_PAGES_PER_GROUP_MAX = 10;

@Injectable()
export class MonitoringReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('MonitoringReconcilerService');
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    @InjectRepository(MonitorGroup, 'data') private readonly groups: Repository<MonitorGroup>,
    @InjectRepository(Message, 'data') private readonly messages: Repository<Message>,
    @InjectRepository(MonitorMatch, 'data') private readonly matches: Repository<MonitorMatch>,
    private readonly ingest: MonitoringIngestService,
    @Optional() private readonly workerHealth?: MonitoringWorkerHealthService,
  ) {}

  onModuleInit(): void {
    const run = (): void =>
      void this.reconcile().catch(error =>
        this.logger.warn('Monitoring reconciliation failed', {
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    run();
    this.timer = setInterval(run, RECONCILE_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.workerHealth?.start('reconciler');
    try {
      const selected = await this.groups.find({ where: { enabled: true } });
      for (const group of selected) {
        let checkpointAt = group.lastReconciledCreatedAt ?? group.createdAt;
        let checkpointId = group.lastReconciledMessageRowId ?? '';
        for (let page = 0; page < RECONCILE_PAGES_PER_GROUP_MAX; page += 1) {
          const messages = await this.messages
            .createQueryBuilder('message')
            .where('message.sessionId = :sessionId AND message.chatId = :groupJid', {
              sessionId: group.sessionId,
              groupJid: group.groupJid,
            })
            .andWhere(
              '(message.createdAt > :checkpointAt OR (message.createdAt = :checkpointAt AND message.id > :checkpointId))',
              { checkpointAt, checkpointId },
            )
            .orderBy('message.createdAt', 'ASC')
            .addOrderBy('message.id', 'ASC')
            .take(RECONCILE_PAGE_SIZE)
            .getMany();
          if (!messages.length) break;
          for (const message of messages) {
            await this.ingest.ingestStored(message);
            checkpointAt = message.createdAt;
            checkpointId = message.id;
          }
          await this.groups.update(
            { id: group.id, enabled: true },
            { lastReconciledCreatedAt: checkpointAt, lastReconciledMessageRowId: checkpointId },
          );
          if (messages.length < RECONCILE_PAGE_SIZE) break;
        }
      }
      const [pending, oldest] = await Promise.all([
        this.matches.count({ where: { state: 'pending' } }),
        this.matches.findOne({ where: { state: 'pending' }, order: { createdAt: 'ASC' } }),
      ]);
      setMonitorDigestBacklog(pending, oldest?.createdAt ?? null);
      this.workerHealth?.success('reconciler');
    } catch (error) {
      this.workerHealth?.failure('reconciler');
      throw error;
    } finally {
      this.running = false;
    }
  }
}
