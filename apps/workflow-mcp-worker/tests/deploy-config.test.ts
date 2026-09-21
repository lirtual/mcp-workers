import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  buildWorkflowDeployConfig,
  readWorkflowDeployContext,
  type WranglerDeployConfig
} from '../src/deploy-config.js';
import { CANONICAL_SCHEDULER_CRON } from '../src/platform-config.js';

const validContext = {
  WORKFLOW_MCP_WORKER_NAME: 'workflow-mcp-worker',
  WORKFLOW_MCP_D1_DATABASE_NAME: 'workflow-mcp',
  WORKFLOW_MCP_D1_DATABASE_ID: '238891f8-4007-4436-890d-819d54e3e01b',
  WORKFLOW_MCP_R2_BUCKET: 'workflow-mcp-artifacts',
  WORKFLOW_MCP_URL: 'https://workflow-mcp-worker.aiyaya.workers.dev',
  CLOUDFLARE_ACCOUNT_ID: '8bb496011403552e785ea1b834daffdf',
  GITHUB_REPOSITORY: 'lirtual/mcp-workers',
  GITHUB_REPOSITORY_ID: '1371085786',
  R2_ACCESS_KEY_ID: 'r2-access-key-id'
};

async function sourceConfig(): Promise<WranglerDeployConfig> {
  return JSON.parse(
    await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
  ) as WranglerDeployConfig;
}

describe('Workflow MCP deploy configuration expansion', () => {
  it('derives the four non-secret identifiers and keeps the canonical Cron', async () => {
    const config = buildWorkflowDeployConfig(await sourceConfig(), validContext);
    expect(config.vars).toMatchObject({
      GITHUB_REPOSITORY: 'lirtual/mcp-workers',
      GITHUB_REPOSITORY_ID: '1371085786',
      R2_ACCOUNT_ID: '8bb496011403552e785ea1b834daffdf',
      R2_BUCKET_NAME: 'workflow-mcp-artifacts',
      R2_ACCESS_KEY_ID: 'r2-access-key-id'
    });
    expect(config.vars).not.toHaveProperty('GITHUB_OIDC_ISSUER');
    expect(config.vars).not.toHaveProperty('GITHUB_EXECUTOR_REF');
    expect(config.vars).not.toHaveProperty('SMOKE_MODERN_MCP_ENDPOINT');
    expect(config.keep_vars).toBe(false);
    expect(config.triggers).toEqual({ crons: [CANONICAL_SCHEDULER_CRON] });
    expect(config.secrets).toEqual({
      required: [
        'MCP_ACCESS_TOKEN',
        'EXECUTOR_LEASE_SECRET',
        'GITHUB_ACTIONS_TOKEN',
        'R2_SECRET_ACCESS_KEY'
      ]
    });
    expect(config.r2_buckets).toEqual([
      { binding: 'ARTIFACTS', bucket_name: 'workflow-mcp-artifacts' }
    ]);
  });

  it('fails closed when deployment identity is missing or inconsistent', async () => {
    const source = await sourceConfig();
    expect(() =>
      readWorkflowDeployContext({ ...validContext, GITHUB_REPOSITORY: undefined })
    ).toThrow(/GITHUB_REPOSITORY is required/);
    expect(() =>
      buildWorkflowDeployConfig(source, {
        ...validContext,
        GITHUB_REPOSITORY: 'another-owner/another-repo'
      })
    ).toThrow(/trusted executor repository/);
    expect(() =>
      buildWorkflowDeployConfig(source, {
        ...validContext,
        GITHUB_REPOSITORY_ID: '123456'
      })
    ).toThrow(/trusted executor repository ID/);
    expect(() =>
      buildWorkflowDeployConfig(source, {
        ...validContext,
        CLOUDFLARE_ACCOUNT_ID: 'not-an-account-id'
      })
    ).toThrow(/32-character Cloudflare account ID/);
    expect(() =>
      buildWorkflowDeployConfig(source, {
        ...validContext,
        WORKFLOW_MCP_R2_BUCKET: 'Invalid_Bucket'
      })
    ).toThrow(/valid R2 bucket name/);
    expect(() =>
      buildWorkflowDeployConfig({ ...source, triggers: { crons: [] } }, validContext)
    ).toThrow(/Cron is missing or inconsistent/);
  });
});
