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

describe('Workflow MCP production release gate contract', () => {
  it('keeps the production gate manual-only and release-oriented', async () => {
    const value = await workflow('workflow-mcp-production.yml');
    const triggers = value.on as Record<string, unknown>;
    expect(Object.keys(triggers).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(triggers).not.toHaveProperty('pull_request');
    const push = triggers.push as Record<string, unknown>;
    expect(push).toMatchObject({
      branches: ['main'],
      paths: [
        'apps/workflow-mcp-worker/**',
        '.github/workflows/workflow-executor.yml',
        '.github/workflows/workflow-executor-production.yml',
        '.github/workflows/workflow-mcp-production.yml'
      ]
    });
    expect(value.permissions).toEqual({
      contents: 'read',
      actions: 'write'
    });

    const jobs = value.jobs as Record<string, unknown>;
    const production = jobs.production as Record<string, unknown>;
    expect(production.environment).toBe('workflow-mcp-production');
    const steps = production.steps as Array<Record<string, unknown>>;
    const names = steps.map(step => step.name).filter(Boolean);
    expect(names).toContain('Generate ephemeral production credentials');
    expect(names).toContain('Run application release checks');
    expect(names).toContain('Check nonterminal runtime compatibility');
    expect(names).toContain('Apply production D1 migrations');
    expect(names.indexOf('Apply production D1 migrations')).toBeLessThan(
      names.indexOf('Check nonterminal runtime compatibility')
    );
    expect(names).toContain('Deploy isolated production Worker');
    expect(names).not.toContain('Install production Worker secrets');
    expect(names).toContain('Run MCP heavy and connection tracers');
    expect(names).toContain('Verify GitHub executor terminal evidence');

    const workflowText = await readFile(
      path.resolve(process.cwd(), '../../.github/workflows/workflow-mcp-production.yml'),
      'utf8'
    );
    expect(workflowText).toContain(
      'accounts/$CLOUDFLARE_ACCOUNT_ID/tokens/verify'
    );
    expect(workflowText).toContain('user/tokens/verify');
    expect(workflowText).toContain('token_owner="user"');
    expect(workflowText).toContain(
      'printf \'%s\' "$CLOUDFLARE_API_TOKEN" | sha256sum'
    );
    expect(workflowText).toContain('--secrets-file "$secret_file"');
    expect(workflowText).not.toContain(
      'WORKFLOW_MCP_PRODUCTION_R2_ACCESS_KEY_ID'
    );
    expect(workflowText).not.toContain(
      'WORKFLOW_MCP_PRODUCTION_R2_SECRET_ACCESS_KEY'
    );
    expect(workflowText).toContain(
      'WORKFLOW_MCP_GITHUB_ACTIONS_TOKEN: ${{ github.token }}'
    );
    expect(workflowText).toContain(
      'GITHUB_ACTIONS_TOKEN: ${{ github.token }}'
    );
    expect(workflowText).not.toContain(
      'secrets.WORKFLOW_MCP_GITHUB_ACTIONS_TOKEN'
    );
  });

  it('keeps the production executor dispatch-only with the same two identity inputs', async () => {
    const value = await workflow('workflow-executor-production.yml');
    const trigger = (value.on as Record<string, unknown>).workflow_dispatch as Record<string, unknown>;
    const inputs = trigger.inputs as Record<string, unknown>;
    expect(Object.keys(inputs).sort()).toEqual(['attempt_id', 'claim_nonce']);
    expect(value.permissions).toEqual({
      contents: 'read',
      'id-token': 'write'
    });

    const jobs = value.jobs as Record<string, unknown>;
    const execute = jobs.execute as Record<string, unknown>;
    expect(execute.environment).toBe('workflow-mcp-production');
    expect(execute.env).toMatchObject({
      WORKFLOW_MCP_URL:
        "${{ vars.WORKFLOW_MCP_PRODUCTION_URL || 'https://workflow-mcp-worker.aiyaya.workers.dev' }}"
    });
  });

  it('scopes workflow control-plane workflow files to workflow-mcp-worker CI checks', async () => {
    const file = await readFile(
      path.resolve(process.cwd(), '../../.github/workflows/ci.yml'),
      'utf8'
    );
    expect(file).toContain('.github/workflows/workflow-executor.yml');
    expect(file).toContain('.github/workflows/workflow-executor-production.yml');
    expect(file).toContain('.github/workflows/workflow-mcp-production.yml');
    expect(file).toContain('workflow_control_plane_changed=true');
  });
});
