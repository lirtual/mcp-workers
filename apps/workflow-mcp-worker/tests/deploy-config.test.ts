import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const validEnv = {
  WORKFLOW_MCP_WORKER_NAME: 'workflow-mcp-worker',
  WORKFLOW_MCP_D1_DATABASE_NAME: 'workflow-mcp',
  WORKFLOW_MCP_D1_DATABASE_ID: '238891f8-4007-4436-890d-819d54e3e01b',
  WORKFLOW_MCP_R2_BUCKET: 'workflow-mcp-artifacts',
  WORKFLOW_MCP_URL: 'https://workflow-mcp-worker.aiyaya.workers.dev',
  CLOUDFLARE_ACCOUNT_ID: '8bb496011403552e785ea1b834daffdf',
  GITHUB_REPOSITORY: 'lirtual/mcp-workers',
  GITHUB_REPOSITORY_ID: '1371085786'
};

async function generate(overrides: Record<string, string> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'workflow-deploy-config-'));
  const output = path.join(dir, 'wrangler.json');
  const env = { ...process.env, ...validEnv, ...overrides };
  const execution = spawnSync(
    'pnpm', ['exec', 'tsx', 'scripts/build-deploy-config.ts', output],
    { cwd: process.cwd(), env, encoding: 'utf8' }
  );
  const config = execution.status === 0
    ? JSON.parse(await readFile(output, 'utf8')) as Record<string, unknown>
    : undefined;
  await rm(dir, { recursive: true, force: true });
  return { execution, config };
}

describe('Workflow MCP deploy configuration expansion', () => {
  it('derives deployment identity from the actual GitHub and Cloudflare context', async () => {
    const { execution, config } = await generate();
    expect(execution.status).toBe(0);
    expect(config?.vars).toMatchObject({
      GITHUB_REPOSITORY: 'lirtual/mcp-workers',
      GITHUB_REPOSITORY_ID: '1371085786',
      R2_ACCOUNT_ID: '8bb496011403552e785ea1b834daffdf',
      R2_BUCKET_NAME: 'workflow-mcp-artifacts',
      SMOKE_MODERN_MCP_ENDPOINT: 'https://workflow-mcp-worker.aiyaya.workers.dev/mcp'
    });
    expect(config?.vars).not.toHaveProperty('GITHUB_OIDC_ISSUER');
    expect(config?.vars).not.toHaveProperty('GITHUB_EXECUTOR_REF');
    expect(config?.r2_buckets).toEqual([
      { binding: 'ARTIFACTS', bucket_name: 'workflow-mcp-artifacts' }
    ]);
    expect(config?.triggers).toEqual({ crons: [] }); // T17 owns schedule activation.
  });

  it('rejects missing or malformed identity before producing a deployment config', async () => {
    for (const [name, value] of [
      ['GITHUB_REPOSITORY', ''],
      ['GITHUB_REPOSITORY_ID', 'not-an-id'],
      ['CLOUDFLARE_ACCOUNT_ID', 'wrong-account'],
      ['WORKFLOW_MCP_R2_BUCKET', 'Invalid_Bucket']
    ] as const) {
      const { execution, config } = await generate({ [name]: value });
      expect(execution.status, name).not.toBe(0);
      expect(config, name).toBeUndefined();
    }
  });
});
