import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  acceptExecutorCallback,
  attemptEventType,
  claimRemoteAttempt,
  getExecutionManifest,
  prepareRemoteAttempt,
  type ExecutorProtocolStore,
  type ExecutionManifest
} from '../src/executor-protocol.js';
import type {
  CallbackInboxInput,
  CallbackInboxInsertResult,
  ExecutorDispatchFact,
  RemoteAttemptRecord,
  RemoteAttemptRegistration,
  RemoteClaimInput
} from '../src/storage.js';
import type { Env } from '../src/types.js';

const issuer = 'https://token.actions.example.test';
const audience = 'workflow-mcp-worker';
const jwksUrl = 'https://token.actions.example.test/jwks';
const workflowRef =
  'lirtual/mcp-workers/.github/workflows/workflow-executor.yml@refs/heads/main';
const ref = 'refs/heads/main';
const workflowSha = 'trusted-workflow-sha';
let privateKey: CryptoKey;
let publicJwk: JsonWebKey & { kid?: string; alg?: string; use?: string };

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey & { kid?: string; alg?: string; use?: string };
  publicJwk.kid = 'test-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
});

describe('remote executor protocol', () => {
  it('allows at most one valid Candidate Job to claim and immutably binds its physical run', async () => {
    const store = new MemoryExecutorStore();
    const prepared = await prepare(store);

    const [firstToken, secondToken] = await Promise.all([
      oidcToken({ run_id: '9001', run_attempt: '1' }),
      oidcToken({ run_id: '9002', run_attempt: '1' })
    ]);

    const env = executorEnv();
    const attempts = await Promise.allSettled([
      claimRemoteAttempt(
        env,
        {
          attemptId: prepared.attemptId,
          claimNonce: prepared.claimNonce,
          oidcToken: firstToken
        },
        { store, fetchImpl: jwksFetch() as typeof fetch, nowMs: 1_800_000_000_000 }
      ),
      claimRemoteAttempt(
        env,
        {
          attemptId: prepared.attemptId,
          claimNonce: prepared.claimNonce,
          oidcToken: secondToken
        },
        { store, fetchImpl: jwksFetch() as typeof fetch, nowMs: 1_800_000_000_000 }
      )
    ]);

    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);

    const record = await store.getRemoteAttempt(prepared.attemptId);
    expect(record?.state).toBe('claimed');
    expect(['9001', '9002']).toContain(record?.githubRunId);
    expect(record?.executorVersion).toBe('workflow-runner-v1');
    expect(record?.executorRevision).toBe(workflowSha);

    const loserRun = record?.githubRunId === '9001' ? '9002' : '9001';
    const loserToken = await oidcToken({ run_id: loserRun, run_attempt: '2' });
    await expect(
      claimRemoteAttempt(
        env,
        {
          attemptId: prepared.attemptId,
          claimNonce: prepared.claimNonce,
          oidcToken: loserToken
        },
        { store, fetchImpl: jwksFetch() as typeof fetch, nowMs: 1_800_000_001_000 }
      )
    ).rejects.toMatchObject({ code: 'ATTEMPT_CLAIM_REJECTED' });

    expect((await store.getRemoteAttempt(prepared.attemptId))?.githubRunId).toBe(record?.githubRunId);
  });

  it('does not let a valid GitHub JWT claim an arbitrary/mismatched registered task', async () => {
    const store = new MemoryExecutorStore();
    const prepared = await prepare(store);
    const env = executorEnv();

    await expect(
      claimRemoteAttempt(
        env,
        {
          attemptId: prepared.attemptId,
          claimNonce: 'wrong-nonce',
          oidcToken: await oidcToken({ run_id: '9010', run_attempt: '1' })
        },
        { store, fetchImpl: jwksFetch() as typeof fetch, nowMs: 1_800_000_000_000 }
      )
    ).rejects.toMatchObject({ code: 'ATTEMPT_CLAIM_REJECTED' });

    await expect(
      claimRemoteAttempt(
        env,
        {
          attemptId: prepared.attemptId,
          claimNonce: prepared.claimNonce,
          oidcToken: await oidcToken({
            run_id: '9011',
            run_attempt: '1',
            repository_id: '999999'
          })
        },
        { store, fetchImpl: jwksFetch() as typeof fetch, nowMs: 1_800_000_000_000 }
      )
    ).rejects.toMatchObject({ code: 'EXECUTOR_IDENTITY_MISMATCH' });

    await expect(
      claimRemoteAttempt(
        env,
        {
          attemptId: 'att_missing',
          claimNonce: prepared.claimNonce,
          oidcToken: await oidcToken({ run_id: '9012', run_attempt: '1' })
        },
        { store, fetchImpl: jwksFetch() as typeof fetch, nowMs: 1_800_000_000_000 }
      )
    ).rejects.toMatchObject({ code: 'ATTEMPT_NOT_FOUND' });
  });

  it('denies Claim after durable run cancellation', async () => {
    const store = new MemoryExecutorStore();
    const prepared = await prepare(store);
    store.setRunState(prepared.attemptId, 'cancel_requested');

    await expect(
      claimRemoteAttempt(
        executorEnv(),
        {
          attemptId: prepared.attemptId,
          claimNonce: prepared.claimNonce,
          oidcToken: await oidcToken({ run_id: '9020', run_attempt: '1' })
        },
        { store, fetchImpl: jwksFetch() as typeof fetch, nowMs: 1_800_000_000_000 }
      )
    ).rejects.toMatchObject({ code: 'RUN_NOT_CLAIMABLE' });
  });

  it('requires the known accepted physical run when no dispatch generation is unknown', async () => {
    const store = new MemoryExecutorStore();
    const prepared = await prepare(store);
    store.setDispatches(prepared.attemptId, [
      {
        generation: 1,
        outcome: 'accepted',
        returnedGitHubRunId: '9100',
        dispatchedAt: new Date().toISOString()
      }
    ]);

    await expect(
      claimRemoteAttempt(
        executorEnv(),
        {
          attemptId: prepared.attemptId,
          claimNonce: prepared.claimNonce,
          oidcToken: await oidcToken({ run_id: '9999', run_attempt: '1' })
        },
        { store, fetchImpl: jwksFetch() as typeof fetch, nowMs: 1_800_000_000_000 }
      )
    ).rejects.toMatchObject({ code: 'EXECUTOR_RUN_MISMATCH' });

    await expect(
      claimRemoteAttempt(
        executorEnv(),
        {
          attemptId: prepared.attemptId,
          claimNonce: prepared.claimNonce,
          oidcToken: await oidcToken({ run_id: '9100', run_attempt: '1' })
        },
        { store, fetchImpl: jwksFetch() as typeof fetch, nowMs: 1_800_000_000_000 }
      )
    ).resolves.toMatchObject({ expiresInSeconds: 300 });
  });

  it('allows an earlier valid Candidate when any dispatch generation is unknown', async () => {
    const store = new MemoryExecutorStore();
    const prepared = await prepare(store);
    store.setDispatches(prepared.attemptId, [
      {
        generation: 1,
        outcome: 'unknown',
        dispatchedAt: new Date().toISOString()
      },
      {
        generation: 2,
        outcome: 'accepted',
        returnedGitHubRunId: '9200',
        dispatchedAt: new Date().toISOString()
      }
    ]);

    await expect(
      claimRemoteAttempt(
        executorEnv(),
        {
          attemptId: prepared.attemptId,
          claimNonce: prepared.claimNonce,
          oidcToken: await oidcToken({ run_id: '9199', run_attempt: '1' })
        },
        { store, fetchImpl: jwksFetch() as typeof fetch, nowMs: 1_800_000_000_000 }
      )
    ).resolves.toMatchObject({ expiresInSeconds: 300 });
  });

  it('never transfers a claimed Attempt merely because its claim deadline would have expired', async () => {
    const store = new MemoryExecutorStore();
    const prepared = await prepare(store);
    const env = executorEnv();
    await claimRemoteAttempt(
      env,
      {
        attemptId: prepared.attemptId,
        claimNonce: prepared.claimNonce,
        oidcToken: await oidcToken({ run_id: '9300', run_attempt: '1' })
      },
      { store, fetchImpl: jwksFetch() as typeof fetch, nowMs: 1_800_000_000_000 }
    );

    await expect(
      claimRemoteAttempt(
        env,
        {
          attemptId: prepared.attemptId,
          claimNonce: prepared.claimNonce,
          oidcToken: await oidcToken({
            run_id: '9301',
            run_attempt: '1',
            iat: 1_800_100_000 - 10,
            nbf: 1_800_100_000 - 10,
            exp: 1_800_100_000 + 300
          })
        },
        { store, fetchImpl: jwksFetch() as typeof fetch, nowMs: 1_800_100_000_000 }
      )
    ).rejects.toMatchObject({ code: 'ATTEMPT_CLAIM_REJECTED' });

    expect((await store.getRemoteAttempt(prepared.attemptId))?.githubRunId).toBe('9300');
  });

  it('serves only the server-registered manifest under the scoped Lease', async () => {
    const store = new MemoryExecutorStore();
    const prepared = await prepare(store);
    const env = executorEnv();

    const claimed = await claimRemoteAttempt(
      env,
      {
        attemptId: prepared.attemptId,
        claimNonce: prepared.claimNonce,
        oidcToken: await oidcToken({ run_id: '9030', run_attempt: '3' })
      },
      { store, fetchImpl: jwksFetch() as typeof fetch, nowMs: 1_800_000_000_000 }
    );

    await expect(
      getExecutionManifest(env, claimed.lease, {
        store,
        nowSeconds: 1_800_000_050
      })
    ).resolves.toEqual(manifest());

    const tampered = claimed.lease.slice(0, -1) + (claimed.lease.endsWith('a') ? 'b' : 'a');
    await expect(
      getExecutionManifest(env, tampered, {
        store,
        nowSeconds: 1_800_000_050
      })
    ).rejects.toMatchObject({ code: 'INVALID_EXECUTOR_LEASE' });
  });

  it('persists callback facts idempotently before attempting Workflow notification', async () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const store = new MemoryExecutorStore();
    const prepared = await prepare(store);
    const env = executorEnv(async event => {
      events.push(event);
    });
    const claimed = await claimRemoteAttempt(
      env,
      {
        attemptId: prepared.attemptId,
        claimNonce: prepared.claimNonce,
        oidcToken: await oidcToken({ run_id: '9040', run_attempt: '1' })
      },
      { store, fetchImpl: jwksFetch() as typeof fetch, nowMs: 1_800_000_000_000 }
    );

    const first = await acceptExecutorCallback(
      env,
      claimed.lease,
      {
        callbackId: 'callback-1',
        kind: 'result',
        result: { state: 'succeeded', output: { ok: true } }
      },
      { store, nowMs: 1_800_000_010_000 }
    );
    const duplicate = await acceptExecutorCallback(
      env,
      claimed.lease,
      {
        callbackId: 'callback-1',
        kind: 'result',
        result: { state: 'succeeded', output: { ok: true } }
      },
      { store, nowMs: 1_800_000_011_000 }
    );

    expect(first).toMatchObject({ inserted: true, notified: true });
    expect(duplicate).toMatchObject({ inserted: false, notified: false });
    expect(store.callbackCount()).toBe(1);
    expect((await store.getRemoteAttempt(prepared.attemptId))?.state).toBe('claimed');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(attemptEventType(prepared.attemptId));
  });

  it('stores a late callback for a terminal Attempt but does not wake the Workflow', async () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const store = new MemoryExecutorStore();
    const prepared = await prepare(store);
    const env = executorEnv(async event => {
      events.push(event);
    });
    const claimed = await claimRemoteAttempt(
      env,
      {
        attemptId: prepared.attemptId,
        claimNonce: prepared.claimNonce,
        oidcToken: await oidcToken({ run_id: '9045', run_attempt: '1' })
      },
      { store, fetchImpl: jwksFetch() as typeof fetch, nowMs: 1_800_000_000_000 }
    );
    store.setAttemptState(prepared.attemptId, 'failed');

    const late = await acceptExecutorCallback(
      env,
      claimed.lease,
      {
        callbackId: 'callback-late',
        kind: 'result',
        result: { state: 'succeeded', output: { ok: true } }
      },
      { store, nowMs: 1_800_000_012_000 }
    );

    expect(late).toMatchObject({ inserted: true, notified: false });
    expect(store.callbackCount()).toBe(1);
    expect(events).toHaveLength(0);
  });

  it('keeps the inbox row pending when Workflow notification fails', async () => {
    const store = new MemoryExecutorStore();
    const prepared = await prepare(store);
    const env = executorEnv(async () => {
      throw new Error('sendEvent unavailable');
    });
    const claimed = await claimRemoteAttempt(
      env,
      {
        attemptId: prepared.attemptId,
        claimNonce: prepared.claimNonce,
        oidcToken: await oidcToken({ run_id: '9050', run_attempt: '1' })
      },
      { store, fetchImpl: jwksFetch() as typeof fetch, nowMs: 1_800_000_000_000 }
    );

    const callback = await acceptExecutorCallback(
      env,
      claimed.lease,
      {
        callbackId: 'callback-pending',
        kind: 'result',
        result: { state: 'succeeded' }
      },
      { store, nowMs: 1_800_000_020_000 }
    );

    expect(callback).toMatchObject({ inserted: true, notified: false });
    expect(store.callbackCount()).toBe(1);
    expect(store.notificationFailures).toBe(1);
  });

  it('creates an Attempt-specific Workflow event type within platform constraints', () => {
    expect(attemptEventType('att_0123456789abcdef')).toBe('attempt_att_0123456789abcdef');
    expect(attemptEventType('att_0123456789abcdef')).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
    expect(() => attemptEventType('x'.repeat(100))).toThrow(/event type/i);
  });
});

