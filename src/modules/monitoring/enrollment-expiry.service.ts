import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Not, IsNull, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { EnrollmentChallengeBroker } from '../session/enrollment-challenge-broker.service';
import { SessionStatus } from '../session/entities/session.entity';
import { SessionService } from '../session/session.service';
import { MonitorAuthFlow } from './entities';
import { MonitoringWorkerHealthService } from './monitoring-worker-health.service';

@Injectable()
export class EnrollmentExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('EnrollmentExpiryService');
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    @InjectRepository(MonitorAuthFlow, 'data') private readonly flows: Repository<MonitorAuthFlow>,
    private readonly sessions: SessionService,
    private readonly broker: EnrollmentChallengeBroker,
    @Optional() private readonly workerHealth?: MonitoringWorkerHealthService,
  ) {}

  onModuleInit(): void {
    const run = (): void =>
      void this.expireDue().catch(error =>
        this.logger.warn('Enrollment expiry cleanup failed', {
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    run();
    this.timer = setInterval(run, 30_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async expireDue(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    this.workerHealth?.start('enrollmentExpiry');
    try {
      const due = await this.flows.find({ where: { expiresAt: LessThan(now), activeKey: Not(IsNull()) } });
      let expired = 0;
      for (const flow of due) {
        if (!flow.activeKey) continue;
        const session = await this.sessions.findOne(flow.sessionId).catch(() => null);
        if (session && session.status !== SessionStatus.READY && this.sessions.isActive(flow.sessionId)) {
          await this.sessions.stop(flow.sessionId).catch(() => undefined);
        }
        this.broker.clear(flow.sessionId, flow.id);
        const result = await this.flows.update(
          { id: flow.id, activeKey: flow.activeKey },
          { state: 'expired', activeKey: null, completedAt: now },
        );
        expired += result.affected ?? 0;
      }
      await this.flows.delete({
        activeKey: IsNull(),
        completedAt: LessThan(new Date(now.getTime() - 30 * 86_400_000)),
      });
      this.workerHealth?.success('enrollmentExpiry');
      return expired;
    } catch (error) {
      this.workerHealth?.failure('enrollmentExpiry');
      throw error;
    } finally {
      this.running = false;
    }
  }
}
