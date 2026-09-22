import type { LegacyImportState } from './legacy-import.js';
import { prepareLegacyImport } from './legacy-import.js';

/**
 * Additive, fail-closed v0.1 definition seed. The caller must supply a fresh
 * read-only D1 snapshot and approved policy revision from the isolated DB.
 * Never writes active pointers, Run records, scheduler state or feature gates.
 */
export async function seedLegacyDefinitions(
  db: D1Database,
  state: LegacyImportState,
  expectedPolicyRevision: number
) {
  if (!Number.isSafeInteger(expectedPolicyRevision) || expectedPolicyRevision < 1) {
    throw new Error('Legacy import requires an approved policy revision.');
  }
  const prepared = prepareLegacyImport(state);
  const currentPolicy = await db.prepare(
    'SELECT revision FROM connection_policy_revision WHERE singleton = 1'
  ).first<{ revision: number }>();
  if (!currentPolicy || currentPolicy.revision !== expectedPolicyRevision) {
    throw new Error('Legacy import policy changed before the D1 transaction.');
  }
  const initialCursor = await db.prepare(
    'SELECT last_evaluated_at, last_admitted_scheduled_time, next_due_occurrence FROM scheduler_state WHERE schedule_key = ?'
  ).bind(prepared.preservedSchedule.scheduleKey).first<{
    last_evaluated_at: number; last_admitted_scheduled_time: number | null;
    next_due_occurrence: number | null
  }>();
  if (!initialCursor ||
      initialCursor.last_evaluated_at !== prepared.preservedSchedule.lastEvaluatedAt ||
      initialCursor.last_admitted_scheduled_time !==
        (prepared.preservedSchedule.lastAdmittedScheduledTime ?? null) ||
      initialCursor.next_due_occurrence !==
        (prepared.preservedSchedule.nextDueOccurrence ?? null)) {
    throw new Error('Legacy schedule changed since preflight; no definitions seeded.');
  }
  const now = new Date().toISOString();
  const results = await db.batch(prepared.definitions.map(row => db.prepare(
    `INSERT OR IGNORE INTO workflow_definition_versions
     (definition_digest, workflow_id, dsl_version, normalized_plan_json, source_path, source_commit, created_at)
     SELECT ?, ?, ?, ?, ?, NULL, ?
     WHERE EXISTS (SELECT 1 FROM connection_policy_revision WHERE singleton = 1 AND revision = ?)`
  ).bind(row.definitionDigest, row.workflowId, row.dslVersion, row.normalizedPlanJson,
    row.sourcePath, now, expectedPolicyRevision)));

  // Even an INSERT OR IGNORE result is untrusted: an independently inserted
  // digest collision must not be mistaken for a matching immutable version.
  for (let index = 0; index < prepared.definitions.length; index += 1) {
    const expected = prepared.definitions[index]!;
    const stored = await db.prepare(
      `SELECT workflow_id, dsl_version, normalized_plan_json, source_path
       FROM workflow_definition_versions WHERE definition_digest = ?`
    ).bind(expected.definitionDigest).first<{
      workflow_id: string; dsl_version: number; normalized_plan_json: string; source_path: string
    }>();
    if (!stored || stored.workflow_id !== expected.workflowId ||
        stored.dsl_version !== expected.dslVersion ||
        stored.normalized_plan_json !== expected.normalizedPlanJson ||
        stored.source_path !== expected.sourcePath) {
      throw new Error('Legacy immutable definition verification failed; reader gate remains OFF.');
    }
  }
  const afterPolicy = await db.prepare(
    'SELECT revision FROM connection_policy_revision WHERE singleton = 1'
  ).first<{ revision: number }>();
  if (!afterPolicy || afterPolicy.revision !== expectedPolicyRevision) {
    throw new Error('Legacy import policy changed; reader gate remains OFF.');
  }
  return {
    definitionsVerified: prepared.definitions.length,
    inserted: results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0),
    preservedScheduleKey: prepared.preservedSchedule.scheduleKey,
    readerGateChanged: false
  };
}
