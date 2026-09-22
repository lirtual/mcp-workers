import { describe, expect, it } from 'vitest';
import { getWorkflowRegistry, listVisibleWorkflows } from '../src/registry.js';
import type { Env } from '../src/types.js';

describe('T10 dynamic Registry cutover fail-closed read', () => {
  it('retains the unchanged bundled v0.1 reader while the explicit gate is OFF', async () => {
    const env = { DB: { prepare: () => { throw new Error('must not access D1'); } } } as unknown as Env;
    expect(await listVisibleWorkflows(env)).toEqual(getWorkflowRegistry());
  });

  it('rejects a dangling active pointer instead of silently hiding its workflow', async () => {
    const env = {
      DYNAMIC_WORKFLOW_REGISTRY_ENABLED: 'true',
      DB: {
        prepare: () => ({
          all: async () => ({ results: [{
            workflow_id: 'local-http-smoke', active_digest: 'a'.repeat(64),
            normalized_plan_json: null, source_path: null
          }] })
        })
      }
    } as unknown as Env;
    await expect(listVisibleWorkflows(env)).rejects.toThrow(/missing its pinned definition/);
  });

  it('does not fall back to bundled definitions when a gated D1 read fails', async () => {
    const env = {
      DYNAMIC_WORKFLOW_REGISTRY_ENABLED: 'true',
      DB: { prepare: () => ({
        all: async () => { throw new Error('D1 unavailable'); }
      }) }
    } as unknown as Env;
    await expect(listVisibleWorkflows(env)).rejects.toThrow(/D1 unavailable/);
  });
});
