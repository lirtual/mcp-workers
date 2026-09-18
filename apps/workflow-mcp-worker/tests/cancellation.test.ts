import { describe, expect, it, vi } from 'vitest';
import { requestWorkflowCancellation, type CancellationStore } from '../src/cancellation.js';
import type { RemoteAttemptRecord, StoredRun } from '../src/storage.js';
import type { Env } from '../src/types.js';

function run(state: StoredRun['state'] = 'cancel_requested'): StoredRun {
  return {
    runId: 'run_1',
    workflowId: 'web-archive-smoke',
    definitionDigest: 'd'.repeat(64),
    input: {},
    trigger: { type: 'manual' },
    state,
    createdAt: '2026-09-18T00:00:00.000Z',
    ...(state === 'cancel_requested'
      ? { cancelRequestedAt: '2026-09-18T00:01:00.000Z' }
      : {})
  };
}

function attempt(): RemoteAttemptRecord {
  return {
    attemptId: 'att_1',
    stepRunId: 'step_1',
    runId: 'run_1',
    stepId: 'archive',
    operationId: 'op_1',
    state: 'claimed',
    runState: 'cancel_requested',
    claimOwner: 'github:9001:1',
    githubRunId: '9001',
    githubRunAttempt: 1,
    expectedRepositoryId: '123',
    expectedWorkflowRef: 'wf',
    expectedRef: 'refs/heads/main',
    executionManifest: {}
  };
}

class MemoryCancellationStore implements CancellationStore {
  current: StoredRun | null = run();
  attempts: RemoteAttemptRecord[] = [attempt()];
  requests = 0;
  marked: string[] = [];

  async requestRunCancellation(): Promise<StoredRun | null> {
    this.requests += 1;
    return this.current;
  }

  async listActiveRemoteAttemptsForRun(): Promise<RemoteAttemptRecord[]> {
    return this.attempts;
  }

  async markRemoteAttemptCancelRequested(attemptId: string): Promise<boolean> {
    this.marked.push(attemptId);
    return true;
  }
}

function env(sendEvent: (event: { type: string; payload: unknown }) => Promise<void>): Env {
  return {
    WORKFLOW: {
      get: vi.fn(async () => ({ sendEvent }))
    }
  } as unknown as Env;
}

describe('workflow cancellation service', () => {
  it('persists cancellation before waking the active Attempt', async () => {
    const store = new MemoryCancellationStore();
    const sendEvent = vi.fn(async () => undefined);

    const result = await requestWorkflowCancellation(env(sendEvent), 'run_1', { store });

    expect(store.requests).toBe(1);
    expect(store.marked).toEqual(['att_1']);
    expect(sendEvent).toHaveBeenCalledWith({
      type: 'attempt_att_1',
      payload: { kind: 'cancel_requested' }
    });
    expect(result).toMatchObject({
      runId: 'run_1',
      state: 'cancel_requested',
      activeRemoteAttempts: 1,
      wakeSent: 1,
      wakeFailed: 0
    });
  });

  it('keeps cancellation durable when wake-up notification fails', async () => {
    const store = new MemoryCancellationStore();
    const result = await requestWorkflowCancellation(
      env(vi.fn(async () => Promise.reject(new Error('event outage')))),
      'run_1',
      { store }
    );

    expect(store.requests).toBe(1);
    expect(result).toMatchObject({
      state: 'cancel_requested',
      wakeSent: 0,
      wakeFailed: 1
    });
  });

  it('is idempotent for a terminal Run and performs no new wake-up', async () => {
    const store = new MemoryCancellationStore();
    store.current = run('cancelled');
    const sendEvent = vi.fn(async () => undefined);

    const result = await requestWorkflowCancellation(env(sendEvent), 'run_1', { store });

    expect(result).toMatchObject({
      state: 'cancelled',
      alreadyTerminal: true,
      activeRemoteAttempts: 0
    });
    expect(sendEvent).not.toHaveBeenCalled();
    expect(store.marked).toEqual([]);
  });

  it('returns null for an unknown Run', async () => {
    const store = new MemoryCancellationStore();
    store.current = null;
    await expect(
      requestWorkflowCancellation(env(vi.fn(async () => undefined)), 'missing', { store })
    ).resolves.toBeNull();
  });
});
