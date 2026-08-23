import { evaluateMonitorRule } from './monitoring.evaluator';
import { monitorRuleConfigSchema } from './monitoring.schemas';
import type { MonitorEnvelope, MonitorRuleConfig } from './monitoring.types';

const envelope = (over: Partial<MonitorEnvelope> = {}): MonitorEnvelope => ({
  sessionId: 'session-1',
  groupJid: '120363000@g.us',
  messageId: 'message-1',
  senderJid: '15550001111@c.us',
  timestamp: Date.parse('2026-08-23T12:00:00Z') / 1000,
  type: 'text',
  body: 'Urgent: outage deadline today, please respond',
  mentionedJids: ['15559990000@s.whatsapp.net'],
  hasMedia: false,
  isReply: false,
  fromMe: false,
  ...over,
});

const rule = (over: Partial<MonitorRuleConfig> = {}): MonitorRuleConfig => ({
  name: 'test',
  enabled: true,
  matchMode: 'all',
  conditions: [{ type: 'mentioned_owner' }],
  exclusions: [],
  priority: 'normal',
  tags: [],
  timezone: 'UTC',
  ...over,
});

describe('monitoring rule evaluator', () => {
  it('matches the owner through structured, neutralized mentionedIds', () => {
    const result = evaluateMonitorRule(rule(), envelope(), '15559990000@c.us');
    expect(result.matched).toBe(true);
    expect(result.evidence).toContain('mentioned_owner via mentionedIds');
  });

  it('supports any/all composition, whole-word keywords, and exclusions', () => {
    const any = evaluateMonitorRule(
      rule({
        matchMode: 'any',
        conditions: [
          { type: 'keyword', values: ['not-present'] },
          { type: 'keyword', values: ['outage'], wholeWord: true },
        ],
      }),
      envelope(),
      null,
    );
    expect(any.matched).toBe(true);

    const excluded = evaluateMonitorRule(
      rule({
        conditions: [{ type: 'keyword', values: ['outage'] }],
        exclusions: [{ type: 'sender', jids: ['15550001111@c.us'] }],
      }),
      envelope(),
      null,
    );
    expect(excluded.matched).toBe(false);
  });

  it('returns semantic topic and semantic urgency as candidates, never fabricated matches', () => {
    const result = evaluateMonitorRule(
      rule({
        conditions: [
          { type: 'semantic_topic', description: 'customer churn risk', threshold: 0.8 },
          { type: 'urgency', minimumLevel: 'critical', semantic: true },
        ],
      }),
      envelope({ body: 'A nuanced message without deterministic emergency words', mentionedJids: [] }),
      null,
    );
    expect(result.matched).toBe(false);
    expect(result.candidate).toBe(true);
    expect(result.semanticConditions).toHaveLength(2);
    expect(result.semanticConditions.every(item => item.effect === 'include')).toBe(true);
  });

  it('preserves semantic exclusion polarity for client assessment', () => {
    const result = evaluateMonitorRule(
      rule({
        conditions: [{ type: 'keyword', values: ['outage'] }],
        exclusions: [{ type: 'semantic_topic', description: 'planned maintenance notice' }],
      }),
      envelope(),
      null,
    );
    expect(result.candidate).toBe(true);
    expect(result.semanticConditions).toEqual([
      {
        effect: 'exclude',
        condition: { type: 'semantic_topic', description: 'planned maintenance notice' },
      },
    ]);
  });

  it('short-circuits an any-mode semantic include after a deterministic condition matches', () => {
    const result = evaluateMonitorRule(
      rule({
        matchMode: 'any',
        conditions: [
          { type: 'keyword', values: ['outage'] },
          { type: 'semantic_topic', description: 'a topic that need not be assessed' },
        ],
      }),
      envelope(),
      null,
    );
    expect(result).toMatchObject({ matched: true, candidate: false, semanticConditions: [] });
  });

  it('applies overnight quiet hours, with an explicit critical-priority override', () => {
    const quiet = { start: '22:00', end: '07:00' };
    const atNight = envelope({ timestamp: Date.parse('2026-08-23T23:00:00Z') / 1000 });
    expect(evaluateMonitorRule(rule({ quietHours: quiet }), atNight, '15559990000@c.us').matched).toBe(false);
    const critical = evaluateMonitorRule(
      rule({ quietHours: quiet, priority: 'critical' }),
      atNight,
      '15559990000@c.us',
    );
    expect(critical.matched).toBe(true);
    expect(critical.evidence).toContain('critical priority overrode quiet hours');
  });

  it('computes concise deterministic urgency evidence without claiming certainty', () => {
    const result = evaluateMonitorRule(rule(), envelope(), '15559990000@c.us');
    expect(result.urgency.score).toBeGreaterThanOrEqual(80);
    expect(result.urgency.level).toBe('critical');
    expect(result.urgency.confidence).toBeLessThan(1);
  });
});

describe('monitoring rule schema', () => {
  it('rejects unsupported regex features, oversized input, and invalid timezones', () => {
    expect(() => monitorRuleConfigSchema.parse(rule({ conditions: [{ type: 'regex', pattern: '(a)\\1' }] }))).toThrow(
      /RE2/i,
    );
    expect(() => monitorRuleConfigSchema.parse(rule({ timezone: 'Not/AZone' }))).toThrow(/IANA/i);
    expect(() =>
      monitorRuleConfigSchema.parse(rule({ conditions: [{ type: 'keyword', values: ['x'.repeat(101)] }] })),
    ).toThrow();
  });

  it('evaluates formerly catastrophic patterns through non-backtracking RE2', () => {
    const parsed = monitorRuleConfigSchema.parse(rule({ conditions: [{ type: 'regex', pattern: '(a|aa)+$' }] }));
    const started = Date.now();
    const result = evaluateMonitorRule(parsed, envelope({ body: `${'a'.repeat(4095)}!`, mentionedJids: [] }), null);
    expect(result.matched).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('applies bounded defaults to a valid rule', () => {
    const parsed = monitorRuleConfigSchema.parse({ name: 'mentions', conditions: [{ type: 'mentioned_owner' }] });
    expect(parsed).toMatchObject({ enabled: true, matchMode: 'all', priority: 'normal', timezone: 'UTC' });
  });
});
