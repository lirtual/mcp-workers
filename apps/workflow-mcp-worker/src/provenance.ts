import { asRuntimePlan, type RuntimePlan } from './runtime-plan.js';
import { getConnection } from './connections.js';
import type {
  StoredDefinition,
  StoredRun
} from './storage.js';
import type { Env, WorkflowRegistryEntry } from './types.js';

export const SUPPORTED_DSL_VERSION = 1;
export const SUPPORTED_EXECUTION_MANIFEST_VERSION = 1;
export const RUNNER_VERSION = 'workflow-runner-v1';

export interface PinnedDefinitionStore {
  getDefinition(definitionDigest: string): Promise<StoredDefinition | null>;
}

export interface ReleaseCompatibilityRecord {
  runId: string;
  definitionDigest: string;
  dslVersion: number;
  manifestVersions: number[];
  hasInvalidManifest: boolean;
  normalizedPlanJson?: string;
}

export interface ReleaseCompatibilityStore {
  listNonterminalCompatibilityRecords(): Promise<ReleaseCompatibilityRecord[]>;
}

export function currentEngineVersion(env: Pick<Env, 'CF_VERSION_METADATA'>): string {
  return env.CF_VERSION_METADATA?.id ?? 'local-dev';
}

export function currentBundledDefinition(entry: WorkflowRegistryEntry): {
  definitionDigest: string;
  plan: RuntimePlan;
} {
  return {
    definitionDigest: entry.definitionDigest,
    plan: asRuntimePlan(entry.plan)
  };
}

export async function loadPinnedRuntimePlan(
  store: PinnedDefinitionStore,
  run: Pick<StoredRun, 'definitionDigest'>
): Promise<{ definition: StoredDefinition; plan: RuntimePlan }> {
  const definition = await store.getDefinition(run.definitionDigest);
  if (!definition) {
    throw new Error('Pinned workflow definition was not found.');
  }
  assertDefinitionCompatible(definition);
  return {
    definition,
    plan: asRuntimePlan(definition.plan)
  };
}

export function assertDefinitionCompatible(
  definition: Pick<StoredDefinition, 'definitionDigest' | 'dslVersion' | 'plan'>
): void {
  if (definition.dslVersion !== SUPPORTED_DSL_VERSION) {
    throw new Error(
      `Definition ${definition.definitionDigest} uses unsupported DSL version ${definition.dslVersion}.`
    );
  }
  const plan = asRuntimePlan(definition.plan);
  if (plan.dslVersion !== definition.dslVersion) {
    throw new Error(
      `Definition ${definition.definitionDigest} has inconsistent stored DSL metadata.`
    );
  }
}

export function assertExecutionManifestCompatible(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored execution manifest is invalid.');
  }
  const version = (value as Record<string, unknown>).version;
  if (version !== SUPPORTED_EXECUTION_MANIFEST_VERSION) {
    throw new Error(
      `Stored execution manifest uses unsupported version ${String(version)}.`
    );
  }
}

export function assertReleaseCompatibility(
  records: readonly ReleaseCompatibilityRecord[]
): void {
  const failures: string[] = [];
  for (const record of records) {
    if (record.dslVersion !== SUPPORTED_DSL_VERSION) {
      failures.push(
        `${record.runId}:dsl=${record.dslVersion}:definition=${record.definitionDigest}`
      );
    }
    if (record.hasInvalidManifest) {
      failures.push(`${record.runId}:invalid-execution-manifest`);
    }
    if (record.normalizedPlanJson !== undefined) {
      if (!record.normalizedPlanJson) {
        failures.push(`${record.runId}:missing-pinned-plan`);
      } else {
        try {
          const connectionIds = referencedConnectionIds(record.normalizedPlanJson);
          if (connectionIds.some(connection =>
            connection === 'smoke-modern' || connection === 'smoke-readonly')) {
            failures.push(`${record.runId}:removed-smoke-connection`);
          }
          if (connectionIds.some(connection =>
            connection !== 'smoke-modern' && connection !== 'smoke-readonly' &&
            !getConnection(connection))) {
            failures.push(`${record.runId}:unknown-connection-mapping`);
          }
        } catch {
          failures.push(`${record.runId}:invalid-normalized-plan`);
        }
      }
    }
    for (const version of record.manifestVersions) {
      if (version !== SUPPORTED_EXECUTION_MANIFEST_VERSION) {
        failures.push(`${record.runId}:manifest=${version}`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Release compatibility gate rejected ${failures.length} nonterminal runtime contract(s): ${failures.join(', ')}`
    );
  }
}

function referencedConnectionIds(normalizedPlanJson: string): string[] {
  const plan = asRuntimePlan(JSON.parse(normalizedPlanJson));
  return Object.values(plan.steps).flatMap(step => {
    const connection = step.with.connection;
    return typeof connection === 'string' ? [connection] : [];
  });
}

export async function runReleaseCompatibilityGate(
  store: ReleaseCompatibilityStore
): Promise<number> {
  const records = await store.listNonterminalCompatibilityRecords();
  assertReleaseCompatibility(records);
  return records.length;
}
