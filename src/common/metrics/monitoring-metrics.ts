import type { MonitorPriority } from '../../modules/monitoring/monitoring.types';

const matchPriorities: Record<MonitorPriority, number> = { low: 0, normal: 0, high: 0, critical: 0 };
let mcpRequests = 0;
let mcpDurationSeconds = 0;
let mcpAuthFailures = 0;
let mcpRateLimits = 0;
let mcpValidationFailures = 0;
let monitorCandidates = 0;
let monitorDeduplications = 0;
let monitorRetentionDeletions = 0;
let digestBacklog = 0;
let oldestUnacknowledgedAgeSeconds = 0;

export function recordMcpRequest(durationMs: number): void {
  mcpRequests += 1;
  mcpDurationSeconds += Math.max(0, durationMs) / 1000;
}

export function recordMcpAuthFailure(): void {
  mcpAuthFailures += 1;
}

export function recordMcpRateLimit(): void {
  mcpRateLimits += 1;
}

export function recordMcpValidationFailure(): void {
  mcpValidationFailures += 1;
}

export function recordMonitorMatch(priority: MonitorPriority, semanticCandidate: boolean): void {
  matchPriorities[priority] += 1;
  if (semanticCandidate) monitorCandidates += 1;
}

export function recordMonitorDeduplication(): void {
  monitorDeduplications += 1;
}

export function recordMonitorRetentionDeletion(count: number): void {
  monitorRetentionDeletions += Math.max(0, count);
}

export function setMonitorDigestBacklog(count: number, oldestAt: Date | null): void {
  digestBacklog = Math.max(0, count);
  oldestUnacknowledgedAgeSeconds = oldestAt ? Math.max(0, Math.floor((Date.now() - oldestAt.getTime()) / 1000)) : 0;
}

export function getMonitoringMetrics(): {
  mcpRequests: number;
  mcpDurationSeconds: number;
  mcpAuthFailures: number;
  mcpRateLimits: number;
  mcpValidationFailures: number;
  monitorCandidates: number;
  monitorMatchesByPriority: Record<MonitorPriority, number>;
  monitorDeduplications: number;
  monitorRetentionDeletions: number;
  digestBacklog: number;
  oldestUnacknowledgedAgeSeconds: number;
} {
  return {
    mcpRequests,
    mcpDurationSeconds,
    mcpAuthFailures,
    mcpRateLimits,
    mcpValidationFailures,
    monitorCandidates,
    monitorMatchesByPriority: { ...matchPriorities },
    monitorDeduplications,
    monitorRetentionDeletions,
    digestBacklog,
    oldestUnacknowledgedAgeSeconds,
  };
}

export function resetMonitoringMetricsForTest(): void {
  mcpRequests = 0;
  mcpDurationSeconds = 0;
  mcpAuthFailures = 0;
  mcpRateLimits = 0;
  mcpValidationFailures = 0;
  monitorCandidates = 0;
  monitorDeduplications = 0;
  monitorRetentionDeletions = 0;
  digestBacklog = 0;
  oldestUnacknowledgedAgeSeconds = 0;
  for (const priority of Object.keys(matchPriorities) as MonitorPriority[]) matchPriorities[priority] = 0;
}
