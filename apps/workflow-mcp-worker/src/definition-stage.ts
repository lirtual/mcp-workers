import { validateVersionedWorkflowPlan } from './runtime-plan-validation.js';
import { getCapabilityDescriptor } from './capabilities.js';
import { getConnection } from './connections.js';
import type { GitHubJobIdentity } from './oidc.js';
import type { Env } from './types.js';

const MAX_BODY = 320 * 1024;
const MAX_PLAN = 256 * 1024;
const HEX = /^[0-9a-f]{64}$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;

function reject(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers: { 'Cache-Control': 'no-store' } });
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}
async function digest(content: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

/** A staging operation has no activation or mutable Run side effects. */
export async function stageDefinition(
  request: Request,
  env: Env,
  identity: GitHubJobIdentity
): Promise<Response> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (!Number.isFinite(declared) || declared > MAX_BODY) return reject(413, 'body_too_large');
  let raw: string;
  try { raw = await request.text(); } catch { return reject(400, 'invalid_body'); }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY) return reject(413, 'body_too_large');
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { return reject(400, 'invalid_body'); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return reject(400, 'invalid_body');
  const data = decoded as Record<string, unknown>;
  if (Object.keys(data).sort().join(',') !==
      'definitionDigest,metadata,plan,policyRevision,publicationId,sourcePath,sourceSha,workflowId') {
    return reject(400, 'invalid_body');
  }
  const { definitionDigest, metadata, plan, policyRevision, publicationId, sourcePath, sourceSha, workflowId } = data;
  if (typeof definitionDigest !== 'string' || !HEX.test(definitionDigest) ||
      typeof sourceSha !== 'string' || !SOURCE_SHA.test(sourceSha) ||
      typeof publicationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(publicationId) ||
      typeof sourcePath !== 'string' || !/^workflows\/[A-Za-z0-9_./-]{1,240}\.ya?ml$/.test(sourcePath) ||
      sourcePath.includes('..') || typeof workflowId !== 'string' ||
      !Number.isSafeInteger(policyRevision) || (policyRevision as number) < 1) {
    return reject(400, 'invalid_body');
  }
  let normalized: ReturnType<typeof validateVersionedWorkflowPlan>;
  try { normalized = validateVersionedWorkflowPlan(plan); }
  catch { return reject(422, 'invalid_plan'); }
  if (normalized.id !== workflowId) return reject(422, 'metadata_mismatch');
  // Metadata is compiler-derived, not publisher-authored authority. Verify
  // every field against the normalized plan before recording a claim.
  const expectedMetadata = {
    id: normalized.id,
    name: normalized.name,
    ...(normalized.description ? { description: normalized.description } : {}),
    definitionDigest,
    triggerTypes: normalized.triggers.map(trigger => trigger.type),
    inputs: normalized.inputs,
    stepCapabilities: [...new Set(Object.values(normalized.steps).map(step => step.uses))]
  };
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
      JSON.stringify(canonical(metadata)) !== JSON.stringify(canonical(expectedMetadata))) {
    return reject(422, 'metadata_mismatch');
  }
  const serialized = JSON.stringify(canonical(normalized));
  if (new TextEncoder().encode(serialized).byteLength > MAX_PLAN) return reject(413, 'plan_too_large');
  if (await digest(serialized) !== definitionDigest) return reject(422, 'digest_mismatch');

  try {
    const priorRevision = await env.DB.prepare(
      'SELECT revision FROM connection_policy_revision WHERE singleton = 1'
    ).first<{ revision: number }>();
    if (!priorRevision || priorRevision.revision !== policyRevision) return reject(409, 'stale_policy');
    for (const step of Object.values(normalized.steps)) {
      const descriptor = getCapabilityDescriptor(step.uses);
      if (!descriptor || descriptor.executor !== step.executor) return reject(422, 'unsupported_capability');
      if (step.uses !== 'mcp.call') {
        if ((step.retryMaxAttempts ?? 1) > descriptor.maxAutomaticAttempts) return reject(422, 'unsafe_retry');
        continue;
      }
      const connectionId = step.with.connection;
      const toolName = step.with.tool;
      if (typeof connectionId !== 'string' || typeof toolName !== 'string') return reject(422, 'invalid_reference');
      const approved = getConnection(connectionId);
      if (!approved || !approved.tools[toolName]) return reject(422, 'invalid_reference');
      const control = await env.DB.prepare(
        'SELECT current_version, disabled, allowed_tools_json FROM connection_controls WHERE connection_id = ?'
      ).bind(connectionId).first<{
        current_version: number; disabled: number; allowed_tools_json: string
      }>();
      if (!control || control.disabled !== 0) return reject(422, 'connection_not_approved');
      const policy: unknown = JSON.parse(control.allowed_tools_json);
      if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
          !Array.isArray((policy as Record<string, unknown>)[toolName]) ||
          !(policy as Record<string, string[]>)[toolName]!.includes(approved.tools[toolName]!.effect)) {
        return reject(422, 'tool_not_approved');
      }
      if ((step.retryMaxAttempts ?? 1) > (
        approved.tools[toolName]!.effect === 'read' ? 3 :
        approved.tools[toolName]!.effect === 'idempotent_write' ? 2 : 1
      )) return reject(422, 'unsafe_retry');
    }
    for (const trigger of normalized.triggers) {
      if (trigger.type !== 'webhook') continue;
      // T04 only accepts webhook bindings already present in the bundled
      // approved registry; dynamic binding provisioning is not a stage action.
      const reference = trigger.secret;
      if (typeof reference !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(reference)) {
        return reject(422, 'invalid_reference');
      }
      const { getWorkflowRegistry } = await import('./registry.js');
      const permitted = getWorkflowRegistry().some(entry =>
        entry.metadata.id === workflowId &&
        (entry.plan as { triggers?: Array<{ type: string; id?: string; secret?: string }> })
          .triggers?.some(t => t.type === 'webhook' && t.id === trigger.id && t.secret === reference));
      if (!permitted) return reject(422, 'webhook_not_approved');
    }
    const revision = await env.DB.prepare(
      'SELECT revision FROM connection_policy_revision WHERE singleton = 1'
    ).first<{ revision: number }>();
    if (!revision || revision.revision !== policyRevision) return reject(409, 'stale_policy');

    const existing = await env.DB.prepare(
      'SELECT workflow_id, definition_digest, source_sha, repository_id, publisher_run_id, publisher_run_attempt FROM definition_publications WHERE publication_id = ?'
    ).bind(publicationId).first<{
      workflow_id: string; definition_digest: string; source_sha: string; repository_id: string;
      publisher_run_id: string; publisher_run_attempt: number
    }>();
    if (existing) {
      if (existing.workflow_id !== workflowId || existing.definition_digest !== definitionDigest ||
          existing.source_sha !== sourceSha || existing.repository_id !== identity.repositoryId ||
          existing.publisher_run_id !== identity.runId || existing.publisher_run_attempt !== identity.runAttempt) {
        return reject(409, 'publication_conflict');
      }
      return Response.json({ workflowId, definitionDigest, publicationId, staged: true }, {
        headers: { 'Cache-Control': 'no-store' }
      });
    }
    const existingPlan = await env.DB.prepare(
      'SELECT workflow_id, normalized_plan_json FROM workflow_definition_versions WHERE definition_digest = ?'
    ).bind(definitionDigest).first<{ workflow_id: string; normalized_plan_json: string }>();
    if (existingPlan && (existingPlan.workflow_id !== workflowId ||
        JSON.stringify(canonical(JSON.parse(existingPlan.normalized_plan_json))) !== serialized)) {
      return reject(409, 'immutable_definition_conflict');
    }
    const now = new Date().toISOString();
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO workflow_definition_versions
         (definition_digest, workflow_id, dsl_version, normalized_plan_json, source_path, source_commit, created_at)
         SELECT ?, ?, 1, ?, ?, ?, ?
         WHERE (SELECT revision FROM connection_policy_revision WHERE singleton = 1) = ?`
      ).bind(definitionDigest, workflowId, serialized, sourcePath, sourceSha, now, policyRevision),
      env.DB.prepare(
        `INSERT OR IGNORE INTO definition_publications
         (publication_id, workflow_id, definition_digest, source_sha, repository_id,
          publisher_run_id, publisher_run_attempt, publisher_workflow_sha, policy_revision, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT revision FROM connection_policy_revision WHERE singleton = 1) = ?`
      ).bind(publicationId, workflowId, definitionDigest, sourceSha, identity.repositoryId,
        identity.runId, identity.runAttempt, identity.workflowSha, policyRevision, now, policyRevision)
    ]);
    if (results[1]?.meta.changes !== 1) return reject(409, 'publication_conflict');
    return Response.json({ workflowId, definitionDigest, publicationId, staged: true }, {
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch {
    return reject(503, 'stage_storage_unavailable');
  }
}
