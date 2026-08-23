import { HttpException } from '@nestjs/common';
import { contentToolResult, handleToolError, smartToolResult } from './tool-result';

describe('smartToolResult', () => {
  it('inlines a small object as JSON text', () => {
    expect(smartToolResult({ id: 1 }).content).toEqual([{ type: 'text', text: '{"id":1}' }]);
  });

  it('passes a string payload through as plain text', () => {
    expect(smartToolResult('done').content).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('survives an undefined handler result instead of throwing after the write ran', () => {
    // JSON.stringify(undefined) is undefined; reading .length off it threw a TypeError that
    // handleToolError then reported as `Internal error` for an operation that had succeeded.
    const result = smartToolResult(undefined as unknown as object);
    expect(result.content).toEqual([{ type: 'text', text: 'null' }]);
  });

  it('offloads a payload over 4 KB to an embedded resource', () => {
    const big = { blob: 'x'.repeat(5000) };
    const result = smartToolResult(big);
    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe('text');
    expect(result.content[1]).toMatchObject({ type: 'resource', resource: { mimeType: 'application/json' } });
  });
});

describe('direct enrollment content', () => {
  it('returns a validated PNG as ImageContent without embedding it in text or a resource', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('test')]);
    const result = contentToolResult({
      content: [
        { type: 'text', text: '{"state":"waiting_for_scan"}' },
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      ],
    });
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(result.content.some(item => item.type === 'resource')).toBe(false);
    expect(JSON.stringify(result.content[0])).not.toContain(png.toString('base64'));
  });

  it('rejects a non-PNG direct image', () => {
    expect(() =>
      contentToolResult({
        content: [{ type: 'image', data: Buffer.from('not png').toString('base64'), mimeType: 'image/png' }],
      }),
    ).toThrow(/PNG/);
  });

  it('preserves safe stable HttpException codes', () => {
    const result = handleToolError(
      new HttpException({ statusCode: 409, code: 'CURSOR_CONFLICT', message: 'Cursor changed', retryable: true }, 409),
    );
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      code: 'CURSOR_CONFLICT',
      message: 'Cursor changed',
      retryable: true,
    });
  });
});
