import { captureConnectionPins } from './connection-revocation.js';
import { currentEngineVersion } from './provenance.js';
import { findWorkflow } from './registry.js';
import { validateVersionedWorkflowPlan } from './runtime-plan-validation.js';
import type { RuntimeInputDefinition, RuntimePlan } from './runtime-plan.js';
import { asRuntimePlan } from './runtime-plan.js';
import { D1WorkflowStore, type AdmissionResult, type StoredRun } from './storage.js';
import type { Env, WorkflowRegistryEntry } from './types.js';

export interface WorkflowAdmissionResult extends AdmissionResult {
  definitionDigest: string;
  state: StoredRun['state'];
}

interface AdmissionSource {
  admissionKey: string;
  sourceType: 'manual' | 'webhook' | 'schedule';
  sourceKey: string;
  trigger: Record<string, unknown>;
  deterministicRunId: boolean;
}

export async function admitManualWorkflow(
  env: Env,
  workflowId: string,
  rawInput: unknown,
  idempotencyKey?: string
): Promise<WorkflowAdmissionResult> {
  if (idempotencyKey !== undefined && (idempotencyKey.length < 1 || idempotencyKey.length > 128)) {
    throw new PublicWorkflowError(
      'INVALID_IDEMPOTENCY_KEY',
      'Manual idempotency key must contain 1 to 128 characters.'
    );
  }

  const randomPart = crypto.randomUUID();
  const sourceKey = idempotencyKey ?? randomPart;
  const source: AdmissionSource = {
    admissionKey:
      idempotencyKey === undefined
        ? `manual:${workflowId}:run:${randomPart}`
        : `manual:${workflowId}:idempotency:${idempotencyKey}`,
    sourceType: 'manual',
    sourceKey,
    trigger: { type: 'manual' },
    deterministicRunId: idempotencyKey !== undefined
  };
  if (env.DYNAMIC_WORKFLOW_ADMISSION_ENABLED === 'true') {
    return admitDynamicManualWorkflow(env, workflowId, rawInput, source);
  }
  return admitCompiledWorkflow(env, workflowId, rawInput, source);
}

export async function admitWebhookWorkflow(
  env: Env,
  workflowId: string,
  triggerId: string,
  rawInput: unknown,
  eventKey: string
): Promise<WorkflowAdmissionResult> {
  if (eventKey.length < 1 || eventKey.length > 256) {
    throw new PublicWorkflowError(
      'INVALID_EVENT_KEY',
      'Webhook event key must contain 1 to 256 characters.'
    );
  }

  return admitCompiledWorkflow(env, workflowId, rawInput, {
    admissionKey: `webhook:${workflowId}:${triggerId}:${eventKey}`,
    sourceType: 'webhook',
    sourceKey: eventKey,
    trigger: { type: 'webhook', triggerId, eventKey },
    deterministicRunId: true
  });
}

export async function admitScheduledWorkflow(
  env: Env,
  workflowId: string,
  triggerId: string,
  scheduledTime: number
): Promise<WorkflowAdmissionResult> {
  const sourceKey = String(scheduledTime);
  return admitCompiledWorkflow(env, workflowId, {}, {
    admissionKey: `schedule:${workflowId}:${triggerId}:${sourceKey}`,
    sourceType: 'schedule',
    sourceKey,
    trigger: { type: 'schedule', triggerId, scheduledTime },
    deterministicRunId: true
  });
}

/**
 * T06: manual-only, gated D1 admission. Duplicates resolve from the existing
 * admission key before consulting any newer/disabled active definition.
 */
