import { EnrollmentChallengeBroker } from './enrollment-challenge-broker.service';

describe('EnrollmentChallengeBroker', () => {
  it('binds one flow per session and keeps challenges memory-only', () => {
    const broker = new EnrollmentChallengeBroker();
    broker.bind('s1', { flowId: 'f1', principalId: 'p1', mode: 'qr', expiresAt: Date.now() + 1000 });
    expect(broker.captureQr('s1', 'data:image/png;base64,abc')).toBe(true);
    expect(broker.getQr('s1', 'f1')).toBe('data:image/png;base64,abc');
    expect(() =>
      broker.bind('s1', { flowId: 'f2', principalId: 'p2', mode: 'qr', expiresAt: Date.now() + 1000 }),
    ).toThrow(/different managed enrollment flow/i);
    broker.clear('s1', 'f1');
    expect(broker.isManaged('s1')).toBe(false);
  });

  it('expires and drops a challenge without persistence', () => {
    const broker = new EnrollmentChallengeBroker();
    broker.bind('s1', { flowId: 'f1', principalId: 'p1', mode: 'pairing_code', expiresAt: Date.now() - 1 });
    expect(broker.get('s1')).toBeUndefined();
    expect(broker.isManaged('s1')).toBe(true);
    expect(broker.captureQr('s1', 'data:image/png;base64,expired-secret')).toBe(true);
    expect(broker.getQr('s1', 'f1')).toBeUndefined();
  });
});
