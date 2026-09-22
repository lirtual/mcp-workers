import { validateVersionedWorkflowPlan } from './runtime-plan-validation.js';
import { getCapabilityDescriptor } from './capabilities.js';
import { getConnection } from './connections.js';
import type { GitHubJobIdentity } from './oidc.js';
import type { Env } from './types.js';

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const ACTION = /^[A-Za-z0-9_-]{1,128}$/;
const HEX = /^[0-9a-f]{64}$/;
const respond = (status: number, error: string): Response =>
  Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });

type Pointer = { active_digest: string | null; registry_revision: number; state: string };
type Action = { workflow_id: string; action_kind: string; request_digest: string;
  resulting_revision: number; next_digest: string | null; previous_digest: string | null };

async function sha(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Publisher-only CAS. The OIDC identity is verified by the admin router. */
export async function changeActiveDefinition(
  request: Request, env: Env, identity: GitHubJobIdentity, kind: 'activate' | 'deactivate'
): Promise<Response> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (!Number.isFinite(declared) || declared > 8192) return respond(413, 'body_too_large');
  let raw: string;
  try { raw = await request.text(); } catch { return respond(400, 'invalid_body'); }
  if (new TextEncoder().encode(raw).byteLength > 8192) return respond(413, 'body_too_large');
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { return respond(400, 'invalid_body'); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return respond(400, 'invalid_body');
  const body = decoded as Record<string, unknown>;
  const names = kind === 'activate'
    ? 'actionId,definitionDigest,expectedDigest,expectedRevision,workflowId'
    : 'actionId,expectedDigest,expectedRevision,workflowId';
  if (Object.keys(body).sort().join(',') !== names ||
      typeof body.actionId !== 'string' || !ACTION.test(body.actionId) ||
      typeof body.workflowId !== 'string' || !ID.test(body.workflowId) ||
      !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0 ||
      !(body.expectedDigest === null || typeof body.expectedDigest === 'string' && HEX.test(body.expectedDigest)) ||
      (kind === 'activate' && (typeof body.definitionDigest !== 'string' || !HEX.test(body.definitionDigest)))) {
    return respond(400, 'invalid_body');
  }
  const workflowId = body.workflowId as string;
  const actionId = body.actionId as string;
  const expectedRevision = body.expectedRevision as number;
  const expectedDigest = body.expectedDigest as string | null;
  const nextDigest = kind === 'activate' ? body.definitionDigest as string : null;
  const requestDigest = await sha([kind, actionId, workflowId, expectedRevision, expectedDigest, nextDigest,
    identity.repositoryId, identity.runId, identity.runAttempt]);
  const success = (revision: number, previous: string | null, next: string | null): Response =>
    Response.json({ workflowId, revision, previousDigest: previous, activeDigest: next,
      state: kind === 'activate' ? 'enabled' : 'disabled' }, { headers: { 'Cache-Control': 'no-store' } });

  const replay = async (): Promise<Response | undefined> => {
    const old = await env.DB.prepare(
      'SELECT workflow_id, action_kind, request_digest, resulting_revision, previous_digest, next_digest FROM workflow_registry_actions WHERE action_id = ?'
    ).bind(actionId).first<Action>();
    if (!old) return undefined;
    if (old.workflow_id !== workflowId || old.action_kind !== kind || old.request_digest !== requestDigest)
      return respond(409, 'action_conflict');
    return success(old.resulting_revision, old.previous_digest, old.next_digest);
  };

  try {
    const previousAction = await replay();
    if (previousAction) return previousAction;
    const pointer = await env.DB.prepare(
      'SELECT active_digest, registry_revision, state FROM workflow_active_definitions WHERE workflow_id = ?'
    ).bind(workflowId).first<Pointer>();
    if ((pointer?.registry_revision ?? 0) !== expectedRevision ||
        (pointer?.active_digest ?? null) !== expectedDigest ||
        (kind === 'deactivate' && (!pointer || pointer.state !== 'enabled'))) {
      return respond(409, 'revision_conflict');
    }

    let policyRevision: number | undefined;
    if (kind === 'activate') {
      const stage = await env.DB.prepare(
        `SELECT d.normalized_plan_json FROM workflow_definition_versions d
         WHERE d.definition_digest = ? AND d.workflow_id = ?
         AND EXISTS (SELECT 1 FROM definition_publications p
           WHERE p.definition_digest = d.definition_digest AND p.workflow_id = d.workflow_id
             AND p.repository_id = ?)`
      ).bind(nextDigest, workflowId, identity.repositoryId).first<{ normalized_plan_json: string }>();
      if (!stage) return respond(422, 'definition_not_approved');
      let plan: ReturnType<typeof validateVersionedWorkflowPlan>;
      try { plan = validateVersionedWorkflowPlan(JSON.parse(stage.normalized_plan_json)); }
      catch { return respond(422, 'invalid_plan'); }
      if (plan.id !== workflowId) return respond(422, 'invalid_plan');
      const revision = await env.DB.prepare(
        'SELECT revision FROM connection_policy_revision WHERE singleton = 1'
      ).first<{ revision: number }>();
      if (!revision) return respond(503, 'admin_storage_unavailable');
      policyRevision = revision.revision;
      for (const step of Object.values(plan.steps)) {
        const descriptor = getCapabilityDescriptor(step.uses);
        if (!descriptor || descriptor.executor !== step.executor ||
            (step.retryMaxAttempts ?? 1) > descriptor.maxAutomaticAttempts)
          return respond(422, 'unsupported_capability');
        if (step.uses !== 'mcp.call') continue;
        const connectionId = step.with.connection;
        const toolName = step.with.tool;
        if (typeof connectionId !== 'string' || typeof toolName !== 'string')
          return respond(422, 'invalid_reference');
        const approved = getConnection(connectionId);
        if (!approved?.tools[toolName]) return respond(422, 'connection_not_approved');
        const control = await env.DB.prepare(
          'SELECT disabled, allowed_tools_json FROM connection_controls WHERE connection_id = ?'
        ).bind(connectionId).first<{ disabled: number; allowed_tools_json: string }>();
        if (!control || control.disabled !== 0) return respond(422, 'connection_not_approved');
        const policy: unknown = JSON.parse(control.allowed_tools_json);
        if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
            !Array.isArray((policy as Record<string, unknown>)[toolName]) ||
            !(policy as Record<string, string[]>)[toolName]!.includes(approved.tools[toolName]!.effect))
          return respond(422, 'tool_not_approved');
      }
    }

    const now = new Date().toISOString();
    // The action claim and pointer mutation are a single D1 batch transaction.
    // Exact-revision conditions live in SQL, not merely in the earlier read.
    const applicable = pointer
      ? `EXISTS (SELECT 1 FROM workflow_active_definitions
          WHERE workflow_id = ? AND registry_revision = ? AND active_digest IS ?
            ${kind === 'deactivate' ? "AND state = 'enabled'" : ''})`
      : 'NOT EXISTS (SELECT 1 FROM workflow_active_definitions WHERE workflow_id = ?)';
    const conditions = kind === 'activate'
      ? `AND EXISTS (SELECT 1 FROM workflow_definition_versions d
           JOIN definition_publications p ON p.definition_digest = d.definition_digest
           WHERE d.definition_digest = ? AND d.workflow_id = ? AND p.workflow_id = ?
             AND p.repository_id = ?)
         AND (SELECT revision FROM connection_policy_revision WHERE singleton = 1) = ?`
      : '';
    const bind = pointer
      ? [workflowId, expectedRevision, expectedDigest]
      : [workflowId];
    const extra = kind === 'activate'
      ? [nextDigest, workflowId, workflowId, identity.repositoryId, policyRevision!] : [];
    const claim = env.DB.prepare(
      `INSERT INTO workflow_registry_actions
       (action_id, workflow_id, action_kind, previous_digest, next_digest,
        expected_revision, resulting_revision, repository_id, publisher_run_id,
        publisher_run_attempt, request_digest, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${applicable} ${conditions}`
    ).bind(actionId, workflowId, kind, pointer?.active_digest ?? null, nextDigest,
      expectedRevision, expectedRevision + 1, identity.repositoryId, identity.runId,
      identity.runAttempt, requestDigest, now, ...bind, ...extra);
    const guard = `EXISTS (SELECT 1 FROM workflow_registry_actions
      WHERE action_id = ? AND workflow_id = ? AND request_digest = ?)`;
    const mutate = pointer
      ? env.DB.prepare(
        `UPDATE workflow_active_definitions SET active_digest = ?, state = ?,
         registry_revision = registry_revision + 1, updated_at = ?,
         activated_at = CASE WHEN ? = 'enabled' THEN ? ELSE activated_at END
         WHERE workflow_id = ? AND registry_revision = ? AND active_digest IS ? AND ${guard}`
      ).bind(kind === 'activate' ? nextDigest : pointer.active_digest,
        kind === 'activate' ? 'enabled' : 'disabled', now,
        kind === 'activate' ? 'enabled' : 'disabled', now, workflowId, expectedRevision,
        expectedDigest, actionId, workflowId, requestDigest)
      : env.DB.prepare(
        `INSERT INTO workflow_active_definitions
         (workflow_id, active_digest, registry_revision, state, activated_at, updated_at)
         SELECT ?, ?, 1, 'enabled', ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM workflow_active_definitions WHERE workflow_id = ?)
           AND ${guard}`
      ).bind(workflowId, nextDigest, now, now, workflowId, actionId, workflowId, requestDigest);
    const result = await env.DB.batch([claim, mutate]);
    if (result[0]?.meta.changes !== 1 || result[1]?.meta.changes !== 1)
      return respond(409, 'revision_conflict');
    return success(expectedRevision + 1, pointer?.active_digest ?? null, nextDigest);
  } catch {
    try {
      const committed = await replay();
      if (committed) return committed;
    } catch { /* D1 read failures must not imply successful mutation. */ }
    return respond(503, 'admin_storage_unavailable');
  }
}