class MemoryExecutorStore implements ExecutorProtocolStore {
  private readonly attempts = new Map<string, RemoteAttemptRecord>();
  private readonly callbacks = new Set<string>();
  private readonly dispatches = new Map<string, ExecutorDispatchFact[]>();
  notificationFailures = 0;

  async registerRemoteAttempt(input: RemoteAttemptRegistration): Promise<void> {
    if (this.attempts.has(input.attemptId)) return;
    this.attempts.set(input.attemptId, {
      attemptId: input.attemptId,
      stepRunId: input.stepRunId,
      runId: input.runId,
      stepId: input.stepId,
      operationId: String(input.executionManifest.operationId),
      state: 'queued',
      runState: 'running',
      claimNonceHash: input.claimNonceHash,
      expectedRepositoryId: input.expectedRepositoryId,
      expectedWorkflowRef: input.expectedWorkflowRef,
      expectedRef: input.expectedRef,
      ...(input.expectedWorkflowSha ? { expectedWorkflowSha: input.expectedWorkflowSha } : {}),
      executorVersion: input.executorVersion,
      executionManifest: { ...input.executionManifest }
    });
  }

  async getRemoteAttempt(attemptId: string): Promise<RemoteAttemptRecord | null> {
    const attempt = this.attempts.get(attemptId);
    return attempt ? { ...attempt, executionManifest: { ...attempt.executionManifest } } : null;
  }

