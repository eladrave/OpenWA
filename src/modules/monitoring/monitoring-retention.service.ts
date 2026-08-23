import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { MonitorMatch } from './entities';
import { recordMonitorRetentionDeletion, setMonitorDigestBacklog } from '../../common/metrics/monitoring-metrics';
import { MonitoringWorkerHealthService } from './monitoring-worker-health.service';

@Injectable()
export class MonitoringRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('MonitoringRetentionService');
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    @InjectRepository(MonitorMatch, 'data') private readonly matches: Repository<MonitorMatch>,
    @Optional() private readonly workerHealth?: MonitoringWorkerHealthService,
  ) {}

  onModuleInit(): void {
    const run = (): void =>
      void this.cleanup().catch(error =>
        this.logger.warn('Monitoring retention cleanup failed', {
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    run();
    this.timer = setInterval(run, 60 * 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async cleanup(now = new Date()): Promise<{ matches: number }> {
    this.workerHealth?.start('retention');
    try {
      const expiredMatches = await this.matches.delete({ expiresAt: LessThan(now) });
      recordMonitorRetentionDeletion(expiredMatches.affected ?? 0);
      const [pending, oldest] = await Promise.all([
        this.matches.count({ where: { state: 'pending' } }),
        this.matches.findOne({ where: { state: 'pending' }, order: { createdAt: 'ASC' } }),
      ]);
      setMonitorDigestBacklog(pending, oldest?.createdAt ?? null);
      this.workerHealth?.success('retention');
      return { matches: expiredMatches.affected ?? 0 };
    } catch (error) {
      this.workerHealth?.failure('retention');
      throw error;
    }
  }
}
