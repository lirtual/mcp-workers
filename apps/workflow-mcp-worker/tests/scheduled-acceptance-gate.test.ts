import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('T17 operator-triggered scheduled acceptance workflow', () => {
  it('only performs post-deployment read-only verification and sanitized artifact upload', async () => {
    const source = await readFile(
      new URL('../../../.github/workflows/workflow-mcp-scheduled-verify.yml', import.meta.url),
      'utf8'
    );
    const workflow = parse(source) as Record<string, unknown>;
    const trigger = (workflow.on as Record<string, unknown>).workflow_dispatch as Record<string, unknown>;
    expect(trigger).toBeDefined();
    const inputs = trigger.inputs as Record<string, unknown>;
    expect(Object.keys(inputs).sort()).toEqual(['deploy_run_id', 'expected_utc']);
    const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
    expect(Object.keys(jobs)).toEqual(['verify']);
    const job = jobs.verify!;
    expect(job.environment).toBe('workflow-mcp-worker');
    const steps = job.steps as Array<Record<string, unknown>>;
    expect(steps.map(step => step.name).filter(Boolean)).toEqual([
      'Use Node.js 24',
      'Activate pinned pnpm',
      'Install workspace',
      'Verify already-completed deployment and real scheduled occurrence (read-only)',
      'Upload sanitized scheduled evidence'
    ]);
    expect(steps.map(step => step.run).filter(Boolean).join('\n'))
      .not.toMatch(/wrangler deploy|d1 migrations|workflow_run|cron triggers/);
    expect(steps.find(step => step.name ===
      'Verify already-completed deployment and real scheduled occurrence (read-only)')?.run)
      .toBe('pnpm run release:raindrop-scheduled');
    const env = job.env as Record<string, unknown>;
    expect(env.WORKFLOW_MCP_ACCESS_TOKEN).toBe('${{ secrets.MCP_ACCESS_TOKEN }}');
    expect(env.CLOUDFLARE_API_TOKEN).toBe('${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(env.GITHUB_TOKEN).toBe('${{ github.token }}');
  });
});