  async listExecutorDispatches(attemptId: string): Promise<ExecutorDispatchFact[]> {
    return [...(this.dispatches.get(attemptId) ?? [])];
  }

  setDispatches(attemptId: string, facts: ExecutorDispatchFact[]): void {
    this.dispatches.set(attemptId, [...facts]);
  }

  async claimRemoteAttempt(input: RemoteClaimInput): Promise<boolean> {
    const attempt = this.attempts.get(input.attemptId);
    if (
      !attempt ||
      attempt.state !== 'queued' ||
      attempt.runState === 'cancel_requested' ||
      attempt.claimNonceHash !== input.claimNonceHash ||
      attempt.expectedRepositoryId !== input.expectedRepositoryId ||
      attempt.expectedWorkflowRef !== input.expectedWorkflowRef ||
      attempt.expectedRef !== input.expectedRef ||
      (attempt.expectedWorkflowSha !== undefined &&
        attempt.expectedWorkflowSha !== input.githubWorkflowSha) ||
      attempt.githubRunId !== undefined
    ) {
      return false;
    }

    attempt.state = 'claimed';
    attempt.claimOwner = input.claimOwner;
    attempt.githubRunId = input.githubRunId;
    attempt.githubRunAttempt = input.githubRunAttempt;
    attempt.githubWorkflowSha = input.githubWorkflowSha;
    attempt.executorRevision = input.executorRevision;
    return true;
  }

