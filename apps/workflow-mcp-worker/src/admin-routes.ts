import { registerApprovedConnection } from './connection-admin.js';
import { getConnection } from './connections.js';
import { verifyGitHubOidcToken, type GitHubOidcVerificationConfig } from './oidc.js';
import { GITHUB_EXECUTOR_CONFIG } from './platform-config.js';
import { getWorkflowRegistry } from './registry.js';
import type { Env } from './types.js';

const ADMIN_AUDIENCE = 'workflow-mcp-publisher';

type AdminEnv = Env & {
  ADMIN_PUBLISHER_REPOSITORY_ID?: string;
  ADMIN_PUBLISHER_WORKFLOW_REF?: string;
  ADMIN_PUBLISHER_REF?: string;
  ADMIN_PUBLISHER_WORKFLOW_SHA?: string;
};

export interface AdminRouteOptions {
  fetchImpl?: typeof fetch;
  nowSeconds?: number;
}

function reply(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

function required(value: string | undefined): string | undefined {
  return value && value.trim() === value && value.length > 0 ? value : undefined;
}

async function policySnapshot(env: AdminEnv): Promise<Record<string, unknown>> {
  const connections: Record<string, unknown> = {};
  // This is the bounded approved bootstrap configuration; never expose connection.auth or Env.
  for (const id of ['workflow-self', 'raindrop']) {
    const connection = getConnection(id);
    if (!connection) throw new Error('Approved connection configuration is unavailable.');
    connections[id] = {
      tools: Object.fromEntries(Object.entries(connection.tools).map(([name, tool]) => [
        name, {
          effect: tool.effect,
          ...(tool.operationIdArgument ? { operationIdArgument: tool.operationIdArgument } : {})
        }
      ]))
    };
  }
  const webhookBindings: Array<{ workflowId: string; triggerId: string; referenceId: string }> = [];
  for (const entry of getWorkflowRegistry()) {
    const plan = entry.plan as { triggers?: Array<Record<string, unknown>> };
    for (const trigger of plan.triggers ?? []) {
      if (trigger.type === 'webhook' && typeof trigger.id === 'string' && typeof trigger.secret === 'string') {
        webhookBindings.push({
          workflowId: entry.metadata.id,
          triggerId: trigger.id,
          referenceId: trigger.secret
        });
      }
    }
  }
  // A missing D1 binding is a configuration failure, never an approval of
  // synthetic bootstrap data from an unverified static policy.
  if (!env.DB) throw new Error('Approved policy store is unavailable.');
  const revision = await env.DB.prepare(
    'SELECT revision FROM connection_policy_revision WHERE singleton = 1'
  ).first<{ revision: number }>();
  if (!revision || !Number.isSafeInteger(revision.revision) || revision.revision < 1) {
    throw new Error('Approved policy revision is unavailable.');
  }
  const listed = await env.DB.prepare(
    'SELECT connection_id, current_version, disabled, allowed_tools_json FROM connection_controls ORDER BY connection_id LIMIT 33'
  ).all<{
    connection_id: string; current_version: number; disabled: number; allowed_tools_json: string
  }>();
  if (listed.results.length > 32) throw new Error('Approved policy snapshot exceeds bound.');
  for (const control of listed.results) {
    const original = getConnection(control.connection_id);
    if (!original || !Number.isSafeInteger(control.current_version) || control.current_version < 1 ||
        (control.disabled !== 0 && control.disabled !== 1)) {
      throw new Error('Approved policy snapshot is invalid.');
    }
    const parsed: unknown = JSON.parse(control.allowed_tools_json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Approved policy snapshot is invalid.');
    }
    const enabledTools: Record<string, unknown> = {};
    for (const [name, effects] of Object.entries(parsed)) {
      const tool = original.tools[name];
      if (!tool || !Array.isArray(effects) || effects.length !== 1 || effects[0] !== tool.effect) {
        throw new Error('Approved policy snapshot is invalid.');
      }
      enabledTools[name] = {
        effect: tool.effect,
        ...(tool.operationIdArgument ? { operationIdArgument: tool.operationIdArgument } : {})
      };
    }
    connections[control.connection_id] = {
      version: control.current_version,
      enabled: control.disabled === 0,
      tools: enabledTools
    };
  }
  // Reject a snapshot that straddled a concurrent registration/revocation.
  // The trusted publisher must retry rather than compile against a torn view.
  const after = await env.DB.prepare(
    'SELECT revision FROM connection_policy_revision WHERE singleton = 1'
  ).first<{ revision: number }>();
  if (!after || after.revision !== revision.revision) {
    throw new Error('Approved policy changed during snapshot.');
  }
  return { revision: revision.revision, connections, webhookBindings };
}

export async function handleAdminRoute(
  request: Request,
  env: AdminEnv,
  options: AdminRouteOptions = {}
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/admin/')) return null;
  const snapshotRoute = url.pathname === '/admin/connections/snapshot';
  const disableRoute = url.pathname === '/admin/connections/disable';
  const registerRoute = url.pathname === '/admin/connections/register';
  if (!snapshotRoute && !disableRoute && !registerRoute) return reply(404, 'not_found');
  if (request.method !== (snapshotRoute ? 'GET' : 'POST')) return reply(405, 'method_not_allowed');

  const repositoryId = required(env.ADMIN_PUBLISHER_REPOSITORY_ID);
  const workflowRef = required(env.ADMIN_PUBLISHER_WORKFLOW_REF);
  const ref = required(env.ADMIN_PUBLISHER_REF);
  if (!repositoryId || !workflowRef || !ref) {
    return reply(503, 'admin_auth_not_configured');
  }

  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
    return reply(401, 'unauthorized');
  }
  try {
    const oidc: GitHubOidcVerificationConfig = { ...GITHUB_EXECUTOR_CONFIG.oidc, audience: ADMIN_AUDIENCE };
    const identity = await verifyGitHubOidcToken(
      authorization.slice(7), oidc, options.fetchImpl ?? fetch, options.nowSeconds
    );
    if (identity.repositoryId !== repositoryId || identity.workflowRef !== workflowRef ||
        identity.ref !== ref || (env.ADMIN_PUBLISHER_WORKFLOW_SHA &&
        identity.workflowSha !== env.ADMIN_PUBLISHER_WORKFLOW_SHA)) {
      return reply(403, 'publisher_identity_mismatch');
    }
  } catch {
    // Never reflect raw credentials, JWT parsing details or platform Secret names.
    return reply(401, 'unauthorized');
  }
  if (disableRoute) return disableConnection(request, env);
  if (registerRoute) return registerApprovedConnection(request, env.DB);
  try {
    return Response.json(await policySnapshot(env), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return reply(503, 'admin_storage_unavailable');
  }
}

/** CAS disable is deliberately narrower than general configuration registration. */
async function disableConnection(request: Request, env: AdminEnv): Promise<Response> {
  const size = Number(request.headers.get('content-length') ?? 0);
  if (!Number.isFinite(size) || size > 8192) return reply(413, 'body_too_large');
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return reply(400, 'invalid_body');
  }
  if (raw.length > 8192) return reply(413, 'body_too_large');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return reply(400, 'invalid_body');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reply(400, 'invalid_body');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join(',') !== 'actionId,connectionId,expectedRevision') {
    return reply(400, 'invalid_body');
  }
  const { actionId, connectionId, expectedRevision } = body;
  if (typeof actionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(actionId) ||
      typeof connectionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(connectionId) ||
      !Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
    return reply(400, 'invalid_body');
  }

  const digestBytes = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(JSON.stringify([actionId, connectionId, expectedRevision]))
  );
  const digest = Array.from(new Uint8Array(digestBytes)).map(byte => byte.toString(16).padStart(2, '0')).join('');
  try {
    const existing = await env.DB.prepare(
      'SELECT connection_id, action_kind, request_digest, resulting_revision FROM connection_admin_actions WHERE action_id = ?'
    ).bind(actionId).first<{
      connection_id: string;
      action_kind: string;
      request_digest: string;
      resulting_revision: number;
    }>();
    if (existing) {
      if (existing.connection_id !== connectionId || existing.action_kind !== 'disable' ||
          existing.request_digest !== digest) return reply(409, 'action_conflict');
      return Response.json({ connectionId, revision: existing.resulting_revision, disabled: true }, {
        headers: { 'Cache-Control': 'no-store' }
      });
    }
    // D1 batch executes the precondition, action claim and control update in
    // one transaction. A concurrent competing action cannot claim this CAS.
    const now = new Date().toISOString();
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO connection_admin_actions
         (action_id, connection_id, action_kind, request_digest, resulting_revision, created_at)
         SELECT ?, connection_id, 'disable', ?, revision + 1, ?
         FROM connection_controls
         WHERE connection_id = ? AND revision = ? AND disabled = 0`
      ).bind(actionId, digest, now, connectionId, expectedRevision as number),
      env.DB.prepare(
        `UPDATE connection_controls SET disabled = 1, revision = revision + 1, updated_at = ?
         WHERE connection_id = ? AND revision = ? AND disabled = 0
           AND EXISTS (SELECT 1 FROM connection_admin_actions
                       WHERE action_id = ? AND request_digest = ?)`
      ).bind(now, connectionId, expectedRevision as number, actionId, digest),
      env.DB.prepare(
        `UPDATE connection_policy_revision SET revision = revision + 1
         WHERE singleton = 1 AND EXISTS (
           SELECT 1 FROM connection_admin_actions WHERE action_id = ? AND request_digest = ?
         )`
      ).bind(actionId, digest)
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1 ||
        results[2]?.meta.changes !== 1) {
      return reply(409, 'revision_conflict');
    }
    return Response.json({ connectionId, revision: (expectedRevision as number) + 1, disabled: true }, {
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch {
    // A concurrently committed identical action may have beaten our first
    // lookup. Reconcile its durable record without issuing another mutation.
    try {
      const committed = await env.DB.prepare(
        'SELECT connection_id, action_kind, request_digest, resulting_revision FROM connection_admin_actions WHERE action_id = ?'
      ).bind(actionId).first<{
        connection_id: string; action_kind: string; request_digest: string; resulting_revision: number
      }>();
      if (committed) {
        if (committed.connection_id !== connectionId || committed.action_kind !== 'disable' ||
            committed.request_digest !== digest) return reply(409, 'action_conflict');
        return Response.json({
          connectionId, revision: committed.resulting_revision, disabled: true
        }, { headers: { 'Cache-Control': 'no-store' } });
      }
    } catch {
      // Fail closed if D1 cannot supply the authoritative action outcome.
    }
    return reply(503, 'admin_storage_unavailable');
  }
}
