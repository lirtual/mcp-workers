import { describe, expect, it, vi } from 'vitest';
import { runMaintenanceBatch, type MaintenanceStore } from '../src/maintenance.js';
import type { CallbackInboxRecord, RemoteAttemptRecord } from '../src/storage.js';
import type { Env } from '../src/types.js';

function attempt(overrides: Partial<RemoteAttemptRecord> = {}): RemoteAttemptRecord {
  return {
    attemptId: 'att_1',
    stepRunId: 'step_1',
    runId: 'run_1',
    stepId: 'archive',
    operationId: 'op_1',
    state: 'claimed',
    runState: 'waiting',
    claimOwner: 'github:9001:1',
    githubRunId: '9001',
    githubRunAttempt: 1,
    expectedRepositoryId: '123',
    expectedWorkflowRef: 'wf',
    expectedRef: 'refs/heads/main',
    executionManifest: {},
    ...overrides
  };
}

function callback(overrides: Partial<CallbackInboxRecord> = {}): CallbackInboxRecord {
  return {
    callbackId: 'cb_1',
    attemptId: 'att_1',
    githubRunId: '9001',
    githubRunAttempt: 1,
    callbackKind: 'result',
    result: { state: 'succeeded' },
    receivedAt: new Date(1000).toISOString(),
    notificationAttemptCount: 0,
    ...overrides
  };
}

class MemoryMaintenanceStore implements MaintenanceStore {
  callbacks: CallbackInboxRecord[] = [callback()];
  remoteAttempt: RemoteAttemptRecord | null = attempt();
  notified: string[] = [];
  ignored: Array<{ id: string; reason: string }> = [];
  failures: Array<{ id: string; next: string }> = [];

  async listDueCallbackNotifications(): Promise<CallbackInboxRecord[]> {
    return this.callbacks;
  }

  async getRemoteAttempt(): Promise<RemoteAttemptRecord | null> {
    return this.remoteAttempt;
  }

  async markCallbackIgnored(id: string, reason: string): Promise<void> {
    this.ignored.push({ id, reason });
  }

  async markCallbackNotified(id: string): Promise<void> {
    this.notified.push(id);
  }

  async recordCallbackNotificationFailure(id: string, next: string): Promise<void> {
    this.failures.push({ id, next });
  }
}

function env(sendEvent: (event: { type: string; payload: unknown }) => Promise<void>): Env {
  return {
    WORKFLOW: {
      get: vi.fn(async () => ({ sendEvent }))
    }
  } as unknown as Env;
}

describe('callback maintenance', () => {
  it('re-notifies a persisted current callback through the Attempt event channel', async () => {
    const store = new MemoryMaintenanceStore();
    const sendEvent = vi.fn(async () => undefined);

    await expect(
      runMaintenanceBatch(env(sendEvent), 20, { store, nowMs: 10_000 })
    ).resolves.toBe(1);

    expect(sendEvent).toHaveBeenCalledWith({
      type: 'attempt_att_1',
      payload: { kind: 'result', callbackId: 'cb_1' }
    });
    expect(store.notified).toEqual(['cb_1']);
    expect(store.failures).toEqual([]);
  });

  it('backs off notification failure without losing the inbox row', async () => {
    const store = new MemoryMaintenanceStore();
    const sendEvent = vi.fn(async () => {
      throw new Error('temporary outage');
    });

    await runMaintenanceBatch(env(sendEvent), 20, { store, nowMs: 10_000 });

    expect(store.notified).toEqual([]);
    expect(store.failures).toEqual([
      { id: 'cb_1', next: new Date(40_000).toISOString() }
    ]);
  });

  it('marks terminal Attempt callbacks stale instead of waking orchestration', async () => {
    const store = new MemoryMaintenanceStore();
    store.remoteAttempt = attempt({ state: 'failed' });
    const sendEvent = vi.fn(async () => undefined);

    await runMaintenanceBatch(env(sendEvent), 20, { store, nowMs: 10_000 });

    expect(sendEvent).not.toHaveBeenCalled();
    expect(store.ignored).toEqual([{ id: 'cb_1', reason: 'attempt_failed' }]);
  });

  it('respects the explicit batch bound', async () => {
    const store = new MemoryMaintenanceStore();
    store.callbacks = [callback({ callbackId: 'a' }), callback({ callbackId: 'b' })];

    await expect(
      runMaintenanceBatch(env(vi.fn(async () => undefined)), 0, { store })
    ).rejects.toThrow(/between 1 and 100/);
  });
});
