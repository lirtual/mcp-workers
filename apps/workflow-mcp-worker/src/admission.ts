import { findWorkflow } from './registry.js';
import type { RuntimeInputDefinition, RuntimePlan } from './runtime-plan.js';
import { asRuntimePlan } from './runtime-plan.js';
import { D1WorkflowStore, type AdmissionResult } from './storage.js';
import type { Env } from './types.js';

export interface ManualAdmissionResult extends AdmissionResult {
  definitionDigest: string;
  state: 'queued';
}

export async function admitManualWorkflow(
  env: Env,
  workflowId: string,
  rawInput: unknown,
  idempotencyKey?: string
): Promise<ManualAdmissionResult> {
  const entry = findWorkflow(workflowId);
  if (!entry) throw new PublicWorkflowError('WORKFLOW_NOT_FOUND', 'Workflow definition was not found.');

  const plan = asRuntimePlan(entry.plan);
  assertRunnablePlan(plan);
  const input = validateWorkflowInput(plan.inputs, rawInput);

  if (idempotencyKey !== undefined && (idempotencyKey.length < 1 || idempotencyKey.length > 128)) {
    throw new PublicWorkflowError(
      'INVALID_IDEMPOTENCY_KEY',
      'Manual idempotency key must contain 1 to 128 characters.'
    );
  }

  const randomPart = crypto.randomUUID();
  const sourceKey = idempotencyKey ?? randomPart;
  const admissionKey =
    idempotencyKey === undefined
      ? `manual:${workflowId}:run:${randomPart}`
      : `manual:${workflowId}:idempotency:${idempotencyKey}`;
  const proposedRunId =
    idempotencyKey === undefined
      ? `run_${randomPart}`
      : `run_${(await sha256Hex(admissionKey)).slice(0, 40)}`;

  const store = new D1WorkflowStore(env.DB);
  await store.ensureDefinition({
    definitionDigest: entry.definitionDigest,
    workflowId,
    dslVersion: plan.dslVersion,
    plan,
    sourcePath: entry.sourcePath
  });

  const admission = await store.admitRun({
    admissionKey,
    proposedRunId,
    workflowId,
    definitionDigest: entry.definitionDigest,
    input,
    trigger: { type: 'manual' },
    sourceType: 'manual',
    sourceKey
  });

  // createBatch is deliberately used for one instance: Cloudflare documents it
  // as idempotent when a custom ID already exists. Repeating an admission call
  // can therefore repair a previous create response failure without creating a
  // second logical instance.
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

function assertRunnablePlan(plan: RuntimePlan): void {
  const unsupported = Object.values(plan.steps).find(
    step => step.executor !== 'cloudflare' || step.uses !== 'http.read'
  );
  if (unsupported) {
    throw new PublicWorkflowError(
      'WORKFLOW_NOT_IMPLEMENTED',
      'This workflow depends on capabilities scheduled for a later v0.1 implementation ticket.'
    );
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