async function admitDynamicManualWorkflow(
  env: Env,
  workflowId: string,
  rawInput: unknown,
  source: AdmissionSource
): Promise<WorkflowAdmissionResult> {
  if (env.DYNAMIC_WORKFLOW_REGISTRY_ENABLED !== 'true' || !env.DB) {
    throw new PublicWorkflowError('RUNTIME_NOT_CONFIGURED', 'Dynamic admission requires the D1 registry.');
  }
  const store = new D1WorkflowStore(env.DB);
  const original = await store.getAdmissionRun(source.admissionKey);
  if (original) {
    // Never recreate a terminal historical Run. Only an unfinished Run may
    // need repair after an uncertain initial createBatch response.
    await recoverDynamicInstance(env, original);
    return {
      runId: original.runId, alreadyAdmitted: true,
      definitionDigest: original.definitionDigest, state: original.state
    };
  }

  const active = await env.DB.prepare(
    `SELECT a.active_digest, a.registry_revision, d.normalized_plan_json
     FROM workflow_active_definitions a
     JOIN workflow_definition_versions d ON d.definition_digest = a.active_digest
     WHERE a.workflow_id = ? AND a.state = 'enabled' AND d.workflow_id = a.workflow_id`
  ).bind(workflowId).first<{
    active_digest: string; registry_revision: number; normalized_plan_json: string
  }>();
  if (!active) {
    // Another request can win this Admission Key between our initial lookup
    // and the active-pointer read. Resolve that durable winner even if the
    // definition was deactivated in the meantime.
    const winner = await store.getAdmissionRun(source.admissionKey);
    if (winner) {
      await recoverDynamicInstance(env, winner);
      return {
        runId: winner.runId, alreadyAdmitted: true,
        definitionDigest: winner.definitionDigest, state: winner.state
      };
    }
    throw new PublicWorkflowError('WORKFLOW_NOT_FOUND', 'Workflow definition was not found.');
  }
  if (!Number.isSafeInteger(active.registry_revision) || active.registry_revision < 1 ||
      !/^[0-9a-f]{64}$/.test(active.active_digest)) {
    throw new PublicWorkflowError('REGISTRY_UNAVAILABLE', 'Active workflow registry is invalid.');
  }
  let plan: RuntimePlan;
  try {
    plan = asRuntimePlan(validateVersionedWorkflowPlan(JSON.parse(active.normalized_plan_json)));
    if (plan.id !== workflowId) throw new Error('Workflow mismatch');
  } catch {
    throw new PublicWorkflowError('REGISTRY_UNAVAILABLE', 'Active workflow registry is invalid.');
  }
  const input = validateWorkflowInput(plan.inputs, rawInput);
  const policy = await env.DB.prepare(
    'SELECT revision FROM connection_policy_revision WHERE singleton = 1'
  ).first<{ revision: number }>();
  if (!policy || !Number.isSafeInteger(policy.revision) || policy.revision < 1) {
    throw new PublicWorkflowError('POLICY_UNAVAILABLE', 'Approved Connection policy is unavailable.');
  }
  const connectionIds = Object.values(plan.steps)
    .filter(step => step.uses === 'mcp.call')
    .map(step => step.with.connection)
    .filter((value): value is string => typeof value === 'string');
  const connectionVersions = await captureConnectionPins(env.DB, connectionIds);
  const proposedRunId = source.deterministicRunId
    ? `run_${(await sha256Hex(source.admissionKey)).slice(0, 40)}`
    : `run_${crypto.randomUUID()}`;
  const admitted = await store.admitVersionPinnedRun({
    connectionVersions, admissionKey: source.admissionKey, proposedRunId,
    workflowId, definitionDigest: active.active_digest, input,
    trigger: source.trigger, sourceType: source.sourceType, sourceKey: source.sourceKey,
    engineVersion: currentEngineVersion(env), expectedRegistryRevision: active.registry_revision,
    expectedPolicyRevision: policy.revision
  });
  if (!admitted) {
    // The active revision may have changed while a same-key rival admitted.
    // Return the existing immutable Run rather than a spurious conflict.
    const winner = await store.getAdmissionRun(source.admissionKey);
    if (winner) {
      await recoverDynamicInstance(env, winner);
      return {
        runId: winner.runId, alreadyAdmitted: true,
        definitionDigest: winner.definitionDigest, state: winner.state
      };
    }
    throw new PublicWorkflowError('REGISTRY_CONFLICT', 'Active workflow changed during admission; retry.');
  }
  const recorded = await store.getRun(admitted.runId);
  if (!recorded) {
    throw new PublicWorkflowError('ADMISSION_UNAVAILABLE', 'Durable admission record is unavailable.');
  }
  // A concurrent request may have won the key. Never restart a terminal Run.
  if (admitted.alreadyAdmitted) {
    await recoverDynamicInstance(env, recorded);
  } else {
    await env.WORKFLOW.createBatch([{ id: admitted.runId, params: { runId: admitted.runId } }]);
  }
  return {
    ...admitted, definitionDigest: recorded.definitionDigest, state: recorded.state
  };
}

/**
 * Only repair a queued, already-admitted Run. Inspect the external instance
 * first; an uncertain lookup is not evidence of absence. A specifically
 * reported not-found instance is recreated with the original ID, never a
 * different ID or a new definition. Do not restart running/terminal history.
 */
