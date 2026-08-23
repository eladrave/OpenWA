// archiver v8 is ESM-only; stub it so ts-jest can load the module graph.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

// Enable the MCP server before AppModule is imported.
process.env.MCP_ENABLED = 'true';
process.env.MCP_READONLY = 'true';
process.env.MCP_TOOL_PROFILE = 'monitoring';
process.env.MCP_MONITOR_CONFIG_WRITES = 'true';
process.env.MCP_ENROLLMENT_WRITES = 'true';
process.env.MCP_RATE_LIMIT_MAX = '2';

import { Test, TestingModule } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { applyGlobalValidation } from '../src/config/app-validation';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthService } from '../src/modules/auth/auth.service';
import { ApiKeyRole } from '../src/modules/auth/entities/api-key.entity';
import { Session, SessionStatus } from '../src/modules/session/entities/session.entity';

// --- MCP protocol helpers ---

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

function jsonRpcRequest(method: string, params: Record<string, unknown> = {}, id = 1) {
  return { jsonrpc: '2.0', method, params, id };
}

/**
 * Parse the MCP response. The StreamableHTTP transport sends:
 *   - `text/event-stream` SSE for normal requests (tools/list, tools/call)
 *   - `application/json` directly for some responses
 *
 * Supertest parses `application/json` into `.body`. For SSE, `.body` is empty
 * and the actual content is in `.text` (raw string). We try both.
 */
function parseMcpResponse(res: { body: unknown; text: string }): Record<string, unknown> {
  // If supertest parsed JSON, body will be a non-empty object
  if (typeof res.body === 'object' && res.body !== null && Object.keys(res.body).length > 0) {
    return res.body as Record<string, unknown>;
  }
  // SSE format: "event: message\ndata: {...}\n\n" — extract the data line
  const text = res.text ?? '';
  const match = /^data:\s*(.+)$/m.exec(text);
  if (match) {
    return JSON.parse(match[1]) as Record<string, unknown>;
  }
  // Plain JSON text fallback
  if (text.trim().startsWith('{')) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  return {};
}

// --- Test suite ---

