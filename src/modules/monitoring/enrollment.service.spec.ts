import { DataSource } from 'typeorm';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { EnrollmentChallengeBroker } from '../session/enrollment-challenge-broker.service';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { MonitorAuthFlow } from './entities';
import { EnrollmentService } from './enrollment.service';

describe('EnrollmentService', () => {
  let dataSource: DataSource;
  let broker: EnrollmentChallengeBroker;
  let service: EnrollmentService;
  let sessions: {
    findOne: jest.Mock;
    findAll: jest.Mock;
    isActive: jest.Mock;
    start: jest.Mock;
    stop: jest.Mock;
    logout: jest.Mock;
    getEngine: jest.Mock;
  };
  const sessionId = '11111111-1111-4111-a111-111111111111';
  const key = { id: 'principal-1', name: 'monitor', role: ApiKeyRole.OPERATOR, allowedSessions: [sessionId] } as ApiKey;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('qr'),
  ]).toString('base64');

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [Session, MonitorAuthFlow],
    });
    await dataSource.initialize();
    await dataSource.getRepository(Session).save({
      id: sessionId,
      name: 'enrollment-test',
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
    broker = new EnrollmentChallengeBroker();
    sessions = {
      findOne: jest.fn().mockResolvedValue({ id: sessionId, status: SessionStatus.QR_READY }),
      findAll: jest.fn(),
      isActive: jest.fn().mockReturnValue(true),
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      logout: jest.fn().mockResolvedValue(undefined),
      getEngine: jest.fn().mockReturnValue({
        getQRCode: () => `data:image/png;base64,${png}`,
        requestPairingCode: jest.fn().mockResolvedValue('ABCD-EFGH'),
      }),
    };
    service = new EnrollmentService(
      dataSource.getRepository(MonitorAuthFlow),
      sessions as never,
      { getCurrentEngine: () => 'whatsapp-web.js' } as never,
      broker,
      {
        assertMonitoringScope: (apiKey: ApiKey, requested: string) => {
          if (!apiKey.allowedSessions?.includes(requested)) throw new Error('denied');
          return apiKey.id;
        },
      } as never,
      { logInfo: jest.fn().mockResolvedValue(null), logWarn: jest.fn().mockResolvedValue(null) } as never,
    );
  });

  afterEach(async () => dataSource.destroy());

  it('begins idempotently and returns QR only as direct image content', async () => {
    const first = (await service.begin(key, sessionId, 'qr')) as { flowId: string };
    const second = (await service.begin(key, sessionId, 'qr')) as { flowId: string; idempotent: boolean };
    expect(second).toMatchObject({ flowId: first.flowId, idempotent: true });

    const challenge = await service.getChallenge(key, sessionId, first.flowId);
    expect(challenge.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'image', data: png, mimeType: 'image/png' })]),
    );
    const persisted = await dataSource.getRepository(MonitorAuthFlow).findOneByOrFail({ id: first.flowId });
    expect(JSON.stringify(persisted)).not.toContain(png);
    expect(JSON.stringify(persisted)).not.toContain('data:image');
  });

  it('collapses concurrent begin calls onto one active flow', async () => {
    const [left, right] = (await Promise.all([
      service.begin(key, sessionId, 'qr'),
      service.begin(key, sessionId, 'qr'),
    ])) as Array<{ flowId: string }>;
    expect(left.flowId).toBe(right.flowId);
    expect(await dataSource.getRepository(MonitorAuthFlow).countBy({ activeKey: `session:${sessionId}` })).toBe(1);
  });

  it('reuses one terminal authenticated row when the WhatsApp session is already ready', async () => {
    sessions.findOne.mockResolvedValue({ id: sessionId, status: SessionStatus.READY });
    const first = (await service.begin(key, sessionId, 'qr')) as { flowId: string; idempotent: boolean };
    const second = (await service.begin(key, sessionId, 'qr')) as { flowId: string; idempotent: boolean };
    expect(second).toMatchObject({ flowId: first.flowId, idempotent: true });
    expect(await dataSource.getRepository(MonitorAuthFlow).count()).toBe(1);
  });

  it('enforces one flow per session across principals and invalidates it on cancel', async () => {
    const first = (await service.begin(key, sessionId, 'qr')) as { flowId: string };
    const other = { ...key, id: 'principal-2' };
    await expect(service.begin(other, sessionId, 'qr')).rejects.toThrow(/another enrollment flow/i);
    await service.cancel(key, sessionId, first.flowId);
    expect(sessions.stop).toHaveBeenCalledWith(sessionId);
    expect(broker.isManaged(sessionId)).toBe(false);
    expect(await dataSource.getRepository(MonitorAuthFlow).findOneByOrFail({ id: first.flowId })).toMatchObject({
      state: 'cancelled',
      activeKey: null,
    });
  });

  it('expires every durable active flow on restart because its memory-only challenge cannot resume', async () => {
    const begun = (await service.begin(key, sessionId, 'qr')) as { flowId: string };
    expect(broker.isManaged(sessionId)).toBe(true);

    const restartedBroker = new EnrollmentChallengeBroker();
    const restartedService = new EnrollmentService(
      dataSource.getRepository(MonitorAuthFlow),
      sessions as never,
      { getCurrentEngine: () => 'whatsapp-web.js' } as never,
      restartedBroker,
      {
        assertMonitoringScope: (apiKey: ApiKey, requested: string) => {
          if (!apiKey.allowedSessions?.includes(requested)) throw new Error('denied');
          return apiKey.id;
        },
      } as never,
      { logInfo: jest.fn().mockResolvedValue(null), logWarn: jest.fn().mockResolvedValue(null) } as never,
    );

    await restartedService.onModuleInit();

    expect(await dataSource.getRepository(MonitorAuthFlow).findOneByOrFail({ id: begun.flowId })).toMatchObject({
      state: 'expired',
      activeKey: null,
    });
    expect(restartedBroker.isManaged(sessionId)).toBe(false);
    const replacement = (await restartedService.begin(key, sessionId, 'qr')) as { flowId: string };
    expect(replacement.flowId).not.toBe(begun.flowId);
  });

  it('does not return or retain a pairing code when cancellation wins the engine-generation race', async () => {
    let resolvePairingCode!: (code: string) => void;
    const requestPairingCode = jest.fn(
      () =>
        new Promise<string>(resolve => {
          resolvePairingCode = resolve;
        }),
    );
    sessions.getEngine.mockReturnValue({ getQRCode: jest.fn(), requestPairingCode });
    const begun = (await service.begin(key, sessionId, 'pairing_code')) as { flowId: string };
    const capture = jest.spyOn(broker, 'capturePairingCode');

    const challenge = service.getChallenge(key, sessionId, begun.flowId, '+1 202 555 0187');
    const rejection = expect(challenge).rejects.toThrow(/no longer active/i);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(requestPairingCode).toHaveBeenCalledWith('12025550187');

    await service.cancel(key, sessionId, begun.flowId);
    resolvePairingCode('SECRET-CODE');
    await rejection;

    expect(capture).not.toHaveBeenCalled();
    expect(broker.getPairingCode(sessionId, begun.flowId)).toBeUndefined();
    expect(
      JSON.stringify(await dataSource.getRepository(MonitorAuthFlow).findOneByOrFail({ id: begun.flowId })),
    ).not.toContain('SECRET-CODE');
  });

  it('requires deliberate confirmation before destructive disconnect', async () => {
    await expect(service.disconnect(key, sessionId, false)).rejects.toThrow(/confirm=true/);
    await service.disconnect(key, sessionId, true);
    expect(sessions.logout).toHaveBeenCalledWith(sessionId);
  });

  it('invalidates the challenge before a failed disconnect awaits engine teardown', async () => {
    const begun = (await service.begin(key, sessionId, 'qr')) as { flowId: string };
    sessions.logout.mockRejectedValueOnce(new Error('engine failure'));
    await expect(service.disconnect(key, sessionId, true)).rejects.toThrow(/did not complete/i);
    expect(broker.isManaged(sessionId)).toBe(false);
    expect(await dataSource.getRepository(MonitorAuthFlow).findOneByOrFail({ id: begun.flowId })).toMatchObject({
      state: 'error',
      activeKey: null,
      errorCode: 'DISCONNECT_FAILED',
    });
  });
});
