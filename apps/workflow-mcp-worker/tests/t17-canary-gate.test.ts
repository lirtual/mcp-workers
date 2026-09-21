import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('temporary T17 canary acceptance release gate', () => {
  it('cannot run before a completed production deployment or outside its UTC window', async () => {
    const source = await readFile(
      new URL('../../../.github/workflows/workflow-mcp-t17-canary-verify.yml', import.meta.url),
      'utf8'
    );
    const workflow = parse(source) as Record<string, unknown>;
    const triggers = workflow.on as Record<string, unknown>;
    expect(Object.keys(triggers)).toEqual(['workflow_run']);
    const trigger = triggers.workflow_run as Record<string, unknown>;
    expect(trigger.workflows).toEqual(['Workflow MCP Deploy']);
    expect(trigger.types).toEqual(['completed']);
    const job = (workflow.jobs as Record<string, Record<string, unknown>>).verify!;
    expect(String(job.if)).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(String(job.if)).toContain("github.event.workflow_run.head_branch == 'main'");
    const env = job.env as Record<string, unknown>;
    expect(env.WORKFLOW_MCP_T17_CANARY).toBe('true');
    expect(env.WORKFLOW_MCP_EXPECTED_UTC).toBe('2026-09-21T09:20:00.000Z');
    expect(env.WORKFLOW_MCP_DEPLOY_RUN_ID).toBe('${{ github.event.workflow_run.id }}');
    const steps = job.steps as Array<Record<string, unknown>>;
    const gate = String(steps.find(s => s.id === 'window')?.run);
    expect(gate).toContain('2026-09-21T09:05:00Z');
    expect(gate).toContain('2026-09-21T09:22:00Z');
    expect(gate).toContain('2026-09-21T09:35:00Z');
    expect(gate).toContain('enabled=false');
    expect(steps.find(s => s.name ===
      'Verify one real canary tick after the deployment job exited')?.run)
      .toBe('pnpm run release:raindrop-scheduled');
    expect(steps.map(s => String(s.run ?? '')).join('\n'))
      .not.toMatch(/wrangler deploy|d1 migrations|workflow_run\s*\(/);
  });
});
