export const MONITOR_RULES_PER_SESSION_MAX = 200;
export const MONITOR_RULES_PER_GROUP_MAX = 50;
export const MONITOR_CONDITIONS_PER_RULE_MAX = 20;
export const MONITOR_KEYWORDS_PER_CONDITION_MAX = 50;
export const MONITOR_KEYWORD_LENGTH_MAX = 100;
export const MONITOR_REGEX_LENGTH_MAX = 256;
export const MONITOR_SEMANTIC_DESCRIPTION_MAX = 500;
export const MONITOR_PREVIEW_MESSAGES_MAX = 100;
export const MONITOR_DIGEST_BATCH_MAX = 100;
export const MONITOR_BODY_MAX = 4096;
export const MONITOR_TAGS_MAX = 20;
export const MONITOR_RETENTION_DAYS_MAX = 90;
export const MONITOR_MATCHES_RETAINED_PER_SESSION_MAX = 50_000;

export const MONITOR_MESSAGE_TYPES = [
  'text',
  'image',
  'video',
  'audio',
  'voice',
  'document',
  'sticker',
  'location',
  'contact',
  'poll',
  'call',
  'revoked',
  'masked',
  'unknown',
] as const;

export type MonitorMessageType = (typeof MONITOR_MESSAGE_TYPES)[number];
export type MonitorMatchMode = 'any' | 'all';
export type MonitorPriority = 'low' | 'normal' | 'high' | 'critical';
export type MonitorUrgencyLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

export interface MentionedOwnerCondition {
  type: 'mentioned_owner';
}

export interface MentionedJidCondition {
  type: 'mentioned_jid';
  jids: string[];
}

export interface KeywordCondition {
  type: 'keyword';
  values: string[];
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

export interface PhraseCondition {
  type: 'phrase';
  value: string;
  caseSensitive?: boolean;
  normalizeWhitespace?: boolean;
}

export interface RegexCondition {
  type: 'regex';
  pattern: string;
  flags?: string;
}

export interface SenderCondition {
  type: 'sender';
  jids: string[];
  mode?: 'allow' | 'deny';
}

export interface MessageTypeCondition {
  type: 'message_type';
  types: MonitorMessageType[];
}

export interface HasMediaCondition {
  type: 'has_media';
  value?: boolean;
}

export interface IsReplyCondition {
  type: 'is_reply';
  value?: boolean;
}

export interface TimeWindowCondition {
  type: 'time_window';
  start: string;
  end: string;
  daysOfWeek?: number[];
}

export interface SemanticTopicCondition {
  type: 'semantic_topic';
  description: string;
  threshold?: number;
}

export interface UrgencyCondition {
  type: 'urgency';
  minimumLevel: MonitorUrgencyLevel;
  semantic?: boolean;
}

export type MonitorCondition =
  | MentionedOwnerCondition
  | MentionedJidCondition
  | KeywordCondition
  | PhraseCondition
  | RegexCondition
  | SenderCondition
  | MessageTypeCondition
  | HasMediaCondition
  | IsReplyCondition
  | TimeWindowCondition
  | SemanticTopicCondition
  | UrgencyCondition;

export interface MonitorActiveHours {
  start: string;
  end: string;
  daysOfWeek?: number[];
}

export interface MonitorRuleConfig {
  name: string;
  enabled: boolean;
  matchMode: MonitorMatchMode;
  conditions: MonitorCondition[];
  exclusions: MonitorCondition[];
  priority: MonitorPriority;
  tags: string[];
  timezone: string;
  activeHours?: MonitorActiveHours;
  quietHours?: MonitorActiveHours;
  retentionDays?: number;
}

export interface MonitorEnvelope {
  sessionId: string;
  groupJid: string;
  messageId: string;
  senderJid: string;
  senderLabel?: string;
  timestamp: number;
  type: string;
  body: string;
  mentionedJids: string[];
  hasMedia: boolean;
  media?: { mimetype?: string; filename?: string; size?: number; omitted?: boolean };
  isReply: boolean;
  fromMe: boolean;
  revoked?: boolean;
}

export interface MonitorUrgencyResult {
  level: MonitorUrgencyLevel;
  score: number;
  reasons: string[];
  requiresResponse: boolean;
  confidence: number;
}

export interface MonitorEvaluationResult {
  matched: boolean;
  candidate: boolean;
  evidence: string[];
  semanticConditions: MonitorSemanticCondition[];
  urgency: MonitorUrgencyResult;
}

export interface MonitorSemanticCondition {
  effect: 'include' | 'exclude';
  condition: MonitorCondition;
}

export type MonitorEnrollmentMode = 'qr' | 'pairing_code';
export type MonitorEnrollmentState =
  | 'unconfigured'
  | 'starting'
  | 'challenge_ready'
  | 'waiting_for_scan'
  | 'connecting'
  | 'authenticated'
  | 'expired'
  | 'cancelled'
  | 'logged_out'
  | 'error';
