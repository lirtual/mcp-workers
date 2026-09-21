import { admitWebhookWorkflow, PublicWorkflowError } from './admission.js';
import { findWorkflow } from './registry.js';
import { asRuntimePlan } from './runtime-plan.js';
import type { Env } from './types.js';

interface WebhookTrigger {
  type: 'webhook';
  id: string;
  secret: string;
}

export async function handleWebhookTrigger(
  request: Request,
  env: Env,
  workflowId: string,
  triggerId: string,
  lookup: typeof findWorkflow = findWorkflow
): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const entry = lookup(workflowId);
  if (!entry) return triggerError(404, 'WORKFLOW_NOT_FOUND', 'Workflow definition was not found.');

  const plan = asRuntimePlan(entry.plan);
  const trigger = plan.triggers.find(candidate => isWebhookTrigger(candidate) && candidate.id === triggerId);
  if (!trigger || !isWebhookTrigger(trigger)) {
    return triggerError(404, 'TRIGGER_NOT_FOUND', 'Webhook trigger was not found.');
  }

  const expectedToken = readNamedSecret(env, trigger.secret);
  if (!expectedToken) {
    return triggerError(503, 'TRIGGER_AUTH_NOT_CONFIGURED', 'Webhook trigger authentication is not configured.');
  }

  const bearer = readBearer(request.headers.get('authorization'));
  if (!bearer || !timingSafeEqual(bearer, expectedToken)) {
    return new Response(
      JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Valid webhook authentication is required.' } }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'WWW-Authenticate': 'Bearer'
        }
      }
    );
  }

  const eventKey = request.headers.get('x-workflow-event-key')?.trim() ?? '';
  if (!eventKey) {
    return triggerError(400, 'EVENT_KEY_REQUIRED', 'X-Workflow-Event-Key is required.');
  }

  let input: unknown = {};
  try {
    input = await readWebhookInput(request);
  } catch (error) {
    return triggerError(
      400,
      'INVALID_WEBHOOK_BODY',
      error instanceof Error ? error.message : 'Webhook body is invalid.'
    );
  }

  try {
    const result = await admitWebhookWorkflow(env, workflowId, triggerId, input, eventKey);
    return Response.json(
      {
        runId: result.runId,
        state: result.state,
        definitionDigest: result.definitionDigest,
        alreadyAdmitted: result.alreadyAdmitted
      },
      { status: 202, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    if (error instanceof PublicWorkflowError) return triggerError(400, error.code, error.message);
    return triggerError(500, 'TRIGGER_ADMISSION_FAILED', 'Webhook admission failed.');
  }
}

function isWebhookTrigger(value: Readonly<Record<string, unknown>>): value is Readonly<WebhookTrigger> {
  return value.type === 'webhook' && typeof value.id === 'string' && typeof value.secret === 'string';
}

function readNamedSecret(env: Env, name: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readBearer(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

async function readWebhookInput(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (contentLength > 64 * 1024) throw new Error('Webhook body exceeds 64 KiB.');

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) {
    throw new Error('Webhook body exceeds 64 KiB.');
  }
  if (text.trim() === '') return {};

  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Webhook body must be a JSON object.');
  }
  const object = parsed as Record<string, unknown>;
  const unexpected = Object.keys(object).filter(key => key !== 'input');
  if (unexpected.length > 0) throw new Error('Webhook body supports only the "input" field.');
  return object.input ?? {};
}

function triggerError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}
