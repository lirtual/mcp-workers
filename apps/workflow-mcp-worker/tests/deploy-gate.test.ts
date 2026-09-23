import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

async function workflow(name: string): Promise<Record<string, unknown>> {
  const file = await readFile(
    path.resolve(process.cwd(), '../../.github/workflows', name),
    'utf8'
  );
  return parse(file) as Record<string, unknown>;
}

describe('Workflow MCP deploy gate contract', () => {
  it('keeps the release path bounded and preserves persistent Worker credentials', async () => {
    const value = await workflow('workflow-mcp-deploy.yml');
    const triggers = value.on as Record<string, unknown>;
    expect(Object.keys(triggers).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(triggers).not.toHaveProperty('pull_request');
    expect(Object.keys((triggers.workflow_dispatch as Record<string, unknown>).inputs as object).sort()).toEqual([
      'full_acceptance',
      'raindrop_manual_acceptance',
      'source_url'
    ]);
    expect((triggers.push as Record<string, unknown>)).toMatchObject({
      branches: ['main'],
      paths: [
        'apps/workflow-mcp-worker/**',
        '.github/workflows/workflow-executor.yml',
        '.github/workflows/workflow-mcp-deploy.yml'
      ]
    });
    expect(value.permissions).toEqual({ contents: 'read', actions: 'write' });

    const deploy = (value.jobs as Record<string, unknown>).deploy as Record<string, unknown>;
    expect(deploy.environment).toBe('workflow-mcp-worker');
    const steps = deploy.steps as Array<Record<string, unknown>>;
    const names = steps.map(step => step.name).filter(Boolean);
    expect(names).toContain('Validate required Workflow MCP configuration');
    expect(names).toContain('Run application release checks');
    expect(names).toContain('Check persisted Worker Secret names');
    expect(names).toContain('Apply D1 migrations');
    expect(names).toContain('Verify live Raindrop contract before any deployment mutations');
    expect(names).toContain('Verify real Raindrop manual Run and structured result');
    expect(names).toContain('Upload sanitized Raindrop acceptance evidence');
    expect(names).toContain('Check nonterminal runtime compatibility');
    expect(names).toContain('Deploy Workflow MCP Worker');
    expect(names).toContain('Wait for Worker health');
    expect(names).not.toContain('Install Workflow MCP Worker secrets');
    expect(names).toContain('Probe health and unauthenticated MCP');
    expect(names).toContain('Run MCP heavy and connection tracers');
    expect(names).toContain('Verify GitHub executor terminal evidence');
    expect(names.indexOf('Check persisted Worker Secret names')).toBeLessThan(
      names.indexOf('Apply D1 migrations')
    );
    expect(names.indexOf('Verify live Raindrop contract before any deployment mutations')).toBeLessThan(
      names.indexOf('Apply D1 migrations')
    );
    expect(names.indexOf('Verify real Raindrop manual Run and structured result')).toBeGreaterThan(
      names.indexOf('Probe health and unauthenticated MCP')
    );
    const discovery = steps.find(step => step.name === 'Verify live Raindrop contract before any deployment mutations');
    const manual = steps.find(step => step.name === 'Verify real Raindrop manual Run and structured result');
    expect(discovery?.if).toContain('raindrop_manual_acceptance');
    expect(manual?.if).toContain('raindrop_manual_acceptance');
    expect(discovery?.run).toBe('pnpm run release:raindrop-discovery');
    expect(manual?.run).toBe('pnpm run release:raindrop-manual');
    expect(discovery?.env).toMatchObject({
      WORKFLOW_MCP_ACCESS_TOKEN: '${{ secrets.MCP_ACCESS_TOKEN }}'
    });
    expect(manual?.env).toMatchObject({
      WORKFLOW_MCP_ACCESS_TOKEN: '${{ secrets.MCP_ACCESS_TOKEN }}'
    });
    expect(names).not.toContain('Generate ephemeral runtime credentials');
    const tracer = steps.find(step => step.name === 'Run MCP heavy and connection tracers');
    const executorEvidence = steps.find(step => step.name === 'Verify GitHub executor terminal evidence');
    expect(tracer?.if).toContain('full_acceptance');
    expect(executorEvidence?.if).toContain('full_acceptance');

    const text = await readFile(
      path.resolve(process.cwd(), '../../.github/workflows/workflow-mcp-deploy.yml'), 'utf8'
    );
    expect(text).toContain('R2_ACCESS_KEY_ID: ${{ vars.R2_ACCESS_KEY_ID }}');
    expect(text).toContain('wrangler secret list');
    expect(text).toContain("['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID']");
    expect(text).toContain('wrangler deploy --config');
    expect(text).not.toContain('--secrets-file');
    expect(text).not.toContain('openssl rand');
    expect(text).toContain('WORKFLOW_MCP_ACCESS_TOKEN: ${{ secrets.MCP_ACCESS_TOKEN }}');
    expect(text).not.toContain('WORKFLOW_MCP_GITHUB_ACTIONS_TOKEN');
    expect(text).not.toContain('GITHUB_ACTIONS_TOKEN: ${{ github.token }}');
    expect(text).not.toContain('SMOKE_READONLY_MCP_TOKEN');
    expect(text).not.toContain('TRIGGER_SMOKE_WEBHOOK_TOKEN');
  });

  it('keeps the executor dispatch-only with the same two identity inputs', async () => {
    const value = await workflow('workflow-executor.yml');
    const trigger = (value.on as Record<string, unknown>).workflow_dispatch as Record<string, unknown>;
    const inputs = trigger.inputs as Record<string, unknown>;
    expect(Object.keys(inputs).sort()).toEqual(['attempt_id', 'claim_nonce']);
    expect(value.permissions).toEqual({
      contents: 'read',
      'id-token': 'write'
    });

    const jobs = value.jobs as Record<string, unknown>;
    const execute = jobs.execute as Record<string, unknown>;
    expect(execute.environment).toBe('workflow-mcp-worker');
    expect(execute.env).toMatchObject({
      WORKFLOW_MCP_URL:
        "${{ vars.WORKFLOW_MCP_URL || 'https://workflow-mcp-worker.aiyaya.workers.dev' }}"
    });
  });

  it('scopes workflow control-plane workflow files to workflow-mcp-worker CI checks', async () => {
    const file = await readFile(
      path.resolve(process.cwd(), '../../.github/workflows/ci.yml'),
      'utf8'
    );
    expect(file).toContain('.github/workflows/workflow-executor.yml');
    expect(file).toContain('.github/workflows/workflow-mcp-deploy.yml');
    expect(file).toContain('workflow_control_plane_changed=true');
  });
});
