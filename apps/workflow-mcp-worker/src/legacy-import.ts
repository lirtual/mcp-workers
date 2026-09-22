import { createHash } from 'node:crypto';
import { getConnection } from './connections.js';
import { assertReleaseCompatibility, type ReleaseCompatibilityRecord } from './provenance.js';
import { getWorkflowRegistry } from './registry.js';
import { validateVersionedWorkflowPlan } from './runtime-plan-validation.js';
import type { WorkflowRegistryEntry } from './types.js';

/** Frozen v0.1 generated-registry identity; never recalculate away a source drift. */
export const LEGACY_DEFINITIONS = {
  'local-http-smoke': '567b8d64800fe0ff53f5b85e83fbb6e57dbc679e09f9ed77e7b717330ee0a522',
  'raindrop-daily-snapshot': '3ce110f8ff39b95b932ec886d88450782831a3d854b7776732da948af8dc044d',
  'sequential-http-smoke': '320d63de02a8296fea0eb9e5ca59b3388ca8f6d8f98115e40e0840fa4da6d31f',
  'web-archive-smoke': '6077af97d0ad7d08e3bc01f47bab4667b55b63263d9834e0ebef145c5a8fcc40'
} as const;

const SCHEDULE_KEY = 'raindrop-daily-snapshot:daily-nine';
const hash = /^[0-9a-f]{64}$/;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(
    Object.keys(value as Record<string, unknown>).sort()
      .map(key => [key, canonical((value as Record<string, unknown>)[key])])
  ) : value;

export interface LegacyImportState {
  readonly definitions: readonly {
    definitionDigest: string; workflowId: string; dslVersion: number;
    normalizedPlanJson: string; sourcePath: string
  }[];
  readonly active: readonly {
    workflowId: string; activeDigest: string | null;
    registryRevision: number; state: 'enabled' | 'disabled'
  }[];
  readonly scheduler: readonly {
    scheduleKey: string; lastEvaluatedAt: number;
    lastAdmittedScheduledTime?: number | null; nextDueOccurrence?: number | null
  }[];
  readonly nonterminal: readonly ReleaseCompatibilityRecord[];
  readonly approvedConnectionIds: readonly string[];
}

