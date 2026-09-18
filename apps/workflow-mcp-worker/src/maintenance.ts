import { attemptEventType, callbackStaleReason } from './executor-protocol.js';
import { D1WorkflowStore } from './storage.js';
import type { Env } from './types.js';

const MAX_CALLBACK_NOTIFICATION_ATTEMPTS = 5;
const BASE_RETRY_MS = 30_000;
const MAX_RETRY_MS = 15 * 60_000;

export async function runMaintenanceBatch(env: Env, limit: number): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Maintenance batch limit must be between 1 and 100.');
  }

  const store = new D1WorkflowStore(env.DB);
  const callbacks = await store.listDueCallbackNotifications(
    new Date().toISOString(),
    limit,
    MAX_CALLBACK_NOTIFICATION_ATTEMPTS
  );
  let processed = 0;

  for (const callback of callbacks) {
    processed += 1;
    const attempt = await store.getRemoteAttempt(callback.attemptId);
    if (!attempt) {
      await store.markCallbackIgnored(callback.callbackId, 'attempt_missing');
      continue;
    }

    const staleReason = callbackStaleReason(attempt);
    if (staleReason) {
      await store.markCallbackIgnored(callback.callbackId, staleReason);
      continue;
    }

    try {
      const instance = await env.WORKFLOW.get(attempt.runId);
      await instance.sendEvent({
        type: attemptEventType(attempt.attemptId),
        payload: {
          kind: callback.callbackKind,
          callbackId: callback.callbackId
        }
      });
      await store.markCallbackNotified(callback.callbackId);
    } catch {
      const previousAttempts = callback.notificationAttemptCount ?? 0;
      const delay = Math.min(BASE_RETRY_MS * 2 ** previousAttempts, MAX_RETRY_MS);
      await store.recordCallbackNotificationFailure(
        callback.callbackId,
        new Date(Date.now() + delay).toISOString()
      );
    }
  }

  return processed;
}
