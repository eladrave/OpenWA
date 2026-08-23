import { DataSource } from 'typeorm';
import { EnrollmentChallengeBroker } from '../session/enrollment-challenge-broker.service';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { MonitorAuthFlow } from './entities';
import { EnrollmentExpiryService } from './enrollment-expiry.service';

describe('EnrollmentExpiryService', () => {
  it('stops an unpaired engine before releasing an expired challenge binding', async () => {
    const sessionId = '11111111-1111-4111-a111-111111111111';
    const dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [Session, MonitorAuthFlow],
    });
    await dataSource.initialize();
    try {
      await dataSource.getRepository(Session).save({
        id: sessionId,
        name: 'expiry-test',
        status: SessionStatus.QR_READY,
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
      const flow = await dataSource.getRepository(MonitorAuthFlow).save({
        principalId: 'principal-1',
        sessionId,
        activeKey: `session:${sessionId}`,
        mode: 'qr',
        state: 'waiting_for_scan',
        expiresAt: new Date(Date.now() - 1000),
        challengeIssuedAt: null,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
      });
      const oldTerminal = await dataSource.getRepository(MonitorAuthFlow).save({
        principalId: 'principal-1',
        sessionId,
        activeKey: null,
        mode: 'qr',
        state: 'cancelled',
        expiresAt: new Date(Date.now() - 32 * 86_400_000),
        challengeIssuedAt: null,
        completedAt: new Date(Date.now() - 31 * 86_400_000),
        errorCode: null,
        errorMessage: null,
      });
      const broker = new EnrollmentChallengeBroker();
      broker.bind(sessionId, {
        flowId: flow.id,
        principalId: flow.principalId,
        mode: 'qr',
        expiresAt: flow.expiresAt.getTime(),
      });
      const stop = jest.fn().mockResolvedValue(undefined);
      const service = new EnrollmentExpiryService(
        dataSource.getRepository(MonitorAuthFlow),
        {
          findOne: jest.fn().mockResolvedValue({ status: SessionStatus.QR_READY }),
          isActive: jest.fn().mockReturnValue(true),
          stop,
        } as never,
        broker,
      );

      expect(await service.expireDue()).toBe(1);
      expect(stop).toHaveBeenCalledWith(sessionId);
      expect(broker.isManaged(sessionId)).toBe(false);
      expect(await dataSource.getRepository(MonitorAuthFlow).findOneByOrFail({ id: flow.id })).toMatchObject({
        state: 'expired',
        activeKey: null,
      });
      expect(await dataSource.getRepository(MonitorAuthFlow).findOneBy({ id: oldTerminal.id })).toBeNull();
    } finally {
      await dataSource.destroy();
    }
  });
});
