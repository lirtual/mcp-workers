import { validateVersionedWorkflowPlan } from './runtime-plan-validation.js';
import { isProtectedWebhookSecret } from './webhook-secret-policy.js';

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const SHA = /^[0-9a-f]{64}$/;
const SECRET = /^[A-Z][A-Z0-9_]{0,127}$/;
function error(status: number, code: string): Response {
  return Response.json({ error: code }, {
    status, headers: { 'Cache-Control': 'no-store' }
  });
}

/**
 * Called only after the separate publisher OIDC audience/repository/workflow
 * identity gate in admin-routes. Does not accept a binding supplied by YAML
 * as sufficient authorization. Initial registration is immutable; intentional
 * rotation needs a separate approved revision protocol.
 */
export async function registerApprovedWebhookScope(
  request: Request, db: D1Database
): Promise<Response> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(length) || length > 8192) return error(413, 'body_too_large');
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 8192) return error(413, 'body_too_large');
    body = JSON.parse(text);
  } catch {
    return error(400, 'invalid_body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return error(400, 'invalid_body');
  const record = body as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !==
      'actionId,definitionDigest,expectedPolicyRevision,secretName,triggerId,workflowId') {
    return error(400, 'invalid_body');
  }
  const { actionId, workflowId, triggerId, definitionDigest, secretName, expectedPolicyRevision } = record;
  if (typeof actionId !== 'string' || !ID.test(actionId) ||
      typeof workflowId !== 'string' || !ID.test(workflowId) ||
      typeof triggerId !== 'string' || !ID.test(triggerId) ||
      typeof definitionDigest !== 'string' || !SHA.test(definitionDigest) ||
      typeof secretName !== 'string' || !SECRET.test(secretName) ||
      isProtectedWebhookSecret(secretName) ||
      !Number.isSafeInteger(expectedPolicyRevision) || (expectedPolicyRevision as number) < 1) {
    return error(400, 'invalid_body');
  }

  try {
    // Read-only validation is advisory to the transactional revision claim.
    // The stored definition is immutable; registration never changes its plan.
    const definition = await db.prepare(
      'SELECT workflow_id, normalized_plan_json FROM workflow_definition_versions WHERE definition_digest = ?'
    ).bind(definitionDigest).first<{ workflow_id: string; normalized_plan_json: string }>();
    if (!definition || definition.workflow_id !== workflowId) return error(404, 'definition_not_found');
    const plan = validateVersionedWorkflowPlan(JSON.parse(definition.normalized_plan_json));
    const matching = plan.triggers.filter(trigger => trigger.type === 'webhook' && trigger.id === triggerId);
    if (plan.id !== workflowId || matching.length !== 1 || matching[0]?.secret !== secretName) {
      return error(400, 'secret_scope_not_declared');
    }

    const previous = await db.prepare(
      `SELECT workflow_id, trigger_id, definition_digest, secret_name, expected_policy_revision
       FROM webhook_secret_scope_actions WHERE action_id = ?`
    ).bind(actionId).first<{
      workflow_id: string; trigger_id: string; definition_digest: string;
      secret_name: string; expected_policy_revision: number
    }>();
    const same = (row: typeof previous) => row?.workflow_id === workflowId &&
      row.trigger_id === triggerId && row.definition_digest === definitionDigest &&
      row.secret_name === secretName && row.expected_policy_revision === expectedPolicyRevision;
    if (previous) {
      if (!same(previous)) return error(409, 'action_conflict');
      const retained = await db.prepare(
        `SELECT 1 AS ok FROM workflow_webhook_secret_scopes s
         JOIN connection_policy_revision p ON p.singleton = 1
         WHERE s.workflow_id = ? AND s.trigger_id = ? AND s.definition_digest = ?
           AND s.secret_name = ? AND s.enabled = 1 AND s.policy_revision = p.revision`
      ).bind(workflowId, triggerId, definitionDigest, secretName).first<{ ok: number }>();
      if (!retained) return error(409, 'scope_conflict');
      return Response.json({ workflowId, triggerId, definitionDigest, registered: true }, {
        headers: { 'Cache-Control': 'no-store' }
      });
    }

    const now = new Date().toISOString();
    const results = await db.batch([
      db.prepare(
        `INSERT OR IGNORE INTO webhook_secret_scope_actions
         (action_id, workflow_id, trigger_id, definition_digest, secret_name,
          expected_policy_revision, resulting_policy_revision, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM connection_policy_revision
                       WHERE singleton = 1 AND revision = ?)
           AND NOT EXISTS (SELECT 1 FROM workflow_webhook_secret_scopes
             WHERE workflow_id = ? AND trigger_id = ? AND definition_digest = ?)`
      ).bind(actionId, workflowId, triggerId, definitionDigest, secretName,
        expectedPolicyRevision, expectedPolicyRevision, now, expectedPolicyRevision,
        workflowId, triggerId, definitionDigest),
      db.prepare(
        `INSERT OR IGNORE INTO workflow_webhook_secret_scopes
         (workflow_id, trigger_id, definition_digest, secret_name, policy_revision, enabled, approved_at)
         SELECT ?, ?, ?, ?, ?, 1, ?
         WHERE EXISTS (SELECT 1 FROM webhook_secret_scope_actions
                       WHERE action_id = ? AND workflow_id = ? AND trigger_id = ?
                         AND definition_digest = ? AND secret_name = ? AND expected_policy_revision = ?)`
      ).bind(workflowId, triggerId, definitionDigest, secretName, expectedPolicyRevision, now,
        actionId, workflowId, triggerId, definitionDigest, secretName, expectedPolicyRevision)
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      // Fail closed on a preexisting scope or concurrent revision change.
      return error(409, 'scope_conflict');
    }
    return Response.json({ workflowId, triggerId, definitionDigest, registered: true }, {
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch {
    // Never reflect token names, SQL diagnostics or raw admin credentials.
    return error(503, 'admin_storage_unavailable');
  }
}
