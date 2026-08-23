import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { MonitorEnrollmentMode } from '../monitoring/monitoring.types';

interface EnrollmentBinding {
  flowId: string;
  principalId: string;
  mode: MonitorEnrollmentMode;
  expiresAt: number;
  qrDataUrl?: string;
  pairingCode?: string;
}

/**
 * Memory-only broker for short-lived enrollment challenges.
 *
 * Durable flow rows deliberately contain no QR, pairing code, phone number, or engine credential.
 * One active binding exists per WhatsApp session because the engine itself has only one challenge.
 */
@Injectable()
export class EnrollmentChallengeBroker implements OnModuleDestroy {
  private readonly bindings = new Map<string, EnrollmentBinding>();

  bind(sessionId: string, binding: Pick<EnrollmentBinding, 'flowId' | 'principalId' | 'mode' | 'expiresAt'>): void {
    const current = this.get(sessionId);
    if (current && current.flowId !== binding.flowId) {
      throw new Error('A different managed enrollment flow already owns this session');
    }
    this.bindings.set(sessionId, { ...binding, qrDataUrl: current?.qrDataUrl, pairingCode: current?.pairingCode });
  }

  get(sessionId: string): EnrollmentBinding | undefined {
    const current = this.bindings.get(sessionId);
    if (!current) return undefined;
    if (current.expiresAt <= Date.now()) {
      return undefined;
    }
    return current;
  }

  isManaged(sessionId: string): boolean {
    // Keep an expired binding fenced until the expiry service has stopped the unpaired engine.
    // Otherwise a still-running engine can emit another QR into the legacy webhook/WebSocket path
    // in the gap between expiry and teardown.
    return this.bindings.has(sessionId);
  }

  captureQr(sessionId: string, qrDataUrl: string): boolean {
    const current = this.bindings.get(sessionId);
    if (current && current.expiresAt <= Date.now()) return true; // suppress, but never retain, expired QR
    if (!current || current.mode !== 'qr') return false;
    current.qrDataUrl = qrDataUrl;
    return true;
  }

  getQr(sessionId: string, flowId: string): string | undefined {
    const current = this.get(sessionId);
    return current?.flowId === flowId ? current.qrDataUrl : undefined;
  }

  capturePairingCode(sessionId: string, flowId: string, pairingCode: string): boolean {
    const current = this.get(sessionId);
    if (!current || current.flowId !== flowId || current.mode !== 'pairing_code') return false;
    current.pairingCode = pairingCode;
    return true;
  }

  getPairingCode(sessionId: string, flowId: string): string | undefined {
    const current = this.get(sessionId);
    return current?.flowId === flowId ? current.pairingCode : undefined;
  }

  clearChallenge(sessionId: string): void {
    const current = this.get(sessionId);
    if (!current) return;
    delete current.qrDataUrl;
    delete current.pairingCode;
  }

  clear(sessionId: string, flowId?: string): void {
    const current = this.bindings.get(sessionId);
    if (!current || (flowId && current.flowId !== flowId)) return;
    this.bindings.delete(sessionId);
  }

  onModuleDestroy(): void {
    this.bindings.clear();
  }
}
