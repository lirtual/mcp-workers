import { getCapabilityDescriptor } from './capabilities.js';
import { compileTimeMcpRetryLimitForApprovedTool } from './effective-policy.js';
import { getConnection } from './connections.js';
import { getWorkflowRegistry } from './registry.js';
import { validateVersionedWorkflowPlan } from './runtime-plan-validation.js';
import type { GitHubJobIdentity } from './oidc.js';
import type { Env } from './types.js';

const MAX_BODY_BYTES = 320 * 1024;
const MAX_PLAN_BYTES = 256 * 1024;

function failure(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value as Record<string, unknown>).sort()
      .map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

interface StagePayload {
  workflowId: string;
  definitionDigest: string;
  sourceSha: string;
  sourcePath: string;
  policyRevision: number;
  connectionVersions: Record<string, number>;
  plan: unknown;
}

function parseEnvelope(value: unknown): StagePayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !==
      'connectionVersions,definitionDigest,plan,policyRevision,sourcePath,sourceSha,workflowId' ||
      typeof item.workflowId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(item.workflowId) ||
      typeof item.definitionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.definitionDigest) ||
      typeof item.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(item.sourceSha) ||
      typeof item.sourcePath !== 'string' || item.sourcePath.length < 1 || item.sourcePath.length > 512 ||
      item.sourcePath.startsWith('/') || item.sourcePath.includes('\\') ||
      item.sourcePath.split('/').some(x => x === '..' || x === '.' || x === '') ||
      !Number.isSafeInteger(item.policyRevision) || (item.policyRevision as number) < 1 ||
      !item.connectionVersions || typeof item.connectionVersions !== 'object' ||
      Array.isArray(item.connectionVersions)) return null;
  const refs = item.connectionVersions as Record<string, unknown>;
  if (Object.keys(refs).length > 32 || Object.entries(refs).some(([id, version]) =>
    !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(id) ||
    !Number.isSafeInteger(version) || (version as number) < 1)) return null;
  return item as unknown as StagePayload;
}

/**
 * Stage immutable v1 IR only. Never activate a workflow or accept YAML here.
 * The protected publisher must verify source checkout and catalog SHA before
 * submitting this bounded envelope. Only its cryptographically verified
 * physical GitHub job identity is retained as publisher evidence.
 */