  async insertCallbackInbox(input: CallbackInboxInput): Promise<CallbackInboxInsertResult> {
    const attempt = this.attempts.get(input.attemptId);
    if (
      !attempt ||
      attempt.githubRunId !== input.githubRunId ||
      attempt.githubRunAttempt !== input.githubRunAttempt
    ) {
      return { inserted: false };
    }
    const inserted = !this.callbacks.has(input.callbackId);
    this.callbacks.add(input.callbackId);
    return { inserted };
  }

  async markCallbackNotified(_callbackId: string): Promise<void> {}

  async recordCallbackNotificationFailure(
    _callbackId: string,
    _nextNotificationAt: string
  ): Promise<void> {
    this.notificationFailures += 1;
  }

  setAttemptState(attemptId: string, state: RemoteAttemptRecord['state']): void {
    const attempt = this.attempts.get(attemptId);
    if (attempt) attempt.state = state;
  }

  setRunState(attemptId: string, state: RemoteAttemptRecord['runState']): void {
    const attempt = this.attempts.get(attemptId);
    if (attempt) attempt.runState = state;
  }

  callbackCount(): number {
    return this.callbacks.size;
  }
}

async function prepare(store: MemoryExecutorStore) {
  return prepareRemoteAttempt(store, {
    runId: 'run_1',
    stepRunId: 'step_1',
    stepId: 'archive',
    attemptId: 'att_0123456789abcdef0123456789abcdef',
    attemptNumber: 1,
    trust: {
      repositoryId: '12345',
      workflowRef,
      ref,
      workflowSha
    },
    manifest: manifest()
  });
}

