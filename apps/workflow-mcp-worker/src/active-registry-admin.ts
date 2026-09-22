import { validateVersionedWorkflowPlan } from './runtime-plan-validation.js';
import { getCapabilityDescriptor } from './capabilities.js';
import { getConnection } from './connections.js';
import { getWorkflowRegistry } from './registry.js';
import type { GitHubJobIdentity } from './oidc.js';
import type { Env } from './types.js';

type ActionKind = 'activate' | 'deactivate';
type Activation = {
  actionId: string;
  workflowId: string;
  expectedDigest: string | null;
  targetDigest: string | null;
  expectedRevision: number;
};

function error(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers: { 'Cache-Control': 'no-store' } });
}

function parseAction(raw: unknown, kind: ActionKind): Activation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !==
      'actionId,expectedDigest,expectedRevision,targetDigest,workflowId') return null;
  if (typeof value.actionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.actionId) ||
      typeof value.workflowId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value.workflowId) ||
      !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0 ||
      !(value.expectedDigest === null ||
        (typeof value.expectedDigest === 'string' && /^[0-9a-f]{64}$/.test(value.expectedDigest))) ||
      !(value.targetDigest === null ||
        (typeof value.targetDigest === 'string' && /^[0-9a-f]{64}$/.test(value.targetDigest))) ||
      (kind === 'activate' && value.targetDigest === null) ||
      (kind === 'deactivate' && value.targetDigest !== null) ||
      (value.expectedRevision === 0 && value.expectedDigest !== null) ||
      (kind === 'deactivate' && value.expectedRevision === 0)) return null;
  return value as Activation;
}

async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function verifyActivationCandidate(
  db: D1Database,
  workflowId: string,
  digest: string
): Promise<number | null> {
  const version = await db.prepare(
    `SELECT d.normalized_plan_json, d.workflow_id
     FROM workflow_definition_versions d
     WHERE d.definition_digest = ? AND d.workflow_id = ?
       AND EXISTS (SELECT 1 FROM definition_publications p
                   WHERE p.workflow_id = d.workflow_id AND p.definition_digest = d.definition_digest)`
  ).bind(digest, workflowId).first<{ normalized_plan_json: string; workflow_id: string }>();
  if (!version) return null;
  const plan = validateVersionedWorkflowPlan(JSON.parse(version.normalized_plan_json));
  if (plan.id !== workflowId) return null;
  for (const step of Object.values(plan.steps)) {
    const descriptor = getCapabilityDescriptor(step.uses);
    if (!descriptor || descriptor.executor !== step.executor) return null;
    if (step.uses !== 'mcp.call') {
      if ((step.retryMaxAttempts ?? 1) > descriptor.maxAutomaticAttempts) return null;
      continue;
    }
    const connectionId = step.with.connection;
    const toolName = step.with.tool;
    if (typeof connectionId !== 'string' || typeof toolName !== 'string') return null;
    const approved = getConnection(connectionId);
    if (!approved || !approved.tools[toolName]) return null;
    const current = await db.prepare(
      'SELECT disabled, allowed_tools_json FROM connection_controls WHERE connection_id = ?'
    ).bind(connectionId).first<{ disabled: number; allowed_tools_json: string }>();
    if (!current || current.disabled !== 0) return null;
    const tools: unknown = JSON.parse(current.allowed_tools_json);
    if (!tools || typeof tools !== 'object' || Array.isArray(tools) ||
        !Array.isArray((tools as Record<string, unknown>)[toolName]) ||
        !(tools as Record<string, string[]>)[toolName]!.includes(approved.tools[toolName]!.effect)) return null;
    const retryLimit = approved.tools[toolName]!.effect === 'read' ? 3 :
      approved.tools[toolName]!.effect === 'idempotent_write' ? 2 : 1;
    if ((step.retryMaxAttempts ?? 1) > retryLimit) return null;
  }
  for (const trigger of plan.triggers) {
    if (trigger.type !== 'webhook') continue;
    if (!getWorkflowRegistry().some(entry => entry.metadata.id === workflowId &&
        (entry.plan as { triggers?: Array<{ type: string; id?: string; secret?: string }> })
          .triggers?.some(t => t.type === 'webhook' && t.id === trigger.id &&
            t.secret === trigger.secret))) return null;
  }
  return plan.triggers.filter(trigger => trigger.type === 'schedule').length;
}