export async function stageDefinition(
  request: Request,
  env: Env,
  publisher: GitHubJobIdentity
): Promise<Response> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (!Number.isFinite(length) || length < 0 || length > MAX_BODY_BYTES) {
    return failure(413, 'body_too_large');
  }
  // Enforce the 320 KiB limit while streaming, even for a missing or forged
  // Content-Length. Never materialize an unbounded request body in the Worker.
  const reader = request.body?.getReader();
  if (!reader) return failure(400, 'invalid_body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    let part: ReadableStreamReadResult<Uint8Array>;
    try { part = await reader.read(); } catch { return failure(400, 'invalid_body'); }
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return failure(413, 'body_too_large');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let raw: string;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return failure(400, 'invalid_body'); }
  let input: unknown;
  try { input = JSON.parse(raw); } catch { return failure(400, 'invalid_body'); }
  const envelope = parseEnvelope(input);
  if (!envelope) return failure(400, 'invalid_envelope');

  let plan: ReturnType<typeof validateVersionedWorkflowPlan>;
  try { plan = validateVersionedWorkflowPlan(envelope.plan); } catch {
    return failure(400, 'invalid_plan');
  }
  if (plan.id !== envelope.workflowId) return failure(400, 'workflow_mismatch');
  const normalized = canonical(plan);
  if (new TextEncoder().encode(normalized).byteLength > MAX_PLAN_BYTES) {
    return failure(413, 'plan_too_large');
  }
  if (await digest(normalized) !== envelope.definitionDigest) return failure(400, 'digest_mismatch');

  try {
    const revision = await env.DB.prepare(
      'SELECT revision FROM connection_policy_revision WHERE singleton = 1'
    ).first<{ revision: number }>();
    if (!revision || revision.revision !== envelope.policyRevision) return failure(409, 'stale_policy');

    const referenced = new Set<string>();
    for (const step of Object.values(plan.steps)) {
      const descriptor = getCapabilityDescriptor(step.uses);
      if (!descriptor || descriptor.executor !== step.executor) return failure(400, 'unsupported_capability');
      if (Object.keys(step.with).some(name => !descriptor.allowedInputs.has(name))) {
        return failure(400, 'invalid_capability_input');
      }
      if (step.uses !== 'mcp.call') {
        if (step.retryMaxAttempts && step.retryMaxAttempts > descriptor.maxAutomaticAttempts) {
          return failure(400, 'unsafe_retry');
        }
        continue;
      }
      const connectionId = step.with.connection;
      const toolName = step.with.tool;
      if (typeof connectionId !== 'string' || typeof toolName !== 'string') {
        return failure(400, 'invalid_connection_reference');
      }
      referenced.add(connectionId);
      const approved = getConnection(connectionId);
      const tool = approved?.tools[toolName];
      if (!tool || !Number.isSafeInteger(envelope.connectionVersions[connectionId])) {
        return failure(403, 'unapproved_connection');
      }
      const row = await env.DB.prepare(
        'SELECT current_version, disabled, allowed_tools_json FROM connection_controls WHERE connection_id = ?'
      ).bind(connectionId).first<{
        current_version: number; disabled: number; allowed_tools_json: string
      }>();
      if (!row || row.disabled !== 0 || row.current_version !== envelope.connectionVersions[connectionId]) {
        return failure(409, 'stale_connection');
      }
      const allowed: unknown = JSON.parse(row.allowed_tools_json);
      if (!allowed || typeof allowed !== 'object' || Array.isArray(allowed) ||
          !Array.isArray((allowed as Record<string, unknown>)[toolName]) ||
          !(allowed as Record<string, string[]>)[toolName]!.includes(tool.effect)) {
        return failure(403, 'unapproved_tool');
      }
      const limit = compileTimeMcpRetryLimitForApprovedTool(tool.effect);
      if (step.retryMaxAttempts && step.retryMaxAttempts > limit) return failure(400, 'unsafe_retry');
    }
    const keys = Object.keys(envelope.connectionVersions);
    if (keys.length !== referenced.size || keys.some(key => !referenced.has(key))) {
      return failure(400, 'connection_reference_mismatch');
    }

    const webhookRefs = new Set<string>();
    for (const existing of getWorkflowRegistry()) {
      const candidate = existing.plan as { triggers?: Array<Record<string, unknown>> };
      for (const trigger of candidate.triggers ?? []) {
        if (trigger.type === 'webhook' && typeof trigger.secret === 'string' &&
            typeof trigger.id === 'string') {
          webhookRefs.add(existing.metadata.id + ':' + trigger.id + ':' + trigger.secret);
        }
      }
    }
    for (const trigger of plan.triggers) {
      if (trigger.type === 'webhook' && (typeof trigger.secret !== 'string' || !webhookRefs.has(plan.id + ':' + String(trigger.id) + ':' + trigger.secret))) {
        return failure(403, 'unapproved_webhook_reference');
      }
    }

    const stored = await env.DB.prepare(
      'SELECT workflow_id, normalized_plan_json FROM workflow_definition_versions WHERE definition_digest = ?'
    ).bind(envelope.definitionDigest).first<{ workflow_id: string; normalized_plan_json: string }>();
    if (stored && (stored.workflow_id !== plan.id || canonical(JSON.parse(stored.normalized_plan_json)) !== normalized)) {
      return failure(409, 'immutable_definition_conflict');
    }

    const publicationId = await digest(JSON.stringify([
      publisher.repositoryId, publisher.runId, publisher.runAttempt,
      envelope.sourceSha, envelope.sourcePath, envelope.definitionDigest
    ]));
    const now = new Date().toISOString();
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO workflow_definition_versions
         (definition_digest, workflow_id, dsl_version, normalized_plan_json, source_path, source_commit, created_at)
         SELECT ?, ?, 1, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM connection_policy_revision WHERE singleton = 1 AND revision = ?)`
      ).bind(envelope.definitionDigest, plan.id, normalized, envelope.sourcePath,
        envelope.sourceSha, now, envelope.policyRevision),
      env.DB.prepare(
        `INSERT OR IGNORE INTO definition_publications
         (publication_id, workflow_id, definition_digest, source_sha, source_path,
          publisher_repository_id, publisher_run_id, publisher_run_attempt,
          publisher_workflow_sha, policy_revision, state, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?
         WHERE EXISTS (SELECT 1 FROM connection_policy_revision WHERE singleton = 1 AND revision = ?)
           AND EXISTS (SELECT 1 FROM workflow_definition_versions
                       WHERE definition_digest = ? AND normalized_plan_json = ?)`
      ).bind(publicationId, plan.id, envelope.definitionDigest, envelope.sourceSha,
        envelope.sourcePath, publisher.repositoryId, publisher.runId, publisher.runAttempt,
        publisher.workflowSha, envelope.policyRevision, now, envelope.policyRevision,
        envelope.definitionDigest, normalized)
    ]);
    const row = await env.DB.prepare(
      'SELECT publication_id FROM definition_publications WHERE publication_id = ?'
    ).bind(publicationId).first<{ publication_id: string }>();
    if (!row) return failure(409, 'stale_policy_or_conflict');
    // An identical repeated stage remains idempotent. The Run registry is untouched.
    return Response.json({
      workflowId: plan.id, definitionDigest: envelope.definitionDigest,
      publicationId, staged: true, alreadyStaged: results[1]?.meta.changes === 0
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return failure(503, 'admin_storage_unavailable');
  }
}
