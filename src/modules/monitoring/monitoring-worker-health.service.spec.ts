import { MonitoringWorkerHealthService } from './monitoring-worker-health.service';

describe('MonitoringWorkerHealthService', () => {
  it('surfaces a worker failure until a later successful run clears degradation', () => {
    const service = new MonitoringWorkerHealthService();
    service.start('reconciler');
    service.failure('reconciler');
    expect(service.isDegraded()).toBe(true);
    expect(service.snapshot()).toMatchObject({
      status: 'degraded',
      workers: { reconciler: { running: false, consecutiveFailures: 1 } },
    });

    service.start('reconciler');
    service.success('reconciler');
    expect(service.isDegraded()).toBe(false);
    expect(service.snapshot()).toMatchObject({
      status: 'ok',
      workers: { reconciler: { running: false, consecutiveFailures: 0 } },
    });
  });
});
