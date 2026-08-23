import { Injectable } from '@nestjs/common';

export type MonitoringWorkerName = 'reconciler' | 'retention' | 'enrollmentExpiry';

interface WorkerState {
  running: boolean;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  consecutiveFailures: number;
}

@Injectable()
export class MonitoringWorkerHealthService {
  private readonly workers: Record<MonitoringWorkerName, WorkerState> = {
    reconciler: this.initialState(),
    retention: this.initialState(),
    enrollmentExpiry: this.initialState(),
  };

  start(name: MonitoringWorkerName): void {
    const state = this.workers[name];
    state.running = true;
    state.lastRunAt = new Date();
  }

  success(name: MonitoringWorkerName): void {
    const state = this.workers[name];
    state.running = false;
    state.lastSuccessAt = new Date();
    state.consecutiveFailures = 0;
  }

  failure(name: MonitoringWorkerName): void {
    const state = this.workers[name];
    state.running = false;
    state.lastFailureAt = new Date();
    state.consecutiveFailures += 1;
  }

  isDegraded(): boolean {
    return Object.values(this.workers).some(state => state.consecutiveFailures > 0);
  }

  snapshot(): object {
    return {
      status: this.isDegraded() ? 'degraded' : 'ok',
      workers: Object.fromEntries(
        Object.entries(this.workers).map(([name, state]) => [
          name,
          {
            running: state.running,
            lastRunAt: state.lastRunAt,
            lastSuccessAt: state.lastSuccessAt,
            lastFailureAt: state.lastFailureAt,
            consecutiveFailures: state.consecutiveFailures,
          },
        ]),
      ),
    };
  }

  private initialState(): WorkerState {
    return {
      running: false,
      lastRunAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
    };
  }
}
