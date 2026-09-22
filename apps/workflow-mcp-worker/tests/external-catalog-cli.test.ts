import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(appRoot, 'scripts/compile-workflows.ts');

describe('trusted external catalog CLI', () => {
  it('validates an external catalog and never overwrites bundled registry', async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'workflow-compiler-'));
    try {
      await writeFile(path.join(temp, 'external.yaml'), `
version: 1
id: external-catalog
name: External catalog
triggers:
  - type: manual
steps:
  read:
    uses: mcp.call
    with:
      connection: external
      tool: read
      arguments: {}
`);
      const policy = path.join(temp, 'policy.json');
      await writeFile(policy, JSON.stringify({
        revision: 1,
        connections: { external: { tools: { read: { effect: 'read' } } } }
      }));

      const args = ['--import', 'tsx', script,
        '--workflows-dir', temp, '--policy-snapshot', policy];
      const refusal = spawnSync(process.execPath, args, { cwd: appRoot, encoding: 'utf8' });
      expect(refusal.status).not.toBe(0);
      expect(refusal.stderr).toMatch(/requires --output/);

      const output = path.join(temp, 'registry.ts');
      const compiled = spawnSync(process.execPath, [...args, '--output', output], {
        cwd: appRoot, encoding: 'utf8'
      });
      expect(compiled.status, compiled.stderr).toBe(0);
      const generated = await readFile(output, 'utf8');
      expect(generated).toContain('external-catalog');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
