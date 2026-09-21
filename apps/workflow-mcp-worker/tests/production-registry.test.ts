import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getWorkflowRegistry } from '../src/registry.js';

const FORBIDDEN = [
  'TRIGGER_SMOKE_WEBHOOK_TOKEN',
  'SMOKE_READONLY_MCP_TOKEN',
  'SMOKE_MODERN_MCP_ENDPOINT'
];

describe('production workflow registry membership', () => {
  it('omits dedicated smoke secrets and endpoints from the compiled production registry', async () => {
    const source = await readFile(
      new URL('../src/generated/workflow-registry.ts', import.meta.url),
      'utf8'
    );
    for (const name of FORBIDDEN) {
      expect(source).not.toContain(name);
    }
    const ids = getWorkflowRegistry().map(entry => entry.metadata.id);
    expect(ids).not.toContain('trigger-http-smoke');
    expect(ids).not.toContain('mcp-connection-smoke');
    expect(ids).toEqual(['local-http-smoke', 'raindrop-daily-snapshot', 'sequential-http-smoke', 'web-archive-smoke']);
    expect(JSON.stringify(getWorkflowRegistry())).not.toContain('MCP_ACCESS_TOKEN');
  });
});