async function recoverDynamicInstance(env: Env, run: StoredRun): Promise<void> {
  if (run.state !== 'queued') return;
  // Existing instances are safe to read at any age. The recovery window
  // restricts recreation only, not access to an original admitted Run.
  try {
    const instance = await env.WORKFLOW.get(run.runId);
    // A handle alone is insufficient evidence of a persisted instance on
    // every binding implementation. Confirm status before claiming recovery.
    await instance.status();
    return;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code) : '';
    if (code !== 'instance.not_found') {
      // Lookup failures are not evidence that an instance is absent. Return
      // the durable original Run instead of creating a second instance.
      console.warn('workflow.recovery.uncertain', { runId: run.runId });
      return;
    }
  }
  // Only a positively identified missing instance can be reconsidered. An
  // unknown Cloudflare error is handled above as uncertain (fail closed).
  const admittedAt = Date.parse(run.createdAt);
  const ageMs = Date.now() - admittedAt;
  if (!Number.isFinite(admittedAt) || ageMs < 0 || ageMs > 60 * 60 * 1000) {
    // An expired repair window must not invalidate a durable Admission Key.
    console.warn('workflow.recovery.expired', { runId: run.runId });
    return;
  }
  // Cloudflare createBatch skips an existing custom ID within retention.
  await env.WORKFLOW.createBatch([{ id: run.runId, params: { runId: run.runId } }]);
}

async function admitCompiledWorkflow(
  env: Env,
  workflowId: string,
  rawInput: unknown,
  source: AdmissionSource
): Promise<WorkflowAdmissionResult> {
  const entry = findWorkflow(workflowId);
  if (!entry) throw new PublicWorkflowError('WORKFLOW_NOT_FOUND', 'Workflow definition was not found.');

  const plan = asRuntimePlan(entry.plan);
  const input = validateWorkflowInput(plan.inputs, rawInput);
  const runId = source.deterministicRunId
    ? `run_${(await sha256Hex(source.admissionKey)).slice(0, 40)}`
    : `run_${crypto.randomUUID()}`;

  return persistAndStart(env, entry, plan, input, source, runId);
}

async function persistAndStart(
  env: Env,
  entry: WorkflowRegistryEntry,
  plan: RuntimePlan,
  input: Record<string, unknown>,
  source: AdmissionSource,
  proposedRunId: string
): Promise<WorkflowAdmissionResult> {
  const store = new D1WorkflowStore(env.DB);
  await store.ensureDefinition({
    definitionDigest: entry.definitionDigest,
    workflowId: plan.id,
    dslVersion: plan.dslVersion,
    plan,
    sourcePath: entry.sourcePath
  });

  // Capture the approved revision before admission. The INSERT OR IGNORE path
  // never rewrites an existing Run's immutable Connection pins on replay.
  const connectionIds = Object.values(plan.steps)
    .filter(step => step.uses === 'mcp.call')
    .map(step => step.with.connection)
    .filter((value): value is string => typeof value === 'string');
  const connectionVersions = await captureConnectionPins(env.DB, connectionIds);

  const admission = await store.admitRun({
    connectionVersions,
    admissionKey: source.admissionKey,
    proposedRunId,
    workflowId: plan.id,
    definitionDigest: entry.definitionDigest,
    input,
    trigger: source.trigger,
    sourceType: source.sourceType,
    sourceKey: source.sourceKey,
    engineVersion: currentEngineVersion(env)
  });

  // createBatch is deliberately used for one instance: Cloudflare documents it
  // as idempotent when a custom ID already exists. Replaying an admission call
  // can therefore repair a previous create response failure safely.
  await env.WORKFLOW.createBatch([{ id: admission.runId, params: { runId: admission.runId } }]);

  return {
    ...admission,
    definitionDigest: entry.definitionDigest,
    state: 'queued'
  };
}

export class PublicWorkflowError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function validateWorkflowInput(
  definitions: Readonly<Record<string, RuntimeInputDefinition>>,
  rawInput: unknown
): Record<string, unknown> {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    throw new PublicWorkflowError('INVALID_INPUT', 'Workflow input must be an object.');
  }

  const input = rawInput as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(key in definitions)) {
      throw new PublicWorkflowError('INVALID_INPUT', `Unknown workflow input "${key}".`);
    }
  }

  for (const [name, definition] of Object.entries(definitions)) {
    const value = input[name];
    if (value === undefined) {
      if (definition.required) {
        throw new PublicWorkflowError('INVALID_INPUT', `Required workflow input "${name}" is missing.`);
      }
      continue;
    }
    if (typeof value !== definition.type) {
      throw new PublicWorkflowError(
        'INVALID_INPUT',
        `Workflow input "${name}" must be a ${definition.type}.`
      );
    }
    if (definition.enum && (typeof value !== 'string' || !definition.enum.includes(value))) {
      throw new PublicWorkflowError('INVALID_INPUT', `Workflow input "${name}" is not an allowed value.`);
    }
  }

  return { ...input };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