describe('MCP server (e2e)', () => {
  let app: INestApplication<App>;
  let scopedKey: string;
  let rateKey: string;
  const sessionOne = '11111111-1111-4111-a111-111111111111';
  const sessionTwo = '22222222-2222-4222-a222-222222222222';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    const dataSource = app.get<DataSource>(getDataSourceToken('data'));
    const sessions = dataSource.getRepository(Session);
    for (const [id, name] of [
      [sessionOne, 'mcp-monitor-one'],
      [sessionTwo, 'mcp-monitor-two'],
    ] as const) {
      await sessions.save(
        sessions.create({
          id,
          name,
          status: SessionStatus.CREATED,
          phone: null,
          pushName: null,
          config: {},
          proxyUrl: null,
          proxyType: null,
          connectedAt: null,
          lastActiveAt: null,
          nodeId: null,
          claimedAt: null,
          nodeUrl: null,
          leaseExpiresAt: null,
        }),
      );
    }
    const auth = app.get(AuthService);
    scopedKey = (
      await auth.createApiKey({
        name: 'MCP scoped test key',
        role: ApiKeyRole.OPERATOR,
        allowedSessions: [sessionOne],
      })
    ).rawKey;
    rateKey = (
      await auth.createApiKey({
        name: 'MCP rate test key',
        role: ApiKeyRole.OPERATOR,
        allowedSessions: [sessionOne],
      })
    ).rawKey;
  }, 30_000);

  afterAll(async () => {
    try {
      await app?.close();
    } catch {
      /* ignore TypeORM multi-datasource teardown quirk */
    }
  });

  // ---------------------------------------------------------------------------
  // 1. MCP endpoint is reachable — initialize succeeds
  // ---------------------------------------------------------------------------
  it('POST /mcp with initialize request responds with 200', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set(MCP_HEADERS)
      .send(
        jsonRpcRequest('initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '0.0.1' },
        }),
      );

    expect([200, 202]).toContain(res.status);
  });

  // ---------------------------------------------------------------------------
  // 2. tools/list returns the tool catalogue with known names
  // ---------------------------------------------------------------------------
  it('tools/list returns the tool catalogue', async () => {
    const res = await request(app.getHttpServer()).post('/mcp').set(MCP_HEADERS).send(jsonRpcRequest('tools/list'));

    expect(res.status).toBe(200);
    const body = parseMcpResponse(res);
    const result = body.result as Record<string, unknown> | undefined;
    expect(result).toBeDefined();
    const tools = result?.tools as Array<{ name: string }> | undefined;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools!.length).toBeGreaterThan(0);
    // Verify well-known tools are present
    const names = tools!.map(t => t.name);
    expect(names).toHaveLength(21);
    expect(names).toContain('WhatsAppAuthGetStatus');
    expect(names).toContain('MonitorGetDigestBatch');
    expect(names).toContain('MonitorUpsertRule');
    expect(names).not.toContain('SessionFindAll');
    expect(names).not.toContain('MessageSendText');
    expect(names).not.toContain('GroupGetInviteCode');
  });

  // ---------------------------------------------------------------------------
  // 3. tools/call without API key returns an error tool result
  //    (auth is protocol-level: tool errors surface as isError=true, not HTTP 401)
  // ---------------------------------------------------------------------------
  it('tools/call without API key returns isError tool result', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set(MCP_HEADERS)
      .send(
        jsonRpcRequest('tools/call', {
          name: 'WhatsAppAuthListSessions',
          arguments: {},
        }),
      );

    expect(res.status).toBe(200);
    const body = parseMcpResponse(res);
    // The tool handler catches UnauthorizedException and routes through handleToolError,
    // returning a tool result with isError=true.
    const result = body.result as Record<string, unknown> | undefined;
    expect(result?.isError).toBe(true);
    const content = result?.content as Array<{ type: string; text?: string }> | undefined;
    expect(Array.isArray(content)).toBe(true);
    const text = content?.find(c => c.type === 'text')?.text ?? '';
    expect(text).toMatch(/unauthorized|missing api key/i);
  });

  // ---------------------------------------------------------------------------
  // 4. Unsupported Content-Type → 415
  // ---------------------------------------------------------------------------
  it('POST /mcp with wrong Content-Type returns 415', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set({ 'Content-Type': 'text/plain', Accept: 'application/json, text/event-stream' })
      .send('{}');

    expect(res.status).toBe(415);
  });

  // ---------------------------------------------------------------------------
  // 5. Focused profile keeps generic WhatsApp writes hidden while independently gated local writes load.
  // ---------------------------------------------------------------------------
  it('MCP_READONLY=true plus monitoring gates never publishes generic WhatsApp writes', async () => {
    const res = await request(app.getHttpServer()).post('/mcp').set(MCP_HEADERS).send(jsonRpcRequest('tools/list'));
    const body = parseMcpResponse(res);
    const tools = (body.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map(tool => tool.name);
    expect(names).toContain('MonitorSetGroup');
    expect(names).toContain('WhatsAppAuthBegin');
    expect(names).not.toContain('MessageSendText');
    expect(names).not.toContain('ContactBlock');
    expect(names).not.toContain('GroupCreate');
  });

  // ---------------------------------------------------------------------------
  // 6. Post-auth per-principal limiter, injected with a tiny e2e limit.
  // ---------------------------------------------------------------------------
  it('rate limiter returns an in-band error after the configured per-key cap', async () => {
    const call = () =>
      request(app.getHttpServer())
        .post('/mcp')
        .set(MCP_HEADERS)
        .set('Authorization', `Bearer ${rateKey}`)
        .send(jsonRpcRequest('tools/call', { name: 'WhatsAppAuthGetStatus', arguments: { sessionId: sessionOne } }));
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const limited = parseMcpResponse(await call());
    const result = limited.result as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    expect(result.content?.[0].text).toMatch(/rate limit/i);
  });

  // ---------------------------------------------------------------------------
  // 7. Session-scoped key scoping over a DB-only status tool (no real WhatsApp needed).
  // ---------------------------------------------------------------------------
  it('session-scoped key calling another session is rejected before the handler', async () => {
    const res = await request(app.getHttpServer())
      .post('/mcp')
      .set(MCP_HEADERS)
      .set('X-API-Key', scopedKey)
      .send(
        jsonRpcRequest('tools/call', {
          name: 'WhatsAppAuthGetStatus',
          arguments: { sessionId: sessionTwo },
        }),
      );
    expect(res.status).toBe(200);
    const result = parseMcpResponse(res).result as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    expect(result.content?.[0].text).toMatch(/not authorized|unauthorized/i);
  });
});
