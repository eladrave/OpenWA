import { z } from 'zod';
import { compileMonitorRegex } from './monitoring.regex';
import {
  MONITOR_CONDITIONS_PER_RULE_MAX,
  MONITOR_KEYWORD_LENGTH_MAX,
  MONITOR_KEYWORDS_PER_CONDITION_MAX,
  MONITOR_MESSAGE_TYPES,
  MONITOR_REGEX_LENGTH_MAX,
  MONITOR_RETENTION_DAYS_MAX,
  MONITOR_SEMANTIC_DESCRIPTION_MAX,
  MONITOR_TAGS_MAX,
} from './monitoring.types';

const jid = z.string().trim().min(1).max(191);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm in 24-hour time');
const days = z.array(z.number().int().min(0).max(6)).min(1).max(7).optional();

const mentionedOwner = z.object({ type: z.literal('mentioned_owner') }).strict();
const mentionedJid = z.object({ type: z.literal('mentioned_jid'), jids: z.array(jid).min(1).max(50) }).strict();
const keyword = z
  .object({
    type: z.literal('keyword'),
    values: z
      .array(z.string().trim().min(1).max(MONITOR_KEYWORD_LENGTH_MAX))
      .min(1)
      .max(MONITOR_KEYWORDS_PER_CONDITION_MAX),
    caseSensitive: z.boolean().optional(),
    wholeWord: z.boolean().optional(),
  })
  .strict();
const phrase = z
  .object({
    type: z.literal('phrase'),
    value: z.string().trim().min(1).max(500),
    caseSensitive: z.boolean().optional(),
    normalizeWhitespace: z.boolean().optional(),
  })
  .strict();
const regex = z
  .object({
    type: z.literal('regex'),
    pattern: z.string().min(1).max(MONITOR_REGEX_LENGTH_MAX),
    flags: z
      .string()
      .regex(/^[imu]*$/, 'Only i, m, and u flags are allowed')
      .refine(value => new Set(value).size === value.length, 'Regex flags must not be repeated')
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      void compileMonitorRegex(value.pattern, value.flags);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pattern'],
        message: 'Invalid or unsupported RE2 regular expression',
      });
    }
  });
const sender = z
  .object({ type: z.literal('sender'), jids: z.array(jid).min(1).max(50), mode: z.enum(['allow', 'deny']).optional() })
  .strict();
const messageType = z
  .object({
    type: z.literal('message_type'),
    types: z.array(z.enum(MONITOR_MESSAGE_TYPES)).min(1).max(MONITOR_MESSAGE_TYPES.length),
  })
  .strict();
const hasMedia = z.object({ type: z.literal('has_media'), value: z.boolean().optional() }).strict();
const isReply = z.object({ type: z.literal('is_reply'), value: z.boolean().optional() }).strict();
const timeWindow = z.object({ type: z.literal('time_window'), start: time, end: time, daysOfWeek: days }).strict();
const semanticTopic = z
  .object({
    type: z.literal('semantic_topic'),
    description: z.string().trim().min(1).max(MONITOR_SEMANTIC_DESCRIPTION_MAX),
    threshold: z.number().min(0).max(1).optional(),
  })
  .strict();
const urgency = z
  .object({
    type: z.literal('urgency'),
    minimumLevel: z.enum(['none', 'low', 'medium', 'high', 'critical']),
    semantic: z.boolean().optional(),
  })
  .strict();

export const monitorConditionSchema = z.discriminatedUnion('type', [
  mentionedOwner,
  mentionedJid,
  keyword,
  phrase,
  regex,
  sender,
  messageType,
  hasMedia,
  isReply,
  timeWindow,
  semanticTopic,
  urgency,
]);

export const monitorHoursSchema = z.object({ start: time, end: time, daysOfWeek: days }).strict();

const timezone = z
  .string()
  .min(1)
  .max(64)
  .superRefine((value, ctx) => {
    try {
      void new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a valid IANA timezone' });
    }
  });

export const monitorRuleConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean().default(true),
    matchMode: z.enum(['any', 'all']).default('all'),
    conditions: z.array(monitorConditionSchema).min(1).max(MONITOR_CONDITIONS_PER_RULE_MAX),
    exclusions: z.array(monitorConditionSchema).max(MONITOR_CONDITIONS_PER_RULE_MAX).default([]),
    priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
    tags: z.array(z.string().trim().min(1).max(50)).max(MONITOR_TAGS_MAX).default([]),
    timezone: timezone.default('UTC'),
    activeHours: monitorHoursSchema.optional(),
    quietHours: monitorHoursSchema.optional(),
    retentionDays: z.number().int().min(1).max(MONITOR_RETENTION_DAYS_MAX).optional(),
  })
  .strict();

export type MonitorRuleConfigInput = z.infer<typeof monitorRuleConfigSchema>;