/** Independent trusted publisher mutation: rollback reuses activate. */
export async function updateActiveDefinition(
  request: Request,
  env: Env,
  publisher: GitHubJobIdentity,
  kind: ActionKind
): Promise<Response> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (!Number.isFinite(declared) || declared > 8192) return error(413, 'body_too_large');
  let raw: string;
  try { raw = await request.text(); } catch { return error(400, 'invalid_body'); }
  if (new TextEncoder().encode(raw).byteLength > 8192) return error(413, 'body_too_large');
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { return error(400, 'invalid_body'); }
  const action = parseAction(decoded, kind);
  if (!action) return error(400, 'invalid_body');
  const signature = await sha256(JSON.stringify([
    kind, action.workflowId, action.expectedDigest, action.targetDigest, action.expectedRevision
  ]));
  const nextRevision = action.expectedRevision + 1;
  try {
    const existing = await env.DB.prepare(
      'SELECT workflow_id, action_kind, previous_digest, next_digest, expected_revision, request_digest, resulting_revision, repository_id, publisher_run_id, publisher_run_attempt FROM workflow_registry_actions WHERE action_id = ?'
    ).bind(action.actionId).first<{
      workflow_id: string; action_kind: string; previous_digest: string | null; next_digest: string | null;
      expected_revision: number; request_digest: string; resulting_revision: number;
      repository_id: string; publisher_run_id: string; publisher_run_attempt: number
    }>();
    if (existing) {
      if (existing.workflow_id !== action.workflowId || existing.action_kind !== kind ||
          existing.request_digest !== signature || existing.repository_id !== publisher.repositoryId ||
          existing.publisher_run_id !== publisher.runId || existing.publisher_run_attempt !== publisher.runAttempt) {
        return error(409, 'action_conflict');
      }
      return Response.json({
        workflowId: action.workflowId, activeDigest: existing.next_digest,
        revision: existing.resulting_revision
      }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const current = await env.DB.prepare(
      'SELECT active_digest, registry_revision FROM workflow_active_definitions WHERE workflow_id = ?'
    ).bind(action.workflowId).first<{ active_digest: string | null; registry_revision: number }>();
    if (current
      ? current.registry_revision !== action.expectedRevision || current.active_digest !== action.expectedDigest
      : action.expectedRevision !== 0 || action.expectedDigest !== null) return error(409, 'revision_conflict');

    const policy = await env.DB.prepare(
      'SELECT revision FROM connection_policy_revision WHERE singleton = 1'
    ).first<{ revision: number }>();
    if (!policy || !Number.isSafeInteger(policy.revision)) return error(503, 'policy_unavailable');
    const targetSchedules = action.targetDigest
      ? await verifyActivationCandidate(env.DB, action.workflowId, action.targetDigest)
      : 0;
    if (targetSchedules === null) return error(422, 'definition_not_approved');
    const now = new Date().toISOString();
    // Activation starts new cron/timezone evaluation strictly after its UTC minute.
    // Align this timestamp with the active pointer in the SAME D1 transaction.
    const cutoverMinute = Math.floor(Date.parse(now) / 60_000) * 60_000;
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workflow_registry_actions
         (action_id, workflow_id, action_kind, previous_digest, next_digest, expected_revision,
          resulting_revision, repository_id, publisher_run_id, publisher_run_attempt, request_digest, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT revision FROM connection_policy_revision WHERE singleton = 1) = ?
           AND ((? = 0 AND NOT EXISTS (
             SELECT 1 FROM workflow_active_definitions WHERE workflow_id = ?
           )) OR EXISTS (
             SELECT 1 FROM workflow_active_definitions WHERE workflow_id = ?
             AND registry_revision = ? AND active_digest IS ?
           ))
           AND (? IS NULL OR (
             (SELECT COUNT(*) FROM workflow_active_definitions
              WHERE state = 'enabled' AND workflow_id != ?) < 64
             AND (
               SELECT COALESCE(SUM((
                 SELECT COUNT(*) FROM json_each(d.normalized_plan_json, '$.triggers') t
                 WHERE json_extract(t.value, '$.type') = 'schedule'
               )), 0)
               FROM workflow_active_definitions a
               JOIN workflow_definition_versions d ON d.definition_digest = a.active_digest
               WHERE a.state = 'enabled' AND a.workflow_id != ?
             ) + ? <= 64
           ))`
      ).bind(action.actionId, action.workflowId, kind, action.expectedDigest, action.targetDigest,
        action.expectedRevision, nextRevision, publisher.repositoryId, publisher.runId,
        publisher.runAttempt, signature, now, policy.revision,
        action.expectedRevision, action.workflowId, action.workflowId,
        action.expectedRevision, action.expectedDigest,
        action.targetDigest, action.workflowId, action.workflowId, targetSchedules),
      env.DB.prepare(
        `INSERT INTO workflow_active_definitions
         (workflow_id, active_digest, registry_revision, state, activated_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM workflow_registry_actions WHERE action_id = ? AND request_digest = ?)
         ON CONFLICT(workflow_id) DO UPDATE SET
           active_digest = excluded.active_digest, registry_revision = excluded.registry_revision,
           state = excluded.state, activated_at = excluded.activated_at, updated_at = excluded.updated_at
         WHERE workflow_active_definitions.registry_revision = ?
           AND workflow_active_definitions.active_digest IS ?`
      ).bind(action.workflowId, action.targetDigest, nextRevision,
        action.targetDigest ? 'enabled' : 'disabled',
        action.targetDigest ? now : null, now, action.actionId, signature,
        action.expectedRevision, action.expectedDigest),
      // Retain historical admitted-minute high-water marks on update/rollback.
      // A removed trigger keeps its durable cursor; only the newly enabled
      // plan's schedule triggers receive a cutover. The active pointer, audit
      // and cursor are committed together, without a separate scheduler lock.
      env.DB.prepare(
        `INSERT INTO scheduler_state
         (schedule_key, last_evaluated_at, last_admitted_scheduled_time, next_due_occurrence)
         SELECT ? || ':' || json_extract(t.value, '$.id'), ?, NULL, NULL
         FROM workflow_definition_versions d, json_each(d.normalized_plan_json, '$.triggers') t
         WHERE d.workflow_id = ? AND d.definition_digest = ?
           AND json_extract(t.value, '$.type') = 'schedule'
           AND EXISTS (SELECT 1 FROM workflow_registry_actions
                       WHERE action_id = ? AND request_digest = ?)
           AND EXISTS (SELECT 1 FROM workflow_active_definitions
                       WHERE workflow_id = ? AND active_digest = ?
                         AND registry_revision = ? AND state = 'enabled')
         ON CONFLICT(schedule_key) DO UPDATE SET
           last_evaluated_at = MAX(scheduler_state.last_evaluated_at, excluded.last_evaluated_at),
           next_due_occurrence = NULL`
      ).bind(action.workflowId, cutoverMinute, action.workflowId, action.targetDigest,
        action.actionId, signature, action.workflowId, action.targetDigest, nextRevision)
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      return error(409, 'revision_conflict');
    }
    return Response.json({ workflowId: action.workflowId, activeDigest: action.targetDigest,
      revision: nextRevision }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    // A competing request may have committed the identical action after our
    // first lookup. Re-read the durable result; do not blindly retry the write.
    try {
      const committed = await env.DB.prepare(
        'SELECT workflow_id, action_kind, previous_digest, next_digest, expected_revision, request_digest, resulting_revision, repository_id, publisher_run_id, publisher_run_attempt FROM workflow_registry_actions WHERE action_id = ?'
      ).bind(action.actionId).first<{
        workflow_id: string; action_kind: string; previous_digest: string | null; next_digest: string | null;
        expected_revision: number; request_digest: string; resulting_revision: number;
        repository_id: string; publisher_run_id: string; publisher_run_attempt: number
      }>();
      if (committed) {
        if (committed.workflow_id !== action.workflowId || committed.action_kind !== kind ||
            committed.request_digest !== signature || committed.repository_id !== publisher.repositoryId ||
            committed.publisher_run_id !== publisher.runId || committed.publisher_run_attempt !== publisher.runAttempt) {
          return error(409, 'action_conflict');
        }
        return Response.json({
          workflowId: action.workflowId, activeDigest: committed.next_digest,
          revision: committed.resulting_revision
        }, { headers: { 'Cache-Control': 'no-store' } });
      }
    } catch {
      // No authoritative action outcome is available. Fail closed.
    }
    return error(503, 'registry_storage_unavailable');
  }
}
