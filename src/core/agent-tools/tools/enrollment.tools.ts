import { z } from 'zod';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import { EnrollmentService } from '../../../modules/monitoring/enrollment.service';
import { defineTool, type AnyToolDescriptor } from '../tool-descriptor';

const sessionId = z.string().uuid().describe('Exact OpenWA session UUID explicitly granted to this credential');
const scoped = { surface: 'monitoring' as const, sessionScoped: true, requiresExplicitSessionGrant: true };
const enrollmentWrite = {
  ...scoped,
  tier: 'write' as const,
  writeCapability: 'enrollment' as const,
  requiredRole: ApiKeyRole.OPERATOR,
};

export function enrollmentTools(enrollment: EnrollmentService): AnyToolDescriptor[] {
  return [
    defineTool({
      name: 'WhatsAppAuthListSessions',
      description:
        'List only the compact WhatsApp sessions explicitly granted to this monitoring credential; phone numbers are omitted.',
      tier: 'read',
      surface: 'monitoring',
      inputSchema: z.object({}).strict(),
      handler: (_input, apiKey) => enrollment.listSessions(apiKey),
    }),
    defineTool({
      name: 'WhatsAppAuthGetStatus',
      description: 'Get a finite, sanitized WhatsApp enrollment state for an explicitly granted session.',
      tier: 'read',
      ...scoped,
      inputSchema: z.object({ sessionId, flowId: z.string().uuid().optional() }).strict(),
      handler: (input, apiKey) => enrollment.getStatus(apiKey, input.sessionId, input.flowId),
    }),
    defineTool({
      name: 'WhatsAppAuthBegin',
      description:
        'Begin or resume one short-lived QR or explicitly requested pairing-code enrollment flow. Returns quickly and never returns engine credentials.',
      ...enrollmentWrite,
      idempotent: true,
      inputSchema: z.object({ sessionId, mode: z.enum(['qr', 'pairing_code']) }).strict(),
      handler: (input, apiKey) => enrollment.begin(apiKey, input.sessionId, input.mode),
    }),
    defineTool({
      name: 'WhatsAppAuthGetChallenge',
      description:
        'Retrieve the short-lived challenge for a bound enrollment flow. QR is returned as ImageContent; pairing code is sensitive and only generated when explicitly selected.',
      ...enrollmentWrite,
      resultDisposition: 'content',
      idempotent: true,
      inputSchema: z
        .object({ sessionId, flowId: z.string().uuid(), phoneNumber: z.string().min(8).max(32).optional() })
        .strict(),
      handler: (input, apiKey) => enrollment.getChallenge(apiKey, input.sessionId, input.flowId, input.phoneNumber),
    }),
    defineTool({
      name: 'WhatsAppAuthCancel',
      description: 'Cancel a short-lived enrollment flow and invalidate its in-memory challenge.',
      ...enrollmentWrite,
      idempotent: true,
      inputSchema: z.object({ sessionId, flowId: z.string().uuid() }).strict(),
      handler: (input, apiKey) => enrollment.cancel(apiKey, input.sessionId, input.flowId),
    }),
    defineTool({
      name: 'WhatsAppAuthDisconnect',
      description:
        'Destructively unlink the WhatsApp companion device and invalidate enrollment state. Requires explicit confirm=true.',
      ...enrollmentWrite,
      destructive: true,
      idempotent: false,
      inputSchema: z.object({ sessionId, confirm: z.literal(true) }).strict(),
      handler: (input, apiKey) => enrollment.disconnect(apiKey, input.sessionId, input.confirm),
    }),
  ];
}
