import { describe, expect, it } from 'vitest';
import {
  assertExecutionManifestCompatible,
  assertReleaseCompatibility,
  currentBundledDefinition,
  currentEngineVersion,
  loadPinnedRuntimePlan,
  RUNNER_VERSION
} from '../src/provenance.js';
import type { StoredDefinition, StoredRun } from '../src/storage.js';
import type { Env, WorkflowRegistryEntry } from '../src/types.js';

function plan(name: string) {
  return {
    dslVersion: 1 as const,
    id: 'versioned-workflow',
    name,
    inputs: {},
    triggers: [{ type: 'manual' }],
    steps: {},
    outputs: {}
  };
}

function definition(
  definitionDigest: string,
  name: string,
  dslVersion = 1
): StoredDefinition {
  return {
    definitionDigest,
    workflowId: 'versioned-workflow',
    dslVersion,
    plan: plan(name),
    sourcePath: 'workflows/versioned.yaml'
  };
}

function run(definitionDigest: string): StoredRun {
  return {
    runId: 'run_old',
    workflowId: 'versioned-workflow',
    definitionDigest,
    input: {},
    trigger: { type: 'manual' },
    state: 'waiting',
    createdAt: '2026-09-18T00:00:00.000Z'
  };
}

describe('runtime provenance and pinned plans', () => {
  it('records the Cloudflare Worker version metadata ID as engine version', () => {
    expect(
      currentEngineVersion({
        CF_VERSION_METADATA: {
          id: 'worker-version-123',
          tag: 'release-1',
          timestamp: '2026-09-18T00:00:00.000Z'
        }
      } as Pick<Env, 'CF_VERSION_METADATA'>)
    ).toBe('worker-version-123');

    expect(currentEngineVersion({} as Pick<Env, 'CF_VERSION_METADATA'>)).toBe(
      'local-dev'
    );
  });

  it('keeps an existing nonterminal Run on its stored definition digest after a new bundle exists', async () => {
    const oldDigest = 'a'.repeat(64);
    const newDigest = 'b'.repeat(64);
    const oldDefinition = definition(oldDigest, 'Old plan');
    const newEntry: WorkflowRegistryEntry = {
      sourcePath: 'workflows/versioned.yaml',
      definitionDigest: newDigest,
      metadata: {
        id: 'versioned-workflow',
        name: 'New plan',
        definitionDigest: newDigest,
        triggerTypes: ['manual'],
        inputs: {},
        stepCapabilities: []
      },
      plan: plan('New plan')
    };

    const requested: string[] = [];
    const store = {
      async getDefinition(digest: string) {
        requested.push(digest);
        return digest === oldDigest ? oldDefinition : null;
      }
    };

    const pinned = await loadPinnedRuntimePlan(store, run(oldDigest));
    const current = currentBundledDefinition(newEntry);

    expect(requested).toEqual([oldDigest]);
    expect(pinned.definition.definitionDigest).toBe(oldDigest);
    expect(pinned.plan.name).toBe('Old plan');
    expect(current.definitionDigest).toBe(newDigest);
    expect(current.plan.name).toBe('New plan');
  });

  it('rejects unsupported stored DSL and execution manifest versions', async () => {
    const unsupported = definition('c'.repeat(64), 'Old plan', 2);
    await expect(
      loadPinnedRuntimePlan(
        { async getDefinition() { return unsupported; } },
        run(unsupported.definitionDigest)
      )
    ).rejects.toThrow(/unsupported DSL version 2/);

    expect(() => assertExecutionManifestCompatible({ version: 1 })).not.toThrow();
    expect(() => assertExecutionManifestCompatible({ version: 2 })).toThrow(
      /unsupported version 2/
    );
  });

  it('fails the release gate when any nonterminal runtime contract is unsupported', () => {
    expect(() =>
      assertReleaseCompatibility([
        {
          runId: 'run_ok',
          definitionDigest: 'd'.repeat(64),
          dslVersion: 1,
          manifestVersions: [1],
          hasInvalidManifest: false
        }
      ])
    ).not.toThrow();

    expect(() =>
      assertReleaseCompatibility([
        {
          runId: 'run_bad_dsl',
          definitionDigest: 'e'.repeat(64),
          dslVersion: 2,
          manifestVersions: [1],
          hasInvalidManifest: false
        },
        {
          runId: 'run_bad_manifest',
          definitionDigest: 'f'.repeat(64),
          dslVersion: 1,
          manifestVersions: [2],
          hasInvalidManifest: false
        }
      ])
    ).toThrow(/Release compatibility gate rejected 2/);

    expect(() =>
      assertReleaseCompatibility([
        {
          runId: 'run_malformed',
          definitionDigest: '1'.repeat(64),
          dslVersion: 1,
          manifestVersions: [],
          hasInvalidManifest: true
        }
      ])
    ).toThrow(/invalid-execution-manifest/);
  });

  it('blocks nonterminal pinned plans when the new bundle removes their smoke connection', () => {
    const baseline = {
      runId: 'run_active_legacy_mcp',
      definitionDigest: 'a'.repeat(64),
      dslVersion: 1,
      manifestVersions: [1],
      hasInvalidManifest: false
    };
    const legacy = {
      ...baseline,
      normalizedPlanJson: JSON.stringify({
        steps: { call: { with: { connection: 'smoke-modern', tool: 'workflow_list' } } }
      })
    };
    expect(() => assertReleaseCompatibility([legacy])).toThrow(/removed-smoke-connection/);
    expect(() => assertReleaseCompatibility([{
      ...legacy,
      normalizedPlanJson: JSON.stringify({
        steps: { call: { with: { connection: 'smoke-readonly' } } }
      })
    }])).toThrow(/removed-smoke-connection/);
    expect(() => assertReleaseCompatibility([{
      ...baseline,
      normalizedPlanJson: JSON.stringify({
        steps: { call: { with: { connection: 'workflow-self' } } }
      })
    }])).not.toThrow();
  });

  it('pins an explicit checked-in runner contract version', () => {
    expect(RUNNER_VERSION).toBe('workflow-runner-v1');
  });
});
