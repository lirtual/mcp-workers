import { attemptEventType, callbackStaleReason } from './executor-protocol.js';
import {
  D1WorkflowStore,
  type CallbackInboxRecord,
  type RemoteAttemptRecord
} from './storage.js';
import type { Env } from './types.js';

const MAX_CALLBACK_NOTIFICATION_ATTEMPTS = 5;
const BASE_RETRY_MS = 30_000;
const MAX_RETRY_MS = 15 * 60_000;

export interface MaintenanceStore {
  listDueCallbackNotifications(
    now: string,
    limit: number,
    maxAttempts: number
  ): Promise<CallbackInboxRecord[]>;
  getRemoteAttempt(attemptId: string): Promise<RemoteAttemptRecord | null>;
  markCallbackIgnored(callbackId: string, reason: string): Promise<void>;
  markCallbackNotified(callbackId: string): Promise<void>;
  recordCallbackNotificationFailure(callbackId: string, nextNotificationAt: string): Promise<void>;
  listCancellationWakeAttempts(limit: number): Promise<RemoteAttemptRecord[]>;
}

export async function runMaintenanceBatch(
  env: Env,
  limit: number,
  options: {
    store?: MaintenanceStore;
    nowMs?: number;
  } = {}
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Maintenance batch limit must be between 1 and 100.');
  }

  const nowMs = options.nowMs ?? Date.now();
  const store = options.store ?? new D1WorkflowStore(env.DB);
  const callbacks = await store.listDueCallbackNotifications(
    new Date(nowMs).toISOString(),
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
        new Date(nowMs + delay).toISOString()
      );
    }
  }

  const remaining = Math.max(0, limit - processed);
  if (remaining > 0) {
    const cancellationAttempts = await store.listCancellationWakeAttempts(remaining);
    for (const attempt of cancellationAttempts) {
      processed += 1;
      try {
        const instance = await env.WORKFLOW.get(attempt.runId);
        await instance.sendEvent({
          type: attemptEventType(attempt.attemptId),
          payload: { kind: 'cancel_requested' }
        });
      } catch {
        // Durable run/attempt cancellation state remains the retry source.
      }
    }
  }

  return processed;
}
