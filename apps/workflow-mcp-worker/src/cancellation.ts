import { attemptEventType } from './executor-protocol.js';
import {
  D1WorkflowStore,
  type RemoteAttemptRecord,
  type StoredRun
} from './storage.js';
import type { Env } from './types.js';

export interface CancellationStore {
  requestRunCancellation(runId: string): Promise<StoredRun | null>;
  listActiveRemoteAttemptsForRun(runId: string): Promise<RemoteAttemptRecord[]>;
  markRemoteAttemptCancelRequested(attemptId: string): Promise<boolean>;
}

export interface WorkflowCancellationResult {
  runId: string;
  state: StoredRun['state'];
  cancelRequestedAt?: string;
  alreadyTerminal: boolean;
  activeRemoteAttempts: number;
  wakeSent: number;
  wakeFailed: number;
}

const terminalStates = new Set<StoredRun['state']>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'indeterminate'
]);

export async function requestWorkflowCancellation(
  env: Env,
  runId: string,
  options: { store?: CancellationStore } = {}
): Promise<WorkflowCancellationResult | null> {
  const store = options.store ?? new D1WorkflowStore(env.DB);
  const run = await store.requestRunCancellation(runId);
  if (!run) return null;

  if (terminalStates.has(run.state)) {
    return {
      runId,
      state: run.state,
      ...(run.cancelRequestedAt ? { cancelRequestedAt: run.cancelRequestedAt } : {}),
      alreadyTerminal: true,
      activeRemoteAttempts: 0,
      wakeSent: 0,
      wakeFailed: 0
    };
  }

  const attempts = await store.listActiveRemoteAttemptsForRun(runId);
  let wakeSent = 0;
  let wakeFailed = 0;

  for (const attempt of attempts) {
    await store.markRemoteAttemptCancelRequested(attempt.attemptId);
    try {
      const instance = await env.WORKFLOW.get(runId);
      await instance.sendEvent({
        type: attemptEventType(attempt.attemptId),
        payload: { kind: 'cancel_requested' }
      });
      wakeSent += 1;
    } catch {
      wakeFailed += 1;
    }
  }

  return {
    runId,
    state: run.state,
    ...(run.cancelRequestedAt ? { cancelRequestedAt: run.cancelRequestedAt } : {}),
    alreadyTerminal: false,
    activeRemoteAttempts: attempts.length,
    wakeSent,
    wakeFailed
  };
}
