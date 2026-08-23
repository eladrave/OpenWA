import { HttpStatus, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import type { ApiKey } from '../auth/entities/api-key.entity';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { SessionStatus } from '../session/entities/session.entity';
import { EnrollmentChallengeBroker } from '../session/enrollment-challenge-broker.service';
import { SessionService } from '../session/session.service';
import { EngineFactory } from '../../engine/engine.factory';
import { monitorError } from './monitoring.errors';
import type { MonitorEnrollmentMode, MonitorEnrollmentState } from './monitoring.types';
import { MonitorAuthFlow } from './entities';
import { MonitoringService } from './monitoring.service';
import { isUniqueViolation } from '../../common/utils/db-errors';

const FLOW_TTL_MS = 5 * 60_000;
const FLOW_HISTORY_MAX = 100;

export interface AgentContentResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' }>;
}

@Injectable()
export class EnrollmentService implements OnModuleInit {
  constructor(
    @InjectRepository(MonitorAuthFlow, 'data') private readonly flows: Repository<MonitorAuthFlow>,
    private readonly sessions: SessionService,
    private readonly engineFactory: EngineFactory,
    private readonly broker: EnrollmentChallengeBroker,
    private readonly monitoring: MonitoringService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Challenges are memory-only, so no unfinished flow is resumable after process restart. Expire
    // every durable active row before SessionService's later application-bootstrap auto-start phase;
    // this prevents an unpaired session from becoming a forever-active flow with no challenge.
    const active = await this.flows.find({ where: { activeKey: Not(IsNull()) } });
    const now = new Date();
    for (const flow of active) {
      if (!flow.activeKey) continue;
      this.broker.clear(flow.sessionId, flow.id);
      await this.flows.update(
        { id: flow.id, activeKey: flow.activeKey },
        { state: 'expired', activeKey: null, completedAt: now },
      );
    }
  }

  async listSessions(apiKey: ApiKey): Promise<object[]> {
    const allowed = apiKey.allowedSessions ?? [];
    if (!allowed.length) {
      throw monitorError(
        'AUTH_REQUIRED',
        HttpStatus.FORBIDDEN,
        'WhatsApp monitoring requires an API key with explicit session grants',
      );
    }
    const sessions = await this.sessions.findAll(allowed, { limit: Math.min(allowed.length, 100), offset: 0 });
    return sessions.map(session => ({
      sessionId: session.id,
      name: session.name,
      state: this.sessionState(session.status),
      engine: this.engineFactory.getCurrentEngine(),
    }));
  }

