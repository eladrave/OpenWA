import { toNeutralJid } from '../../engine/identity/wa-id';
import type {
  MonitorActiveHours,
  MonitorCondition,
  MonitorEnvelope,
  MonitorEvaluationResult,
  MonitorPriority,
  MonitorRuleConfig,
  MonitorUrgencyLevel,
  MonitorUrgencyResult,
} from './monitoring.types';
import { compileMonitorRegex } from './monitoring.regex';

const urgencyRank: Record<MonitorUrgencyLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const canonicalJid = (value: string): string => {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return `${trimmed}@c.us`;
  return toNeutralJid(trimmed).toLowerCase();
};

const normalizeText = (value: string, caseSensitive = false, whitespace = false): string => {
  const normalized = whitespace ? value.replace(/\s+/g, ' ').trim() : value;
  return caseSensitive ? normalized : normalized.toLocaleLowerCase();
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const epochDate = (timestamp: number): Date => new Date(timestamp > 10_000_000_000 ? timestamp : timestamp * 1000);

const weekdayNumber = (short: string): number => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(short);

function localClock(date: Date, timezone: string): { minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find(part => part.type === type)?.value ?? '';
  const hour = Number(read('hour')) % 24;
  return { minute: hour * 60 + Number(read('minute')), weekday: weekdayNumber(read('weekday')) };
}

const minuteOfDay = (value: string): number => {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
};

function inWindow(date: Date, timezone: string, window: MonitorActiveHours): boolean {
  const current = localClock(date, timezone);
  if (window.daysOfWeek?.length && !window.daysOfWeek.includes(current.weekday)) return false;
  const start = minuteOfDay(window.start);
  const end = minuteOfDay(window.end);
  if (start === end) return true;
  return start < end
    ? current.minute >= start && current.minute < end
    : current.minute >= start || current.minute < end;
}

export function computeDeterministicUrgency(envelope: MonitorEnvelope): MonitorUrgencyResult {
  const body = envelope.body.toLocaleLowerCase();
  const reasons: string[] = [];
  let score = 0;
  if (envelope.mentionedJids.length > 0) {
    score += 25;
    reasons.push('direct structured mention');
  }
  if (/\b(urgent|emergency|critical|asap|immediately)\b/u.test(body)) {
    score += 35;
    reasons.push('urgent phrase');
  }
  if (/\b(today|tonight|deadline|within (?:an?|one) hour|before \d{1,2}(?::\d{2})?)\b/u.test(body)) {
    score += 25;
    reasons.push('deadline phrase');
  }
  if (/\b(please respond|need (?:a )?response|call me|reply needed|can you confirm)\b/u.test(body)) {
    score += 15;
    reasons.push('response requested');
  }
  score = Math.min(100, score);
  const level: MonitorUrgencyLevel =
    score >= 80 ? 'critical' : score >= 60 ? 'high' : score >= 35 ? 'medium' : score >= 15 ? 'low' : 'none';
  return {
    level,
    score,
    reasons,
    requiresResponse: reasons.includes('response requested') || score >= 60,
    confidence: score === 0 ? 0.5 : Math.min(0.9, 0.55 + reasons.length * 0.1),
  };
}

interface ConditionResult {
  matched: boolean;
  deferred?: boolean;
  evidence?: string;
}

function evaluateCondition(
  condition: MonitorCondition,
  envelope: MonitorEnvelope,
  ownerJid: string | null,
  timezone: string,
  urgency: MonitorUrgencyResult,
): ConditionResult {
  const body = envelope.body ?? '';
  switch (condition.type) {
    case 'mentioned_owner': {
      const owner = ownerJid ? canonicalJid(ownerJid) : '';
      const matched = Boolean(owner) && envelope.mentionedJids.some(jid => canonicalJid(jid) === owner);
      return { matched, evidence: matched ? 'mentioned_owner via mentionedIds' : undefined };
    }
    case 'mentioned_jid': {
      const wanted = new Set(condition.jids.map(canonicalJid));
      const found = envelope.mentionedJids.map(canonicalJid).find(jid => wanted.has(jid));
      return { matched: Boolean(found), evidence: found ? `structured mention matched ${found}` : undefined };
    }
    case 'keyword': {
      const haystack = normalizeText(body, condition.caseSensitive);
      for (const raw of condition.values) {
        const needle = normalizeText(raw, condition.caseSensitive);
        const matched = condition.wholeWord
          ? new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegex(needle)}(?:$|[^\\p{L}\\p{N}_])`, 'u').test(haystack)
          : haystack.includes(needle);
        if (matched) return { matched: true, evidence: `keyword ${JSON.stringify(raw)} matched body` };
      }
      return { matched: false };
    }
    case 'phrase': {
      const haystack = normalizeText(body, condition.caseSensitive, condition.normalizeWhitespace !== false);
      const needle = normalizeText(condition.value, condition.caseSensitive, condition.normalizeWhitespace !== false);
      const matched = haystack.includes(needle);
      return { matched, evidence: matched ? `phrase ${JSON.stringify(condition.value)} matched body` : undefined };
    }
    case 'regex': {
      const matched = compileMonitorRegex(condition.pattern, condition.flags).test(body.slice(0, 4096));
      return { matched, evidence: matched ? 'RE2 regular expression matched body' : undefined };
    }
    case 'sender': {
      const wanted = new Set(condition.jids.map(canonicalJid));
      const present = wanted.has(canonicalJid(envelope.senderJid));
      const matched = condition.mode === 'deny' ? !present : present;
      return {
        matched,
        evidence: matched ? `sender ${condition.mode === 'deny' ? 'denylist passed' : 'allowlist matched'}` : undefined,
      };
    }
    case 'message_type': {
      const matched = condition.types.includes(envelope.type as (typeof condition.types)[number]);
      return { matched, evidence: matched ? `message type ${envelope.type} matched` : undefined };
    }
    case 'has_media': {
      const matched = envelope.hasMedia === (condition.value ?? true);
      return { matched, evidence: matched ? `has_media is ${String(envelope.hasMedia)}` : undefined };
    }
    case 'is_reply': {
      const matched = envelope.isReply === (condition.value ?? true);
      return { matched, evidence: matched ? `is_reply is ${String(envelope.isReply)}` : undefined };
    }
    case 'time_window': {
      const matched = inWindow(epochDate(envelope.timestamp), timezone, condition);
      return { matched, evidence: matched ? `time window matched in ${timezone}` : undefined };
    }
    case 'semantic_topic':
      return { matched: false, deferred: true, evidence: 'semantic topic requires client assessment' };
    case 'urgency': {
      const matched = urgencyRank[urgency.level] >= urgencyRank[condition.minimumLevel];
      if (matched) return { matched: true, evidence: `urgency ${urgency.level} met ${condition.minimumLevel}` };
      return condition.semantic === false
        ? { matched: false }
        : { matched: false, deferred: true, evidence: 'urgency requires client assessment' };
    }
  }
}

export function evaluateMonitorRule(
  rule: MonitorRuleConfig,
  envelope: MonitorEnvelope,
  ownerJid: string | null,
): MonitorEvaluationResult {
  const urgency = computeDeterministicUrgency(envelope);
  const eventDate = epochDate(envelope.timestamp);
  if (rule.activeHours && !inWindow(eventDate, rule.timezone, rule.activeHours)) {
    return { matched: false, candidate: false, evidence: [], semanticConditions: [], urgency };
  }
  if (rule.quietHours && inWindow(eventDate, rule.timezone, rule.quietHours) && rule.priority !== 'critical') {
    return { matched: false, candidate: false, evidence: [], semanticConditions: [], urgency };
  }

  const positive = rule.conditions.map(condition => ({
    condition,
    result: evaluateCondition(condition, envelope, ownerJid, rule.timezone, urgency),
  }));
  const deterministic = positive.filter(item => !item.result.deferred);
  const semantic = positive
    .filter(item => item.result.deferred)
    .map(item => ({ effect: 'include' as const, condition: item.condition }));
  const deterministicPass =
    rule.matchMode === 'all'
      ? deterministic.every(item => item.result.matched)
      : deterministic.some(item => item.result.matched);
  const requiredSemantic = rule.matchMode === 'any' && deterministicPass ? [] : semantic;
  const positivePass = rule.matchMode === 'all' ? deterministicPass : deterministicPass || requiredSemantic.length > 0;
  if (!positivePass) {
    return { matched: false, candidate: false, evidence: [], semanticConditions: requiredSemantic, urgency };
  }

  const exclusions = rule.exclusions.map(condition => ({
    condition,
    result: evaluateCondition(condition, envelope, ownerJid, rule.timezone, urgency),
  }));
  if (exclusions.some(item => !item.result.deferred && item.result.matched)) {
    return { matched: false, candidate: false, evidence: [], semanticConditions: [], urgency };
  }
  const semanticExclusions = exclusions
    .filter(item => item.result.deferred)
    .map(item => ({ effect: 'exclude' as const, condition: item.condition }));
  const semanticConditions = [...requiredSemantic, ...semanticExclusions];
  const evidence = [...positive, ...exclusions]
    .filter(item => !item.result.deferred)
    .map(item => item.result.evidence)
    .filter((item): item is string => Boolean(item));
  if (rule.quietHours && rule.priority === 'critical' && inWindow(eventDate, rule.timezone, rule.quietHours)) {
    evidence.push('critical priority overrode quiet hours');
  }
  return {
    matched: positivePass && semanticConditions.length === 0,
    candidate: positivePass && semanticConditions.length > 0,
    evidence,
    semanticConditions,
    urgency,
  };
}

export const priorityScore = (priority: MonitorPriority): number =>
  ({ low: 10, normal: 30, high: 70, critical: 100 })[priority];
