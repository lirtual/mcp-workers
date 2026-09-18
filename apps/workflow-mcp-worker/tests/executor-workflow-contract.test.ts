import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

describe('workflow-executor.yml contract', () => {
  it('is dispatch-only and exposes no business-secret inputs', async () => {
    const file = await readFile(
      path.resolve(process.cwd(), '../../.github/workflows/workflow-executor.yml'),
      'utf8'
    );
    const workflow = parse(file) as Record<string, unknown>;
    const trigger = workflow.on as Record<string, unknown>;
    expect(Object.keys(trigger)).toEqual(['workflow_dispatch']);

    const dispatch = trigger.workflow_dispatch as Record<string, unknown>;
    const inputs = dispatch.inputs as Record<string, unknown>;
    expect(Object.keys(inputs).sort()).toEqual(['attempt_id', 'claim_nonce']);
    expect(file).not.toMatch(/push:|pull_request:/);
    expect(file).not.toContain('secrets.');
  });

  it('grants OIDC minting but not write access to repository contents', async () => {
    const file = await readFile(
      path.resolve(process.cwd(), '../../.github/workflows/workflow-executor.yml'),
      'utf8'
    );
    const workflow = parse(file) as Record<string, unknown>;
    expect(workflow.permissions).toEqual({
      contents: 'read',
      'id-token': 'write'
    });
  });
});
