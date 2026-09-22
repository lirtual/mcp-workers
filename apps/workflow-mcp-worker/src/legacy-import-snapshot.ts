import type { LegacyImportState } from './legacy-import.js';
import type { ReleaseCompatibilityRecord } from './provenance.js';

type Definition = LegacyImportState['definitions'][number];
type Active = LegacyImportState['active'][number];
type Schedule = LegacyImportState['scheduler'][number];
type RunRow = {
  run_id: string;
  definition_digest: string;
  dsl_version: number | null;
  normalized_plan_json: string | null;
  execution_manifest_json: string | null;
};

/**
 * Read the authoritative isolated D1 snapshot. The caller may not claim there
 * are no nonterminal Runs, changed active pointers or no stored definitions.
 * A missing pinned definition must appear as an incompatible Run, not vanish
 * because of an INNER JOIN.
 */
export async function readLegacyImportState(db: D1Database): Promise<LegacyImportState> {
  const definitions = (await db.prepare(
    `SELECT definition_digest AS definitionDigest, workflow_id AS workflowId,
            dsl_version AS dslVersion, normalized_plan_json AS normalizedPlanJson,
            source_path AS sourcePath FROM workflow_definition_versions ORDER BY definition_digest LIMIT 1025`
  ).all<Definition>()).results;
  const active = (await db.prepare(
    `SELECT workflow_id AS workflowId, active_digest AS activeDigest,
            registry_revision AS registryRevision, state
     FROM workflow_active_definitions ORDER BY workflow_id LIMIT 65`
  ).all<Active>()).results;
  const schedulerRows = (await db.prepare(
    `SELECT schedule_key AS scheduleKey, last_evaluated_at AS lastEvaluatedAt,
            last_admitted_scheduled_time AS lastAdmittedScheduledTime,
            next_due_occurrence AS nextDueOccurrence
     FROM scheduler_state ORDER BY schedule_key LIMIT 1025`
  ).all<Schedule>()).results;
  const rows = (await db.prepare(
    `SELECT wr.run_id, wr.definition_digest, wdv.dsl_version, wdv.normalized_plan_json,
            sa.execution_manifest_json
     FROM workflow_runs wr
     LEFT JOIN workflow_definition_versions wdv ON wdv.definition_digest = wr.definition_digest
     LEFT JOIN step_runs sr ON sr.run_id = wr.run_id
     LEFT JOIN step_attempts sa ON sa.step_run_id = sr.step_run_id
       AND sa.execution_manifest_json IS NOT NULL
     WHERE wr.state IN ('queued', 'running', 'waiting', 'cancel_requested')
     ORDER BY wr.run_id, sr.step_run_id, sa.attempt_number LIMIT 10001`
  ).all<RunRow>()).results;
  const controls = (await db.prepare(
    `SELECT connection_id AS connectionId FROM connection_controls
     WHERE disabled = 0 ORDER BY connection_id LIMIT 65`
  ).all<{ connectionId: string }>()).results;
  if (definitions.length > 1024 || active.length > 64 || schedulerRows.length > 1024 ||
      rows.length > 10000 || controls.length > 64) {
    throw new Error('Legacy import snapshot exceeds a bounded D1 read.');
  }
  const nonterminal = new Map<string, ReleaseCompatibilityRecord>();
  for (const row of rows) {
    if (!row.run_id || !row.definition_digest) throw new Error('Invalid nonterminal Run snapshot.');
    let current = nonterminal.get(row.run_id);
    if (!current) {
      current = {
        runId: row.run_id,
        definitionDigest: row.definition_digest,
        dslVersion: row.dsl_version == null ? -1 : row.dsl_version,
        normalizedPlanJson: row.normalized_plan_json ?? '',
        manifestVersions: [],
        hasInvalidManifest: false
      };
      nonterminal.set(row.run_id, current);
    } else if (current.definitionDigest !== row.definition_digest ||
        current.dslVersion !== (row.dsl_version ?? -1) ||
        current.normalizedPlanJson !== (row.normalized_plan_json ?? '')) {
      throw new Error('Inconsistent nonterminal Run snapshot.');
    }
    if (row.execution_manifest_json != null) {
      try {
        const manifest: unknown = JSON.parse(row.execution_manifest_json);
        const version = manifest && typeof manifest === 'object' && !Array.isArray(manifest)
          ? (manifest as Record<string, unknown>).version : undefined;
        if (typeof version === 'number' && Number.isSafeInteger(version)) {
          current.manifestVersions.push(version);
        } else {
          current.hasInvalidManifest = true;
        }
      } catch {
        current.hasInvalidManifest = true;
      }
    }
  }
  return {
    definitions, active, scheduler: schedulerRows, nonterminal: [...nonterminal.values()],
    approvedConnectionIds: controls.map(control => control.connectionId)
  };
}

function ordered<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((a, b) => key(a).localeCompare(key(b)));
}

/** Reject stale or caller-fabricated preflight observations before writing. */
export function assertLegacyImportSnapshot(
  claimed: LegacyImportState, actual: LegacyImportState
): void {
  const stable = (state: LegacyImportState) => JSON.stringify({
    definitions: ordered(state.definitions, row => row.definitionDigest),
    active: ordered(state.active, row => row.workflowId),
    scheduler: ordered(state.scheduler, row => row.scheduleKey),
    nonterminal: ordered(state.nonterminal, row => row.runId).map(row => ({
      ...row, manifestVersions: [...row.manifestVersions].sort((a, b) => a - b)
    })),
    approvedConnectionIds: [...state.approvedConnectionIds].sort()
  });
  if (stable(claimed) !== stable(actual)) {
    throw new Error('Legacy import snapshot differs from authoritative D1; no definitions seeded.');
  }
}
