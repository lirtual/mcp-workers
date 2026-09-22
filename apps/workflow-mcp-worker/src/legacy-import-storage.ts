import type { LegacyImportState } from './legacy-import.js';
import { prepareLegacyImport } from './legacy-import.js';
import { getConnection } from './connections.js';
import { assertLegacyImportSnapshot, readLegacyImportState } from './legacy-import-snapshot.js';

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
  // Verify actual approved D1 tool controls, not just the snapshot's claim.
  // A stale or fabricated approvedConnectionIds list cannot grant an import.
  for (const row of prepared.definitions) {
    const plan = JSON.parse(row.normalizedPlanJson) as {
      steps: Record<string, { uses: string; with: Record<string, unknown> }>
    };
    for (const step of Object.values(plan.steps)) {
      if (step.uses !== 'mcp.call') continue;
      const connectionId = step.with.connection;
      const toolName = step.with.tool;
      if (typeof connectionId !== 'string' || typeof toolName !== 'string') {
        throw new Error('Legacy Connection reference is invalid.');
      }
      const control = await db.prepare(
        'SELECT current_version, disabled, allowed_tools_json FROM connection_controls WHERE connection_id = ?'
      ).bind(connectionId).first<{
        current_version: number; disabled: number; allowed_tools_json: string
      }>();
      const effect = getConnection(connectionId)?.tools[toolName]?.effect;
      if (!control || control.disabled !== 0 || !Number.isSafeInteger(control.current_version) ||
          control.current_version < 1 || !effect) {
        throw new Error('Legacy Connection approval is missing or disabled in D1.');
      }
      let allowed: unknown;
      try { allowed = JSON.parse(control.allowed_tools_json); }
      catch { throw new Error('Legacy Connection tool policy is malformed.'); }
      const tools = allowed && typeof allowed === 'object' && !Array.isArray(allowed)
        ? (allowed as Record<string, unknown>)[toolName] : null;
      if (!Array.isArray(tools) || !tools.includes(effect)) {
        throw new Error('Legacy Connection tool is not approved in D1.');
      }
    }
  }
  // A trusted caller cannot suppress incompatible historical Runs or claim an
  // empty registry when D1 holds a different authoritative snapshot.
  assertLegacyImportSnapshot(state, await readLegacyImportState(db));
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
  // A concurrent Cron tick, Registry action or Run transition after the
  // preflight must not be misreported as an accepted unchanged cutover baseline.
  // The additive definitions may already be committed, but the reader remains
  // OFF; an owner must obtain a new snapshot before any later activation.
  const after = await readLegacyImportState(db);
  assertLegacyImportSnapshot({ ...state, definitions: after.definitions }, after);
  return {
    definitionsVerified: prepared.definitions.length,
    inserted: results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0),
    preservedScheduleKey: prepared.preservedSchedule.scheduleKey,
    readerGateChanged: false
  };
}
