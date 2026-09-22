import { getConnection } from './connections.js';
import type { EffectClass } from './capabilities.js';

function error(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers: { 'Cache-Control': 'no-store' } });
}

interface ApprovedRegistration {
  actionId: string;
  connectionId: string;
  expectedRevision: number;
  tools: string[];
}

function parseRegistration(value: unknown): ApprovedRegistration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).sort().join(',') !== 'actionId,connectionId,expectedRevision,tools') return null;
  if (typeof body.actionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.actionId) ||
      typeof body.connectionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.connectionId) ||
      !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0 ||
      !Array.isArray(body.tools) || body.tools.length < 1 || body.tools.length > 32 ||
      !body.tools.every(t => typeof t === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(t)) ||
      new Set(body.tools).size !== body.tools.length) return null;
  return body as unknown as ApprovedRegistration;
}

/**
 * First v0.2 tracer: versioned registration of an already approved bundled
 * endpoint and its existing Worker Secret binding. Neither the request nor
 * persisted config can introduce a new endpoint, binding, or tool authority.
 */
export async function registerApprovedConnection(request: Request, db: D1Database): Promise<Response> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (!Number.isFinite(declared) || declared > 8192) return error(413, 'body_too_large');
  let raw: string;
  try { raw = await request.text(); } catch { return error(400, 'invalid_body'); }
  if (new TextEncoder().encode(raw).byteLength > 8192) return error(413, 'body_too_large');
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { return error(400, 'invalid_body'); }
  const input = parseRegistration(decoded);
  if (!input) return error(400, 'invalid_body');
  const approved = getConnection(input.connectionId);
  if (!approved || input.tools.some(name => !approved.tools[name])) return error(403, 'connection_not_approved');

  const tools = Object.fromEntries(input.tools.sort().map(name => [name, approved.tools[name]!]));
  const config = JSON.stringify({
    endpoint: approved.endpoint,
    transport: approved.transport,
    protocolVersion: approved.protocolVersion,
    authSecret: approved.auth.secret,
    trustAnnotations: false,
    tools
  });
  const allowedTools: Record<string, EffectClass[]> = {};
  for (const [name, tool] of Object.entries(tools)) allowedTools[name] = [tool.effect];
  const policy = JSON.stringify(allowedTools);
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([input.connectionId, input.expectedRevision, config]))
  );
  const digest = [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
  const revision = input.expectedRevision + 1;
  const now = new Date().toISOString();
  try {
    const prior = await db.prepare(
      'SELECT connection_id, action_kind, request_digest, resulting_revision FROM connection_admin_actions WHERE action_id = ?'
    ).bind(input.actionId).first<{
      connection_id: string; action_kind: string; request_digest: string; resulting_revision: number
    }>();
    if (prior) {
      if (prior.connection_id !== input.connectionId || prior.action_kind !== 'register' ||
          prior.request_digest !== digest) return error(409, 'action_conflict');
      return Response.json({ connectionId: input.connectionId, version: revision, revision: prior.resulting_revision }, {
        headers: { 'Cache-Control': 'no-store' }
      });
    }

    const control = await db.prepare(
      'SELECT current_version, revision, disabled, allowed_tools_json FROM connection_controls WHERE connection_id = ?'
    ).bind(input.connectionId).first<{
      current_version: number; revision: number; disabled: number; allowed_tools_json: string
    }>();
    if ((!control && input.expectedRevision !== 0) ||
        (control && (control.revision !== input.expectedRevision || control.disabled !== 0))) {
      return error(409, 'revision_conflict');
    }
    if (control) {
      // This tracer supports tightening only. A later explicit approval process
      // must authorize any expansion; a stale snapshot cannot restore it.
      const previous = JSON.parse(control.allowed_tools_json) as Record<string, string[]>;
      if (Object.keys(allowedTools).some(name => !Array.isArray(previous[name]) ||
          !previous[name].includes(allowedTools[name]![0]!))) {
        return error(403, 'policy_escalation');
      }
    }
    const existingVersion = await db.prepare(
      'SELECT config_json FROM connection_config_versions WHERE connection_id = ? AND version = ?'
    ).bind(input.connectionId, revision).first<{ config_json: string }>();
    if (existingVersion && existingVersion.config_json !== config) return error(409, 'version_conflict');

    const results = await db.batch([
      db.prepare(
        `INSERT OR IGNORE INTO connection_config_versions
         (connection_id, version, config_json, created_at) VALUES (?, ?, ?, ?)`
      ).bind(input.connectionId, revision, config, now),
      db.prepare(
        `INSERT INTO connection_admin_actions
         (action_id, connection_id, action_kind, request_digest, resulting_revision, created_at)
         SELECT ?, ?, 'register', ?, ?, ?
         WHERE (? = 0 AND NOT EXISTS (
           SELECT 1 FROM connection_controls WHERE connection_id = ?
         )) OR EXISTS (
           SELECT 1 FROM connection_controls WHERE connection_id = ?
             AND revision = ? AND disabled = 0
         )`
      ).bind(input.actionId, input.connectionId, digest, revision, now,
        input.expectedRevision, input.connectionId, input.connectionId, input.expectedRevision),
      db.prepare(
        `INSERT INTO connection_controls
         (connection_id, current_version, revision, disabled, allowed_tools_json, updated_at)
         SELECT ?, ?, ?, 0, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM connection_admin_actions WHERE action_id = ? AND request_digest = ?
         )
         ON CONFLICT(connection_id) DO UPDATE SET
           current_version = excluded.current_version,
           revision = excluded.revision,
           allowed_tools_json = excluded.allowed_tools_json,
           updated_at = excluded.updated_at
         WHERE connection_controls.revision = ? AND connection_controls.disabled = 0`
      ).bind(input.connectionId, revision, revision, policy, now,
        input.actionId, digest, input.expectedRevision),
      db.prepare(
        `UPDATE connection_policy_revision SET revision = revision + 1
         WHERE singleton = 1 AND EXISTS (
           SELECT 1 FROM connection_admin_actions WHERE action_id = ? AND request_digest = ?
         )`
      ).bind(input.actionId, digest)
    ]);
    if (results[1]?.meta.changes !== 1 || results[2]?.meta.changes !== 1 ||
        results[3]?.meta.changes !== 1) {
      return error(409, 'revision_conflict');
    }
    return Response.json({ connectionId: input.connectionId, version: revision, revision }, {
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch {
    // Concurrent replay may lose the unique action-ID race after the initial
    // lookup. Reconcile the committed action rather than retrying the mutation.
    try {
      const committed = await db.prepare(
        'SELECT connection_id, action_kind, request_digest, resulting_revision FROM connection_admin_actions WHERE action_id = ?'
      ).bind(input.actionId).first<{
        connection_id: string; action_kind: string; request_digest: string; resulting_revision: number
      }>();
      if (committed) {
        if (committed.connection_id !== input.connectionId || committed.action_kind !== 'register' ||
            committed.request_digest !== digest) return error(409, 'action_conflict');
        return Response.json({
          connectionId: input.connectionId, version: revision, revision: committed.resulting_revision
        }, { headers: { 'Cache-Control': 'no-store' } });
      }
    } catch {
      // A failed reconciliation must never grant authority.
    }
    return error(503, 'admin_storage_unavailable');
  }
}