export function prepareLegacyImport(state: LegacyImportState,
  entries: readonly WorkflowRegistryEntry[] = getWorkflowRegistry()) {
  // No D1 mutation or change of read/admission gates happens in this phase.
  assertReleaseCompatibility(state.nonterminal);
  const expected = Object.entries(LEGACY_DEFINITIONS);
  const knownIds = new Set(expected.map(([id]) => id));
  if (entries.length !== expected.length || new Set(entries.map(e => e.metadata.id)).size !== expected.length ||
      state.definitions.length !== new Set(state.definitions.map(d => d.definitionDigest)).size) {
    throw new Error('Legacy definition inventory is incomplete or duplicated.');
  }
  // The static v0.1 reader only exposes four workflows. A separately
  // activated workflow would become visible at cutover, so it requires an
  // independent approved migration rather than being silently adopted here.
  if (new Set(state.active.map(row => row.workflowId)).size !== state.active.length ||
      state.active.some(row => !knownIds.has(row.workflowId))) {
    throw new Error('Unexpected or duplicate active workflow blocks legacy cutover.');
  }
  const approved = new Set(state.approvedConnectionIds);
  const rows = entries.map(entry => {
    const digest = LEGACY_DEFINITIONS[entry.metadata.id as keyof typeof LEGACY_DEFINITIONS];
    if (!digest || entry.definitionDigest !== digest || entry.metadata.definitionDigest !== digest ||
        entry.sourcePath !== `workflows/${entry.metadata.id}.yaml`) {
      throw new Error('Legacy definition identity does not match the frozen v0.1 baseline.');
    }
    const plan = validateVersionedWorkflowPlan(entry.plan);
    if (plan.id !== entry.metadata.id || plan.dslVersion !== 1) {
      throw new Error('Legacy normalized definition is inconsistent.');
    }
    const serialized = JSON.stringify(canonical(plan));
    if (createHash('sha256').update(serialized).digest('hex') !== digest) {
      throw new Error('Legacy canonical definition digest mismatch.');
    }
    for (const step of Object.values(plan.steps)) {
      if (step.uses !== 'mcp.call') continue;
      const id = step.with.connection;
      const tool = step.with.tool;
      if (typeof id !== 'string' || typeof tool !== 'string' ||
          !approved.has(id) || !getConnection(id)?.tools[tool]) {
        throw new Error('Legacy Connection requires explicit compatible approval.');
      }
    }
    const previous = state.definitions.find(d => d.definitionDigest === digest);
    if (previous && (previous.workflowId !== entry.metadata.id || previous.dslVersion !== 1 ||
        previous.sourcePath !== entry.sourcePath ||
        JSON.stringify(canonical(JSON.parse(previous.normalizedPlanJson))) !== serialized)) {
      throw new Error('Existing pinned legacy definition cannot be overwritten.');
    }
    const active = state.active.find(a => a.workflowId === entry.metadata.id);
    if (active && (!Number.isSafeInteger(active.registryRevision) ||
        active.registryRevision < 1 ||
        (active.state !== 'enabled' && active.state !== 'disabled') ||
        (active.state === 'enabled' && active.activeDigest === null) ||
        (active.state === 'disabled' && active.activeDigest !== null))) {
      throw new Error('Legacy active pointer revision/state is invalid.');
    }
    if (active && active.activeDigest !== null && active.activeDigest !== digest) {
      throw new Error('Already-active definition requires a separate approved CAS cutover.');
    }
    return {
      workflowId: entry.metadata.id, definitionDigest: digest, dslVersion: 1,
      normalizedPlanJson: serialized, sourcePath: entry.sourcePath,
      alreadyStored: Boolean(previous)
    };
  });
  for (const [id] of expected) {
    if (!rows.some(row => row.workflowId === id)) throw new Error('Legacy workflow is missing.');
  }
  for (const run of state.nonterminal) {
    const pinned = state.definitions.find(d => d.definitionDigest === run.definitionDigest) ??
      rows.find(row => row.definitionDigest === run.definitionDigest);
    if (!hash.test(run.definitionDigest) || !pinned) {
      throw new Error('Nonterminal Run lacks its historical pinned definition.');
    }
    // A stored digest row is not sufficient if a nonterminal Run's recovered
    // plan differs from it. Verify the canonical identity before cutover.
    const pinnedPlan = validateVersionedWorkflowPlan(JSON.parse(pinned.normalizedPlanJson));
    const runPlan = validateVersionedWorkflowPlan(JSON.parse(run.normalizedPlanJson ?? 'null'));
    const canonicalPinned = JSON.stringify(canonical(pinnedPlan));
    const canonicalRun = JSON.stringify(canonical(runPlan));
    if (pinnedPlan.id !== pinned.workflowId ||
        pinnedPlan.dslVersion !== pinned.dslVersion ||
        runPlan.id !== pinned.workflowId || runPlan.dslVersion !== run.dslVersion ||
        canonicalPinned !== canonicalRun ||
        createHash('sha256').update(canonicalRun).digest('hex') !== run.definitionDigest) {
      throw new Error('Nonterminal Run pinned plan or digest differs from its historical definition.');
    }
  }
  const cursor = state.scheduler.filter(s => s.scheduleKey === SCHEDULE_KEY);
  if (cursor.length !== 1 || !Number.isSafeInteger(cursor[0]!.lastEvaluatedAt) ||
      cursor[0]!.lastEvaluatedAt < 0 ||
      (cursor[0]!.lastAdmittedScheduledTime != null &&
       (!Number.isSafeInteger(cursor[0]!.lastAdmittedScheduledTime) ||
        cursor[0]!.lastAdmittedScheduledTime > cursor[0]!.lastEvaluatedAt))) {
    throw new Error('Legacy daily-nine scheduler high-water mark is missing or invalid.');
  }
  return {
    definitions: rows,
    preservedSchedule: { ...cursor[0]! },
    nonterminalRuns: state.nonterminal.length,
    // Activation is deliberately absent: the old reader stays authoritative
    // until isolated compatibility and an independently approved cutover.
    readerGateChanged: false
  };
}
