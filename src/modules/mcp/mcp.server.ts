import { ForbiddenException, HttpException, Logger, UnauthorizedException } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type RequestHandler, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { invokeTool } from '../../core/agent-tools/tool-invoker';
import type { ToolRegistryService } from '../../core/agent-tools/tool-registry.service';
import type { AuthService } from '../auth/auth.service';
import type { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { contentToolResult, handleToolError, jsonToolResult, smartToolResult } from './tool-result';
import type { KeyRateLimiter } from './mcp-rate-limit';
import { resolveClientIp } from '../../common/utils/ip';
import { resolveBodyLimit } from '../../config/bootstrap-security';
import { setRequestActor } from '../../common/services/request-context';
import {
  recordMcpAuthFailure,
  recordMcpRateLimit,
  recordMcpRequest,
  recordMcpValidationFailure,
} from '../../common/metrics/monitoring-metrics';

const logger = new Logger('McpServer');
const stableAliasRequest = Symbol('stableAliasRequest');
const stableAliasApiKey = Symbol('stableAliasApiKey');

type HttpAdapter = NonNullable<HttpAdapterHost['httpAdapter']>;
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Request-scoped context forwarded to the audit trail on an MCP auth failure (mirrors the REST guard). */
export interface McpRequestContext {
  ipAddress?: string;
  method?: string;
  path?: string;
}

type McpExecutionContext = McpRequestContext & { apiKeyOverride?: string };

/** Extract the raw API key from MCP request headers. Accepts X-Api-Key or Bearer token. */
function extractApiKey(extra: ToolExtra): string | undefined {
  const headers = extra.requestInfo?.headers ?? {};
  const xApiKey = headers['x-api-key'];
  if (xApiKey) {
    return Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
  }
  const auth = headers['authorization'];
  const authStr = Array.isArray(auth) ? auth[0] : auth;
  if (authStr?.toLowerCase().startsWith('bearer ')) {
    return authStr.slice(7).trim();
  }
  return undefined;
}

/**
 * Mirror the REST ApiKeyGuard's auth-failure audit trail for MCP. The MCP mount is raw Express (outside
 * the Nest guard pipeline), so without this a credential-probing flood against /mcp leaves no forensic
 * record. Records a WARN `API_KEY_AUTH_FAILED` for rejected/denied authentication attempts (401/403 only);
 * non-auth errors (e.g. a 400 from bad tool input) are NOT audited — parity with the REST guard, which
 * only records Unauthorized/Forbidden. Fire-and-forget; best-effort (AuditService swallows insert errors).
 */
export function auditMcpAuthFailure(
  auditService: Pick<AuditService, 'logWarn'> | undefined,
  error: unknown,
  reqContext: McpRequestContext,
): void {
  if (error instanceof UnauthorizedException || error instanceof ForbiddenException) {
    recordMcpAuthFailure();
    if (!auditService) return;
    void auditService.logWarn(AuditAction.API_KEY_AUTH_FAILED, {
      ipAddress: reqContext.ipAddress,
      method: reqContext.method,
      path: reqContext.path,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Read TRUSTED_PROXIES once as a list (shared by the pre-auth throttle and the audit IP resolver). */
function readTrustedProxies(): string[] {
  return (process.env.TRUSTED_PROXIES ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** Resolve the trusted-proxy-aware client IP + HTTP method/path for an audit record. */
function resolveReqContext(req: Request): McpRequestContext {
  return {
    ipAddress: resolveClientIp(req, readTrustedProxies()),
    method: req.method,
    path: (req as Request & { [stableAliasRequest]?: boolean })[stableAliasRequest] ? '/<stable-token>/mcp' : req.path,
  };
}

function readStableAlias(): { token: string; backendApiKey: string } | null {
  const token = (process.env.MCP_STABLE_URL_TOKEN ?? '').trim();
  const backendApiKey = (process.env.MCP_STABLE_BACKEND_API_KEY ?? '').trim();
  if (!token && !backendApiKey) return null;
  if (!token || !backendApiKey) {
    throw new Error('MCP_STABLE_URL_TOKEN and MCP_STABLE_BACKEND_API_KEY must be configured together');
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
    throw new Error('MCP_STABLE_URL_TOKEN must be 43-128 URL-safe high-entropy characters');
  }
  if (process.env.MCP_TOOL_PROFILE !== 'monitoring') {
    throw new Error('MCP_STABLE_URL_TOKEN requires MCP_TOOL_PROFILE=monitoring');
  }
  return { token, backendApiKey };
}

function createStableAliasAuth(
  config: { token: string; backendApiKey: string },
  auditService?: AuditService,
): RequestHandler {
  return (req, res, next) => {
    (req as Request & { [stableAliasRequest]?: boolean })[stableAliasRequest] = true;
    const presented = typeof req.params.mcpToken === 'string' ? req.params.mcpToken : '';
    const a = Buffer.from(presented);
    const b = Buffer.from(config.token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      auditMcpAuthFailure(auditService, new UnauthorizedException('Invalid stable MCP token'), resolveReqContext(req));
      res.status(404).end();
      return;
    }
    req.headers['x-api-key'] = config.backendApiKey;
    (req as Request & { [stableAliasApiKey]?: string })[stableAliasApiKey] = config.backendApiKey;
    delete req.headers.authorization;
    next();
  };
}

/**
 * Build the MCP server ONCE and register all tools from the registry.
 * The SDK's `registerTool` accepts `AnySchema` (z4.$ZodType) directly, so we
 * pass `tool.inputSchema` verbatim — no `.shape` extraction needed.
 */
function buildServer(
  registry: ToolRegistryService,
  authService: AuthService,
  rateLimiter: KeyRateLimiter,
  readOnly: boolean,
  profile: 'all' | 'monitoring',
  allowMonitorConfigWrites: boolean,
  allowEnrollmentWrites: boolean,
  serverInfo: { name: string; version: string },
  auditService: AuditService | undefined,
  reqContext: McpExecutionContext,
): McpServer {
  const server = new McpServer(
    { name: serverInfo.name, version: serverInfo.version },
    { capabilities: { tools: {}, logging: {} } },
  );

  const tools = registry.list({ readOnly, profile, allowMonitorConfigWrites, allowEnrollmentWrites });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        // The SDK's InputArgs is inferred from this property. Widening it to the whole
        // `ZodRawShapeCompat | AnySchema` constraint would collapse the callback type it derives, so
        // the cast names AnySchema exactly — which zod v4's $ZodType satisfies.
        inputSchema: tool.inputSchema as AnySchema,
        annotations: {
          readOnlyHint: tool.tier === 'read',
          destructiveHint: tool.destructive ?? false,
          idempotentHint: tool.idempotent ?? tool.tier === 'read',
        },
      },
      async (input: Record<string, unknown>, extra: ToolExtra) => {
        // The MCP SDK snapshots HTTP request metadata independently of Express, so a header injected
        // by the stable-alias middleware is not guaranteed to appear in extra.requestInfo. Carry the
        // already constant-time-validated backend credential in request-local state instead.
        const rawKey = reqContext.apiKeyOverride ?? extractApiKey(extra);
        try {
          const result = await invokeTool(
            tool,
            input,
            rawKey,
            authService,
            apiKey => {
              rateLimiter.check(apiKey.id);
              setRequestActor({ apiKeyId: apiKey.id, apiKeyName: apiKey.name, ipAddress: reqContext.ipAddress });
            },
            // onAuthFailure: mirror the REST ApiKeyGuard — record rejected/denied auth attempts (401/403
            // only) at the auth boundary so the audit trail covers MCP credential probing. Fires inside
            // invokeTool's auth phase (before the tool handler), so handler-thrown 403s are NOT mislabeled
            // as auth failures. Best-effort; success and non-auth errors skip this.
            error => auditMcpAuthFailure(auditService, error, reqContext),
            reqContext.ipAddress,
          );
          if (tool.resultDisposition === 'content') {
            return contentToolResult(result as Parameters<typeof contentToolResult>[0]);
          }
          return tool.resultDisposition === 'json'
            ? jsonToolResult(result as object)
            : smartToolResult(result as object);
        } catch (error) {
          if (error instanceof HttpException) {
            if (error.getStatus() === 429) recordMcpRateLimit();
            else if (error.getStatus() === 400) recordMcpValidationFailure();
          }
          return handleToolError(error);
        }
      },
    );
  }

  logger.log(`MCP server built with ${tools.length} tools (readOnly=${readOnly})`);
  return server;
}

export interface MountMcpServerOptions {
  basePath?: string;
  serverInfo?: { name: string; version: string };
  readOnly?: boolean;
}

/**
 * Mount the MCP Streamable-HTTP transport on the existing Nest/Express adapter
 * at `POST {basePath}` (default `/mcp`), single-port.
 *
 * Tool handlers are built ONCE at mount time (closure over registry/authService/rateLimiter).
 * Per-request: mint a fresh McpServer + StreamableHTTPServerTransport, handle, tear down.
 * Stateless (sessionIdGenerator: undefined) — no session map, no GET/DELETE reconnect.
 * Creating a new McpServer per request is safe and avoids the single-transport constraint;
 * tool registration is O(n) pure function calls with no I/O overhead.
 */
/**
 * Pre-auth, per-IP throttle for the raw-Express /mcp mount. The global Nest throttler doesn't cover this
 * mount (it bypasses the guard pipeline) and the per-key limiter only fires AFTER key validation — so a
 * missing/invalid/revoked key otherwise reaches a DB lookup unthrottled. This gates by resolved client IP
 * first and returns a JSON-RPC 429 directly (raw Express wouldn't convert a thrown HttpException).
 */
export function createIpThrottle(ipRateLimiter: KeyRateLimiter): RequestHandler {
  return (req, res, next) => {
    const ip = resolveClientIp(req, readTrustedProxies());
    try {
      ipRateLimiter.check(ip);
      next();
    } catch (err) {
      recordMcpRateLimit();
      const status = err instanceof HttpException ? err.getStatus() : 429;
      res.status(status).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: err instanceof Error ? err.message : 'MCP rate limit exceeded' },
        id: null,
      });
    }
  };
}

/**
 * Resolve the MCP read-only flag with a SECURE default: read-only unless the operator explicitly opts
 * out with MCP_READONLY=false. Previously an unset MCP_READONLY defaulted to read-WRITE, silently
 * exposing state-changing tools (send messages, group ops) to any MCP caller the moment MCP_ENABLED
 * was on. An explicit `options.readOnly` (tests / programmatic mounts) still wins.
 */
export function resolveMcpReadOnly(optionsReadOnly?: boolean): boolean {
  return optionsReadOnly ?? process.env.MCP_READONLY !== 'false';
}

export function resolveMcpToolProfile(): 'all' | 'monitoring' {
  return process.env.MCP_TOOL_PROFILE === 'monitoring' ? 'monitoring' : 'all';
}

export function resolveMonitorConfigWrites(): boolean {
  return process.env.MCP_MONITOR_CONFIG_WRITES === 'true';
}

export function resolveEnrollmentWrites(): boolean {
  return process.env.MCP_ENROLLMENT_WRITES === 'true';
}

export function mountMcpServer(
  httpAdapter: HttpAdapter,
  registry: ToolRegistryService,
  authService: AuthService,
  rateLimiter: KeyRateLimiter,
  ipRateLimiter: KeyRateLimiter,
  options: MountMcpServerOptions = {},
  auditService?: AuditService,
): void {
  const basePath = (options.basePath ?? '/mcp').replace(/\/$/, '') || '/mcp';
  const serverInfo = options.serverInfo ?? { name: 'openwa', version: '0.0.0' };
  const readOnly = resolveMcpReadOnly(options.readOnly);
  const profile = resolveMcpToolProfile();
  const allowMonitorConfigWrites = resolveMonitorConfigWrites();
  const allowEnrollmentWrites = resolveEnrollmentWrites();

  // Eagerly compute the tool list at mount time to validate the registry is populated
  // and to emit the log line once. The actual McpServer is re-created per request to
  // avoid the SDK's single-transport-at-a-time constraint under concurrent load.
  const tools = registry.list({ readOnly, profile, allowMonitorConfigWrites, allowEnrollmentWrites });
  logger.log(`MCP server mounted at POST ${basePath} (${tools.length} tools)`);

  const handler: RequestHandler = async (req: Request, res: Response) => {
    const startedAt = Date.now();
    let requestRecorded = false;
    const recordRequest = (): void => {
      if (requestRecorded) return;
      requestRecorded = true;
      recordMcpRequest(Date.now() - startedAt);
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const server = buildServer(
      registry,
      authService,
      rateLimiter,
      readOnly,
      profile,
      allowMonitorConfigWrites,
      allowEnrollmentWrites,
      serverInfo,
      auditService,
      {
        ...resolveReqContext(req),
        apiKeyOverride: (req as Request & { [stableAliasApiKey]?: string })[stableAliasApiKey],
      },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      res.on('close', () => {
        recordRequest();
        void transport.close();
        void server.close();
      });
      res.on('finish', recordRequest);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('Error handling MCP request', error instanceof Error ? error.name : 'UnknownError');
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  };

  const adapter = httpAdapter as unknown as { post: (path: string, ...handlers: RequestHandler[]) => unknown };
  // The route throttle gates the auth DB lookup and per-request MCP server/transport construction. The
  // process-wide capped json() in main.ts runs first for all routes; this route-level parser is a
  // defensive fallback and no-ops once the global parser has consumed the body.
  // `inflate: false` matches the global parsers: a compressed body is refused by the budget
  // middleware long before this runs, and this keeps the fallback from becoming the one parser that
  // would still gunzip an unaccounted body if that ordering ever changed.
  // `limit` mirrors the same global cap for the same reason: without it a middleware reorder would
  // silently leave this mount uncapped.
  const bodyLimit = resolveBodyLimit(process.env.BODY_SIZE_LIMIT);
  adapter.post(basePath, createIpThrottle(ipRateLimiter), express.json({ limit: bodyLimit, inflate: false }), handler);
  const stableAlias = readStableAlias();
  if (stableAlias) {
    adapter.post(
      '/:mcpToken/mcp',
      createIpThrottle(ipRateLimiter),
      createStableAliasAuth(stableAlias, auditService),
      express.json({ limit: bodyLimit, inflate: false }),
      handler,
    );
  }
}