  async begin(apiKey: ApiKey, sessionId: string, mode: MonitorEnrollmentMode): Promise<object> {
    const principalId = this.monitoring.assertMonitoringScope(apiKey, sessionId);
    const session = await this.sessions.findOne(sessionId);
    const activeKey = `session:${sessionId}`;
    const existing = await this.flows.findOne({ where: { activeKey } });
    if (existing) {
      if (existing.expiresAt <= new Date()) {
        await this.expire(existing);
      } else if (existing.principalId === principalId && existing.mode === mode) {
        this.bind(existing);
        return this.safeStatus(existing, session.status, true);
      } else {
        throw monitorError('FLOW_CONFLICT', HttpStatus.CONFLICT, 'Another enrollment flow already owns this session');
      }
    }

    const ready = session.status === SessionStatus.READY;
    if (ready) {
      const authenticated = await this.flows.findOne({
        where: { principalId, sessionId, state: 'authenticated' },
        order: { createdAt: 'DESC' },
      });
      if (authenticated) return this.safeStatus(authenticated, session.status, true);
    }
    await this.pruneFlowHistory(principalId, sessionId);
    let flow: MonitorAuthFlow;
    try {
      flow = await this.flows.save(
        this.flows.create({
          principalId,
          sessionId,
          activeKey: ready ? null : activeKey,
          mode,
          state: ready ? 'authenticated' : 'starting',
          expiresAt: new Date(Date.now() + FLOW_TTL_MS),
          challengeIssuedAt: null,
          completedAt: ready ? new Date() : null,
          errorCode: null,
          errorMessage: null,
        }),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.flows.findOne({ where: { activeKey } });
      if (winner?.principalId === principalId && winner.mode === mode) {
        this.bind(winner);
        return this.safeStatus(winner, session.status, true);
      }
      throw monitorError('FLOW_CONFLICT', HttpStatus.CONFLICT, 'Another enrollment flow already owns this session');
    }
    if (!ready) {
      this.bind(flow);
      if (!this.sessions.isActive(sessionId)) {
        void this.sessions
          .start(sessionId)
          .catch(() => this.failFlow(flow.id, 'SESSION_NOT_READY', 'WhatsApp session failed to start'));
      }
    }
    await this.audit.logInfo(AuditAction.MONITOR_ENROLLMENT_BEGAN, {
      apiKey,
      sessionId,
      metadata: { flowId: flow.id, mode },
    });
    return this.safeStatus(flow, session.status, false);
  }

  async getStatus(apiKey: ApiKey, sessionId: string, flowId?: string): Promise<object> {
    const principalId = this.monitoring.assertMonitoringScope(apiKey, sessionId);
    const session = await this.sessions.findOne(sessionId);
    const flow = flowId
      ? await this.flows.findOne({ where: { id: flowId, principalId, sessionId } })
      : await this.flows.findOne({ where: { principalId, sessionId }, order: { createdAt: 'DESC' } });
    if (!flow) {
      return {
        sessionId,
        state: this.sessionState(session.status),
        engine: this.engineFactory.getCurrentEngine(),
        message: this.stateMessage(this.sessionState(session.status)),
      };
    }
    if (flow.activeKey && flow.expiresAt <= new Date()) await this.expire(flow);
    if (session.status === SessionStatus.READY && flow.state !== 'authenticated') {
      await this.complete(flow, 'authenticated');
    } else if (
      flow.activeKey &&
      (session.status === SessionStatus.FAILED || session.status === SessionStatus.ACTION_REQUIRED)
    ) {
      await this.failFlow(flow.id, 'SESSION_NOT_READY', 'WhatsApp requires operator attention');
    }
    const current = (await this.flows.findOne({ where: { id: flow.id, principalId, sessionId } })) ?? flow;
    return this.safeStatus(current, session.status, false);
  }

  async getChallenge(
    apiKey: ApiKey,
    sessionId: string,
    flowId: string,
    phoneNumber?: string,
  ): Promise<AgentContentResult> {
    const principalId = this.monitoring.assertMonitoringScope(apiKey, sessionId);
    const flow = await this.requireActiveFlow(principalId, sessionId, flowId);
    const session = await this.sessions.findOne(sessionId);
    if (session.status === SessionStatus.READY) {
      await this.complete(flow, 'authenticated');
      throw monitorError('CHALLENGE_NOT_READY', HttpStatus.CONFLICT, 'WhatsApp is already authenticated');
    }
    this.bind(flow);

    if (flow.mode === 'qr') {
      let dataUrl = this.broker.getQr(sessionId, flow.id);
      if (!dataUrl) {
        const engineQr = this.sessions.getEngine(sessionId)?.getQRCode();
        if (engineQr) {
          this.broker.captureQr(sessionId, engineQr);
          dataUrl = engineQr;
        }
      }
      if (!dataUrl) {
        throw monitorError('CHALLENGE_NOT_READY', HttpStatus.CONFLICT, 'QR code is not ready; retry status shortly');
      }
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl))
        throw monitorError('CHALLENGE_NOT_READY', HttpStatus.INTERNAL_SERVER_ERROR, 'QR image is unavailable');
      if (!(await this.markChallengeIssued(flow))) {
        this.broker.clear(flow.sessionId, flow.id);
        throw monitorError('FLOW_EXPIRED', HttpStatus.GONE, 'The enrollment flow is no longer active');
      }
      dataUrl = this.broker.getQr(sessionId, flow.id);
      if (!dataUrl) {
        throw monitorError('FLOW_EXPIRED', HttpStatus.GONE, 'The enrollment challenge was invalidated');
      }
      const issuedMatch = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
      if (!issuedMatch)
        throw monitorError('CHALLENGE_NOT_READY', HttpStatus.INTERNAL_SERVER_ERROR, 'QR image is unavailable');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              flowId: flow.id,
              sessionId,
              state: 'waiting_for_scan',
              expiresAt: flow.expiresAt,
              message: 'Scan this short-lived QR code from WhatsApp Linked Devices.',
            }),
          },
          { type: 'image', data: issuedMatch[1], mimeType: 'image/png' },
        ],
      };
    }

    const normalized = this.normalizePhone(phoneNumber);
    let pairingCode = this.broker.getPairingCode(sessionId, flow.id);
    if (!pairingCode) {
      const engine = this.sessions.getEngine(sessionId);
      if (!engine) throw monitorError('CHALLENGE_NOT_READY', HttpStatus.CONFLICT, 'Session is still starting');
      try {
        pairingCode = await engine.requestPairingCode(normalized);
      } catch {
        throw monitorError(
          'PAIRING_UNSUPPORTED',
          HttpStatus.NOT_IMPLEMENTED,
          'Pairing code is unavailable for this engine state',
        );
      }
      if (!(await this.markChallengeIssued(flow))) {
        throw monitorError('FLOW_EXPIRED', HttpStatus.GONE, 'The enrollment flow is no longer active');
      }
      if (!this.broker.capturePairingCode(sessionId, flow.id, pairingCode)) {
        throw monitorError('FLOW_EXPIRED', HttpStatus.GONE, 'The enrollment challenge was invalidated');
      }
    } else if (!(await this.markChallengeIssued(flow))) {
      this.broker.clear(flow.sessionId, flow.id);
      throw monitorError('FLOW_EXPIRED', HttpStatus.GONE, 'The enrollment flow is no longer active');
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            flowId: flow.id,
            sessionId,
            state: 'waiting_for_scan',
            pairingCode,
            expiresAt: flow.expiresAt,
            sensitive: true,
            message: 'Enter this short-lived code in WhatsApp Linked Devices. Do not share it.',
          }),
        },
      ],
    };
  }

  async cancel(apiKey: ApiKey, sessionId: string, flowId: string): Promise<object> {
    const principalId = this.monitoring.assertMonitoringScope(apiKey, sessionId);
    const flow = await this.flows.findOne({ where: { id: flowId, principalId, sessionId } });
    if (!flow) throw monitorError('FLOW_NOT_FOUND', HttpStatus.NOT_FOUND, 'The enrollment flow was not found');
    if (flow.state === 'cancelled' || flow.state === 'expired')
      return this.safeStatus(flow, SessionStatus.DISCONNECTED, true);
    const session = await this.sessions.findOne(sessionId);
    if (session.status !== SessionStatus.READY && this.sessions.isActive(sessionId)) {
      await this.sessions.stop(sessionId).catch(() => undefined);
    }
    this.broker.clear(sessionId, flow.id);
    await this.flows.update(flow.id, { state: 'cancelled', activeKey: null, completedAt: new Date() });
    await this.audit.logInfo(AuditAction.MONITOR_ENROLLMENT_CANCELLED, {
      apiKey,
      sessionId,
      metadata: { flowId },
    });
    return this.safeStatus(await this.flows.findOneByOrFail({ id: flow.id }), SessionStatus.DISCONNECTED, false);
  }

  async disconnect(apiKey: ApiKey, sessionId: string, confirm: boolean): Promise<object> {
    this.monitoring.assertMonitoringScope(apiKey, sessionId);
    if (!confirm) {
      throw monitorError('RULE_INVALID', HttpStatus.BAD_REQUEST, 'Set confirm=true to unlink this WhatsApp device');
    }
    // Invalidate the challenge before awaiting engine teardown. If logout blocks or fails, a
    // concurrent challenge request must still lose its CAS and no QR/pairing code remains usable.
    this.broker.clear(sessionId);
    const invalidatedAt = new Date();
    await this.flows.update(
      { sessionId },
      { state: 'cancelled', activeKey: null, completedAt: invalidatedAt, errorCode: null, errorMessage: null },
    );
    try {
      await this.sessions.logout(sessionId);
    } catch {
      await this.flows.update(
        { sessionId },
        {
          state: 'error',
          activeKey: null,
          completedAt: new Date(),
          errorCode: 'DISCONNECT_FAILED',
          errorMessage: 'WhatsApp disconnect did not complete; check status before retrying',
        },
      );
      await this.audit.logWarn(AuditAction.MONITOR_DISCONNECT_FAILED, {
        apiKey,
        sessionId,
        metadata: { outcome: 'engine_teardown_failed', challengeInvalidated: true },
      });
      throw monitorError(
        'DISCONNECT_FAILED',
        HttpStatus.BAD_GATEWAY,
        'WhatsApp disconnect did not complete; check status before retrying',
      );
    }
    await this.flows.update(
      { sessionId },
      { state: 'logged_out', activeKey: null, completedAt: new Date(), errorCode: null, errorMessage: null },
    );
    await this.audit.logInfo(AuditAction.MONITOR_DISCONNECTED, { apiKey, sessionId });
    return { sessionId, state: 'logged_out', destructive: true, message: 'WhatsApp device unlinked' };
  }

  private bind(flow: MonitorAuthFlow): void {
    this.broker.bind(flow.sessionId, {
      flowId: flow.id,
      principalId: flow.principalId,
      mode: flow.mode,
      expiresAt: flow.expiresAt.getTime(),
    });
  }

  private async requireActiveFlow(principalId: string, sessionId: string, flowId: string): Promise<MonitorAuthFlow> {
    const flow = await this.flows.findOne({ where: { id: flowId, principalId, sessionId } });
    if (!flow) throw monitorError('FLOW_NOT_FOUND', HttpStatus.NOT_FOUND, 'The enrollment flow was not found');
    if (!flow.activeKey || flow.expiresAt <= new Date()) {
      if (flow.activeKey) await this.expire(flow);
      throw monitorError('FLOW_EXPIRED', HttpStatus.GONE, 'The enrollment flow expired; begin a new flow');
    }
    return flow;
  }

  private async markChallengeIssued(flow: MonitorAuthFlow): Promise<boolean> {
    if (!flow.activeKey) return false;
    const now = new Date();
    const result = await this.flows
      .createQueryBuilder()
      .update(MonitorAuthFlow)
      .set({ state: 'waiting_for_scan', challengeIssuedAt: now })
      .where(
        '"id" = :id AND "principalId" = :principalId AND "sessionId" = :sessionId AND "activeKey" = :activeKey AND "expiresAt" > :now',
        {
          id: flow.id,
          principalId: flow.principalId,
          sessionId: flow.sessionId,
          activeKey: flow.activeKey,
          now,
        },
      )
      .execute();
    return (result.affected ?? 0) === 1;
  }

  private async expire(flow: MonitorAuthFlow): Promise<void> {
    const session = await this.sessions.findOne(flow.sessionId).catch(() => null);
    if (session && session.status !== SessionStatus.READY && this.sessions.isActive(flow.sessionId)) {
      await this.sessions.stop(flow.sessionId).catch(() => undefined);
    }
    this.broker.clear(flow.sessionId, flow.id);
    await this.flows.update(flow.id, { state: 'expired', activeKey: null, completedAt: new Date() });
  }

  private async complete(flow: MonitorAuthFlow, state: 'authenticated' | 'logged_out'): Promise<void> {
    this.broker.clear(flow.sessionId, flow.id);
    await this.flows.update(flow.id, { state, activeKey: null, completedAt: new Date() });
  }

  private async failFlow(flowId: string, code: string, message: string): Promise<void> {
    const flow = await this.flows.findOne({ where: { id: flowId } });
    if (!flow?.activeKey) return;
    this.broker.clear(flow.sessionId, flow.id);
    await this.flows.update(flow.id, {
      state: 'error',
      activeKey: null,
      completedAt: new Date(),
      errorCode: code,
      errorMessage: message,
    });
  }

  private normalizePhone(value: string | undefined): string {
    const digits = (value ?? '').replace(/\D/g, '');
    if (!/^\d{8,15}$/.test(digits)) {
      throw monitorError(
        'RULE_INVALID',
        HttpStatus.BAD_REQUEST,
        'Provide a valid international phone number for pairing',
      );
    }
    return digits;
  }

  private async pruneFlowHistory(principalId: string, sessionId: string): Promise<void> {
    const stale = await this.flows.find({
      select: { id: true },
      where: { principalId, sessionId, activeKey: IsNull() },
      order: { createdAt: 'DESC' },
      skip: FLOW_HISTORY_MAX,
      take: 1_000,
    });
    if (stale.length) await this.flows.delete({ id: In(stale.map(flow => flow.id)) });
  }

  private sessionState(status: SessionStatus): MonitorEnrollmentState {
    const map: Record<SessionStatus, MonitorEnrollmentState> = {
      [SessionStatus.CREATED]: 'unconfigured',
      [SessionStatus.INITIALIZING]: 'starting',
      [SessionStatus.QR_READY]: 'challenge_ready',
      [SessionStatus.AUTHENTICATING]: 'connecting',
      [SessionStatus.READY]: 'authenticated',
      [SessionStatus.DISCONNECTED]: 'logged_out',
      [SessionStatus.ACTION_REQUIRED]: 'error',
      [SessionStatus.FAILED]: 'error',
    };
    return map[status];
  }

  private safeStatus(flow: MonitorAuthFlow, sessionStatus: SessionStatus, idempotent: boolean): object {
    const terminal = ['expired', 'cancelled', 'authenticated', 'logged_out', 'error'].includes(flow.state);
    const state = terminal
      ? flow.state
      : this.sessionState(sessionStatus) === 'unconfigured'
        ? flow.state
        : this.sessionState(sessionStatus);
    return {
      flowId: flow.id,
      sessionId: flow.sessionId,
      mode: flow.mode,
      state,
      engine: this.engineFactory.getCurrentEngine(),
      createdAt: flow.createdAt,
      expiresAt: flow.expiresAt,
      idempotent,
      message: flow.errorMessage ?? this.stateMessage(state),
      retryable: !terminal || state === 'error',
    };
  }

  private stateMessage(state: MonitorEnrollmentState): string {
    const messages: Record<MonitorEnrollmentState, string> = {
      unconfigured: 'WhatsApp is not linked.',
      starting: 'WhatsApp is starting; poll status shortly.',
      challenge_ready: 'The enrollment challenge is ready.',
      waiting_for_scan: 'Waiting for the QR scan or pairing code entry.',
      connecting: 'WhatsApp is authenticating.',
      authenticated: 'WhatsApp is connected.',
      expired: 'The enrollment flow expired; begin a new flow.',
      cancelled: 'The enrollment flow was cancelled.',
      logged_out: 'WhatsApp is disconnected.',
      error: 'WhatsApp enrollment requires attention.',
    };
    return messages[state];
  }
}
