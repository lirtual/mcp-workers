import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CORE_WORKERS = [
  'ima-mcp-worker',
  'openlist-mcp-worker',
  'weread-mcp-worker',
  'database-mcp-worker',
  'raindrop-mcp-worker',
  'instapaper-mcp-worker',
  'workflow-mcp-worker'
] as const;

const appsRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

describe('shared MCP entry token contract', () => {
  it('requires MCP_ACCESS_TOKEN on exactly the seven core Workers with no alias', async () => {
    for (const worker of CORE_WORKERS) {
      const wranglerPath = path.join(appsRoot, worker, 'wrangler.jsonc');
      const wrangler = JSON.parse(await readFile(wranglerPath, 'utf8')) as {
        secrets?: { required?: string[] };
      };
      const required = wrangler.secrets?.required ?? [];
      expect(required, worker).toContain('MCP_ACCESS_TOKEN');
      expect(
        required.filter(name => name.includes('MCP_ACCESS_TOKEN')),
        worker
      ).toEqual(['MCP_ACCESS_TOKEN']);
      expect(required).not.toContain('WORKFLOW_MCP_ACCESS_TOKEN');

      const sources = await collectTs(path.join(appsRoot, worker, 'src'));
      expect(sources.some(source => source.includes('MCP_ACCESS_TOKEN')), worker).toBe(true);
      expect(sources.some(source => source.includes('WORKFLOW_MCP_ACCESS_TOKEN')), worker).toBe(
        false
      );
    }
  });
});

async function collectTs(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTs(full)));
    else if (entry.name.endsWith('.ts')) files.push(await readFile(full, 'utf8'));
  }
  return files;
}
