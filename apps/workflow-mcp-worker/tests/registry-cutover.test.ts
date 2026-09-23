import { describe, expect, it } from 'vitest';
import { getWorkflowRegistry, listVisibleWorkflows } from '../src/registry.js';
import type { Env } from '../src/types.js';

describe('T10 dynamic Registry cutover fail-closed read', () => {

  it('rejects a valid-looking active digest when the stored plan was changed', async () => {
    const original = getWorkflowRegistry().find(entry => entry.metadata.id === 'local-http-smoke')!;
    const mutated = { ...(original.plan as object), name: 'unapproved active replacement' };
    const env = {
      DYNAMIC_WORKFLOW_REGISTRY_ENABLED: 'true',
      DB: {
        prepare: () => ({
          all: async () => ({ results: [{
            workflow_id: original.metadata.id,
            active_digest: original.definitionDigest,
            normalized_plan_json: JSON.stringify(mutated),
            source_path: original.sourcePath
          }] })
        })
      }
    } as unknown as Env;
    await expect(listVisibleWorkflows(env)).rejects.toThrow(/definition is inconsistent/);
  });

  it('retains the active definition only when its canonical plan matches its digest', async () => {
    const original = getWorkflowRegistry().find(entry => entry.metadata.id === 'local-http-smoke')!;
    const env = {
      DYNAMIC_WORKFLOW_REGISTRY_ENABLED: 'true',
      DB: {
        prepare: () => ({
          all: async () => ({ results: [{
            workflow_id: original.metadata.id,
            active_digest: original.definitionDigest,
            normalized_plan_json: JSON.stringify(original.plan),
            source_path: original.sourcePath
          }] })
        })
      }
    } as unknown as Env;
    const visible = await listVisibleWorkflows(env);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.definitionDigest).toBe(original.definitionDigest);
  });


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
