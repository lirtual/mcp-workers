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
  it('keeps the deploy gate manual-only and release-oriented', async () => {
    const value = await workflow('workflow-mcp-deploy.yml');
    const triggers = value.on as Record<string, unknown>;
    expect(Object.keys(triggers).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(triggers).not.toHaveProperty('pull_request');
    const push = triggers.push as Record<string, unknown>;
    expect(push).toMatchObject({
      branches: ['main'],
      paths: [
        'apps/workflow-mcp-worker/**',
        '.github/workflows/workflow-executor.yml',
        '.github/workflows/workflow-mcp-deploy.yml'
      ]
    });
    expect(value.permissions).toEqual({
      contents: 'read',
      actions: 'write'
    });

    const jobs = value.jobs as Record<string, unknown>;
    const deploy = jobs.deploy as Record<string, unknown>;
    expect(deploy.environment).toBe('workflow-mcp-worker');
    const steps = deploy.steps as Array<Record<string, unknown>>;
    const names = steps.map(step => step.name).filter(Boolean);
    expect(names).not.toContain('Generate ephemeral runtime credentials');
    expect(names).toContain('Validate required Workflow MCP configuration');
    expect(names).toContain('Run application release checks');
    expect(names).toContain('Check nonterminal runtime compatibility');
    expect(names).toContain('Apply D1 migrations');
    expect(names.indexOf('Validate required Workflow MCP configuration')).toBeLessThan(
      names.indexOf('Apply D1 migrations')
    );
    expect(names).toContain('Deploy Workflow MCP Worker');
    expect(names).not.toContain('Install Workflow MCP Worker secrets');
    expect(names).toContain('Run MCP heavy and connection tracers');
    expect(names).toContain('Verify GitHub executor terminal evidence');

    const workflowText = await readFile(
      path.resolve(process.cwd(), '../../.github/workflows/workflow-mcp-deploy.yml'),
      'utf8'
    );
    expect(workflowText).toContain('--secrets-file "$secret_file"');
    for (const secret of [
      'MCP_ACCESS_TOKEN',
      'GITHUB_ACTIONS_TOKEN',
      'EXECUTOR_LEASE_SECRET',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'RAINDROP_MCP_ACCESS_TOKEN'
    ]) {
      expect(workflowText).toContain('secrets.' + secret);
    }
    expect(workflowText).not.toContain('TRIGGER_SMOKE_WEBHOOK_TOKEN');
    expect(workflowText).not.toContain('SMOKE_READONLY_MCP_TOKEN');
    expect(workflowText).not.toContain('SMOKE_MODERN_MCP_ENDPOINT');
    expect(workflowText).not.toContain('openssl rand');
    expect(workflowText).not.toContain('sha256sum');
    expect(workflowText).not.toContain(
      'WORKFLOW_MCP_GITHUB_ACTIONS_TOKEN: ${{ github.token }}'
    );
    expect(workflowText).not.toContain(
      'GITHUB_ACTIONS_TOKEN: ${{ github.token }}'
    );
    expect(workflowText).toContain(
      'GITHUB_ACTIONS_TOKEN: process.env.WORKFLOW_MCP_GITHUB_ACTIONS_TOKEN'
    );
    const env = deploy.env as Record<string, string>;
    expect(env.WORKFLOW_MCP_GITHUB_ACTIONS_TOKEN).toBe('${{ secrets.GITHUB_ACTIONS_TOKEN }}');
    expect(env.WORKFLOW_MCP_ACCESS_TOKEN).toBe('${{ secrets.MCP_ACCESS_TOKEN }}');

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
