import {
  acceptExecutorCallback,
  claimRemoteAttempt,
  ExecutorProtocolError,
  getExecutionManifest
} from './executor-protocol.js';
import type { Env } from './types.js';

export async function handleExecutorRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  try {
    if (request.method === 'POST' && url.pathname === '/executor/claim') {
      const oidcToken = bearer(request);
      const body = await jsonObject(request);
      const attemptId = stringField(body, 'attemptId');
      const claimNonce = stringField(body, 'claimNonce');
      const result = await claimRemoteAttempt(env, { attemptId, claimNonce, oidcToken });
      return json(result, 200);
    }

    if (request.method === 'GET' && url.pathname === '/executor/manifest') {
      const lease = bearer(request);
      const manifest = await getExecutionManifest(env, lease);
      return json({ manifest }, 200);
    }

    if (request.method === 'POST' && url.pathname === '/executor/callback') {
      const lease = bearer(request);
      const body = await jsonObject(request);
      const callbackId = stringField(body, 'callbackId');
      const kind = body.kind;
      const result = body.result;
      if (kind !== 'result' || !result || typeof result !== 'object' || Array.isArray(result)) {
        throw new ExecutorProtocolError(400, 'INVALID_CALLBACK', 'Callback kind/result is invalid.');
      }
      const accepted = await acceptExecutorCallback(env, lease, {
        callbackId,
        kind,
        result: result as Record<string, unknown>
      });
      return json(accepted, 202);
    }

    return null;
  } catch (error) {
    if (error instanceof ExecutorProtocolError) {
      return json({ error: { code: error.code, message: error.message } }, error.status);
    }
    return json(
      {
        error: {
          code: 'EXECUTOR_PROTOCOL_ERROR',
          message: error instanceof Error ? error.message.slice(0, 500) : 'Executor protocol failed.'
        }
      },
      400
    );
  }
}

function bearer(request: Request): string {
  const value = request.headers.get('authorization') ?? '';
  if (!value.startsWith('Bearer ') || value.length <= 7) {
    throw new ExecutorProtocolError(401, 'MISSING_BEARER_TOKEN', 'Bearer credential is required.');
  }
  return value.slice(7);
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExecutorProtocolError(400, 'INVALID_REQUEST', 'Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0 || field.length > 500) {
    throw new ExecutorProtocolError(400, 'INVALID_REQUEST', `Field "${key}" must be a non-empty string.`);
  }
  return field;
}

function json(value: unknown, status: number): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  });
}
