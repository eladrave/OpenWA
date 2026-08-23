import * as fs from 'fs';
import * as path from 'path';
import { resolveMcpReadOnly } from './mcp.server';
import { allAgentTools } from '../../core/agent-tools/tools';

/**
 * README described the MCP surface as write-enabled by default and never mentioned the knob that
 * enables it. `resolveMcpReadOnly` defaults to READ-ONLY unless `MCP_READONLY` is the literal
 * string 'false' — the secure default a code comment says was deliberately chosen — so an operator
 * following README wired a client, saw no send/reply/group tools, and had nothing in README to point
 * them at. In the other direction it misstated the shipped security posture.
 *
 * The counts are derived from the tool sources here, so a tier change fails this instead of quietly
 * making the prose wrong again.
 */
const repoRoot = path.join(__dirname, '..', '..', '..');
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

function tierCounts(): { read: number; write: number } {
  const tools = allAgentTools({} as never);
  return {
    read: tools.filter(tool => tool.tier === 'read').length,
    write: tools.filter(tool => tool.tier === 'write').length,
  };
}

describe('README describes the MCP surface the code actually mounts', () => {
  // Guards the counts below: an extractor that matched nothing would make every assertion vacuous.
  it('counts both tiers from the tool sources', () => {
    const { read, write } = tierCounts();
    expect(read).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(0);
  });

  it('mounts read-only unless MCP_READONLY is explicitly "false"', () => {
    const prev = process.env.MCP_READONLY;
    try {
      delete process.env.MCP_READONLY;
      expect(resolveMcpReadOnly()).toBe(true);
      process.env.MCP_READONLY = 'true';
      expect(resolveMcpReadOnly()).toBe(true);
      process.env.MCP_READONLY = 'false';
      expect(resolveMcpReadOnly()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.MCP_READONLY;
      else process.env.MCP_READONLY = prev;
    }
  });

  it('states the DEFAULT tool count, not just the total', () => {
    const { read } = tierCounts();
    expect(readme).toContain(`${read} read-only tools`);
  });

  it('names the knob that unlocks the write tier', () => {
    const { read, write } = tierCounts();
    expect(readme).toContain('MCP_READONLY=false');
    expect(readme).toContain(`${read + write} tools`);
  });
});
