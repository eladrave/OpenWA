import { randomUUID } from 'node:crypto';
import { HttpException, Logger } from '@nestjs/common';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface DirectContentResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' }>;
}

const logger = new Logger('Mcp');

/**
 * Format a tool result, inlining small payloads as text and offloading large
 * ones (> 4 KB) to an embedded base64 resource so the response stays compact.
 */
export function smartToolResult(data: string | object | object[]): CallToolResult {
  // JSON.stringify(undefined) is undefined, not a string — a handler that resolves void would turn
  // a completed write into a thrown TypeError here, reported to the agent as a failure it retries.
  const text = typeof data === 'string' ? data : (JSON.stringify(data) ?? 'null');
  const mimeType = typeof data === 'string' ? 'text/plain' : 'application/json';
  const ext = typeof data === 'string' ? 'txt' : 'json';
  if (text.length > 4096) {
    const uri = `mcp://toolResult/${randomUUID()}.${ext}`;
    const buffer = Buffer.from(text);
    return {
      content: [
        { type: 'text', text: `Received resource ${uri} with ${buffer.byteLength} bytes` },
        { type: 'resource', resource: { uri, mimeType, blob: buffer.toString('base64') } },
      ],
    };
  }
  return { content: [{ type: 'text', text }] };
}

/** Format a tool result as compact JSON text. */
export function jsonToolResult(data: object, isError = false): CallToolResult {
  const result: CallToolResult = { content: [{ type: 'text', text: JSON.stringify(data) }] };
  if (isError) {
    result.isError = true;
  }
  return result;
}

/** Validate and forward protocol-neutral direct content, used only for short-lived enrollment images. */
export function contentToolResult(data: DirectContentResult): CallToolResult {
  if (!data || !Array.isArray(data.content) || data.content.length === 0) {
    throw new Error('Invalid direct tool content');
  }
  const content: CallToolResult['content'] = data.content.map(item => {
    if (item.type === 'text') return { type: 'text', text: item.text.slice(0, 4096) };
    if (item.mimeType !== 'image/png' || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data)) {
      throw new Error('Invalid enrollment image');
    }
    const decoded = Buffer.from(item.data, 'base64');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (decoded.byteLength === 0 || decoded.byteLength > 512 * 1024 || !decoded.subarray(0, 8).equals(png)) {
      throw new Error('Invalid enrollment PNG');
    }
    return { type: 'image', data: item.data, mimeType: 'image/png' };
  });
  return { content };
}

/**
 * Map a thrown error to a tool-error result. Raw messages, stack traces, and thrown values are not
 * logged because a provider/validation error can contain message data, identifiers, or credentials.
 * Log only the bounded error class; never put server internals on the wire either.
 *
 * HttpExceptions carry client-safe messages (they mirror REST error responses).
 * All other errors get a generic wire message to avoid leaking internals.
 */
export function handleToolError(error: unknown): CallToolResult {
  if (error instanceof HttpException) {
    logger.error('MCP tool request failed', error.name);
    const res = error.getResponse();
    const message =
      typeof res === 'object' && res !== null && 'message' in res
        ? (res as Record<string, unknown>)['message']
        : error.message;
    const code =
      typeof res === 'object' &&
      res !== null &&
      'code' in res &&
      typeof (res as Record<string, unknown>).code === 'string'
        ? (res as Record<string, unknown>).code
        : undefined;
    const retryable =
      typeof res === 'object' &&
      res !== null &&
      'retryable' in res &&
      typeof (res as Record<string, unknown>).retryable === 'boolean'
        ? (res as Record<string, unknown>).retryable
        : undefined;
    return jsonToolResult(
      {
        success: false,
        name: error.name,
        ...(code ? { code } : {}),
        message,
        ...(retryable != null ? { retryable } : {}),
      },
      true,
    );
  }
  if (error instanceof Error) {
    logger.error('MCP tool request failed', error.name);
    return jsonToolResult({ success: false, name: error.name, message: 'Internal error' }, true);
  }
  logger.error('MCP tool request failed', 'UnknownError');
  return jsonToolResult({ success: false, name: 'Unknown error', message: 'Internal error' }, true);
}
