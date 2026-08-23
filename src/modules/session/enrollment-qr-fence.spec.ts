import { createLogger } from '../../common/services/logger.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { EnrollmentChallengeBroker } from './enrollment-challenge-broker.service';
import { SessionEngineEventWiring, type SessionEngineWiringHost } from './session-engine-event-wiring';
import { SessionStatus } from './entities/session.entity';

describe('managed enrollment QR fence', () => {
  it('captures a managed QR in memory without webhook, WebSocket, or hook fan-out', () => {
    const broker = new EnrollmentChallengeBroker();
    broker.bind('session-1', {
      flowId: 'flow-1',
      principalId: 'principal-1',
      mode: 'qr',
      expiresAt: Date.now() + 60_000,
    });
    const dispatch = jest.fn();
    const emitQRCode = jest.fn();
    const execute = jest.fn();
    const updateStatus = jest.fn().mockResolvedValue(undefined);
    const engine = {} as IWhatsAppEngine;
    const host = {
      isLiveEngine: () => true,
      ownsSession: () => true,
      updateStatus,
      enrollmentBroker: broker,
      webhookService: { dispatch },
      eventsGateway: { emitQRCode },
      hookManager: { execute },
    } as unknown as SessionEngineWiringHost;
    const callbacks = new SessionEngineEventWiring({ logger: createLogger('test') }).buildCallbacks(
      'session-1',
      engine,
      'monitor',
      host,
    );

    callbacks.onQRCode?.('data:image/png;base64,secret');

    expect(broker.getQr('session-1', 'flow-1')).toBe('data:image/png;base64,secret');
    expect(dispatch).not.toHaveBeenCalled();
    expect(emitQRCode).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledWith('session-1', SessionStatus.QR_READY);
  });
});
