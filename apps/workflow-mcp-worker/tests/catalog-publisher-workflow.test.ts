import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync('../../.github/workflows/workflow-mcp-publisher.yml', 'utf8');
const publisherScript = readFileSync('scripts/publish-catalog.ts', 'utf8');
const trustedTarget = readFileSync('src/catalog-publisher-target.ts', 'utf8');
const doc = parse(workflow) as Record<string, unknown>;

describe('T09 trusted Engine publisher workflow', () => {
  it('runs only as a protected manual, definition-only publisher', () => {
    const event = doc.on as Record<string, unknown>;
    expect(Object.keys(event)).toEqual(['workflow_dispatch']);
    const jobs = doc.jobs as Record<string, Record<string, unknown>>;
    expect(Object.keys(jobs)).toEqual(['publish']);
    const job = jobs.publish!;
    expect(job.environment).toBe('workflow-mcp-publisher-live-test');
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(doc.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    const steps = job.steps as Array<Record<string, unknown>>;
    const actions = steps.filter(step => typeof step.uses === 'string');
    expect(actions.filter(step => step.uses === 'actions/checkout@v4')).toHaveLength(2);
    expect(actions[0]?.with).toMatchObject({ 'persist-credentials': false });
    expect(actions[1]?.with).toMatchObject({
      path: 'publisher-catalog', 'sparse-checkout': 'workflows',
      'persist-credentials': false
    });
    const commands = steps.map(step => String(step.run ?? '')).join('\n');
    expect(commands).toContain('scripts/publish-catalog.ts');
    expect(commands).toContain('CATALOG_CHECKED_REPOSITORY_ID');
    expect(commands).not.toMatch(/wrangler\s+(deploy|d1)|npm\s+install.*publisher-catalog/);
    expect(workflow).not.toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(workflow).toContain('WORKFLOW_MCP_TARGET_URL:');
    expect(workflow).toContain('WORKFLOW_MCP_ALLOW_LIVE_TEST_TARGET:');
    expect(workflow).toContain('WORKFLOW_MCP_ALLOW_LIVE_TEST_MUTATIONS:');
    expect(publisherScript).toContain("requireValue(env, 'WORKFLOW_MCP_TARGET_URL')");
    expect(publisherScript).toContain('validateCatalogPublisherTarget(');
    expect(trustedTarget).toContain("const APPROVED_LIVE_TEST_URL = 'https://workflow-mcp-worker.aiyaya.workers.dev'");
    expect(publisherScript).toContain('allowLiveTarget: env.WORKFLOW_MCP_ALLOW_LIVE_TEST_TARGET');
    expect(publisherScript).toContain('allowLiveMutations: env.WORKFLOW_MCP_ALLOW_LIVE_TEST_MUTATIONS');
    expect(trustedTarget).toContain("mode !== 'dry-run'");

  });

  it('requires the explicitly approved source SHA and a safe default dry-run mode', () => {
    const inputs = (doc.on as { workflow_dispatch: { inputs: Record<string, Record<string, unknown>> } })
      .workflow_dispatch.inputs;
    expect(inputs.catalog_sha?.required).toBe(true);
    expect(inputs.definition_path?.required).toBe(true);
    expect(inputs.mode?.default).toBe('dry-run');
    expect(inputs.mode?.options).toEqual(['dry-run', 'stage', 'activate']);
    expect(workflow).toContain('environment: workflow-mcp-publisher-live-test');
  });
});