function manifest(): ExecutionManifest {
  return {
    version: 1,
    runId: 'run_1',
    stepRunId: 'step_1',
    attemptId: 'att_0123456789abcdef0123456789abcdef',
    operationId: 'op_1',
    capability: 'github.archive_markdown',
    input: {
      content: '# hello',
      source_url: 'https://example.com/'
    },
    timeoutMs: 300_000
  };
}

function executorEnv(
  sendEvent: (event: { type: string; payload: unknown }) => Promise<void> = async () => {}
): Env {
  return {
    DB: {} as D1Database,
    WORKFLOW: {
      get: async () => ({ sendEvent })
    } as unknown as Env['WORKFLOW'],
    EXECUTOR_LEASE_SECRET: 'lease-secret',
    GITHUB_OIDC_ISSUER: issuer,
    GITHUB_OIDC_AUDIENCE: audience,
    GITHUB_OIDC_JWKS_URL: jwksUrl
  };
}

function jwksFetch() {
  return vi.fn(async () => Response.json({ keys: [publicJwk] }));
}

async function oidcToken(
  overrides: Partial<Record<string, unknown>>
): Promise<string> {
  const now = 1_800_000_000;
  const claims = {
    iss: issuer,
    aud: audience,
    iat: now - 10,
    nbf: now - 10,
    exp: now + 300,
    repository_id: '12345',
    workflow_ref: workflowRef,
    ref,
    workflow_sha: workflowSha,
    run_id: '9000',
    run_attempt: '1',
    ...overrides
  };

  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT', kid: 'test-key' });
  const payload = base64UrlJson(claims);
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(input)
  );
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
