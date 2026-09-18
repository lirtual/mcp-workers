import { issueExecutorLease, verifyExecutorLease, type ExecutorLeaseClaims } from './lease.js';
import {
  verifyGitHubOidcToken,
  type GitHubJobIdentity,
  type GitHubOidcVerificationConfig
} from './oidc.js';
import {
  D1WorkflowStore,
  type RemoteAttemptRecord
} from './storage.js';
import type { Env } from './types.js';

const CLAIM_TTL_MS = 15 * 60 * 1000;
const CALLBACK_RETRY_MS = 30 * 1000;

export interface ExecutionManifest {
  version: 1;
  runId: string;
  stepRunId: string;
  attemptId: string;
  operationId: string;
  capability: string;
  input: Record<string, unknown>;
  timeoutMs?: number;
}

export interface RemoteAttemptTrust {
  repositoryId: string;
  workflowRef: string;
  ref: string;
  workflowSha?: string;
}

export interface PrepareRemoteAttemptInput {
  runId: string;
  stepRunId: string;
  stepId: string;
  attemptId: string;
  attemptNumber: number;
  trust: RemoteAttemptTrust;
  manifest: ExecutionManifest;
}

export interface PreparedRemoteAttempt {
  attemptId: string;
  claimNonce: string;
  eventType: string;
}

export interface ClaimResult {
  lease: string;
  eventType: string;
  expiresInSeconds: number;
}

export async function prepareRemoteAttempt(
  store: D1WorkflowStore,
  input: PrepareRemoteAttemptInput
): Promise<PreparedRemoteAttempt> {
  validateManifest(input.manifest, input);
  const claimNonce = randomToken(32);
  const claimNonceHash = await sha256Hex(claimNonce);

  await store.registerRemoteAttempt({
    runId: input.runId,
    stepRunId: input.stepRunId,
    stepId: input.stepId,
    attemptId: input.attemptId,
    attemptNumber: input.attemptNumber,
    claimNonceHash,
    expectedRepositoryId: input.trust.repositoryId,
    expectedWorkflowRef: input.trust.workflowRef,
    expectedRef: input.trust.ref,
    ...(input.trust.workflowSha ? { expectedWorkflowSha: input.trust.workflowSha } : {}),
    executionManifest: input.manifest
  });

  return {
    attemptId: input.attemptId,
    claimNonce,
    eventType: attemptEventType(input.attemptId)
  };
}

export async function claimRemoteAttempt(
  env: Env,
  input: {
    attemptId: string;
    claimNonce: string;
    oidcToken: string;
  },
  options: {
    fetchImpl?: typeof fetch;
    nowMs?: number;
  } = {}
): Promise<ClaimResult> {
  const config = oidcConfig(env);
  const nowMs = options.nowMs ?? Date.now();
  const identity = await verifyGitHubOidcToken(
    input.oidcToken,
    config,
    options.fetchImpl ?? fetch,
    Math.floor(nowMs / 1000)
  );

  const store = new D1WorkflowStore(env.DB);
  const registered = await store.getRemoteAttempt(input.attemptId);
  if (!registered) throw new ExecutorProtocolError(404, 'ATTEMPT_NOT_FOUND', 'Registered Attempt was not found.');

  assertCandidateMatchesRegistration(identity, registered);
  const claimNonceHash = await sha256Hex(input.claimNonce);
  const claimOwner = `github:${identity.runId}:${identity.runAttempt}`;
  const claimed = await store.claimRemoteAttempt({
    attemptId: input.attemptId,
    claimNonceHash,
    claimOwner,
    claimDeadline: new Date(nowMs + CLAIM_TTL_MS).toISOString(),
    githubRunId: identity.runId,
    githubRunAttempt: identity.runAttempt,
    githubWorkflowSha: identity.workflowSha,
    expectedRepositoryId: identity.repositoryId,
    expectedWorkflowRef: identity.workflowRef,
    expectedRef: identity.ref
  });

  if (!claimed) {
    throw new ExecutorProtocolError(
      409,
      'ATTEMPT_CLAIM_REJECTED',
      'Attempt is not claimable by this Candidate Job.'
    );
  }

  const leaseSecret = requiredEnv(env.EXECUTOR_LEASE_SECRET, 'EXECUTOR_LEASE_SECRET');
  const lease = await issueExecutorLease(
    leaseSecret,
    {
      attemptId: registered.attemptId,
      runId: registered.runId,
      stepRunId: registered.stepRunId,
      githubRunId: identity.runId,
      githubRunAttempt: identity.runAttempt,
      permissions: ['manifest:read', 'artifact:allocate', 'callback:write']
    },
    { ttlSeconds: 300, nowSeconds: Math.floor(nowMs / 1000) }
  );

  return { lease, eventType: attemptEventType(input.attemptId), expiresInSeconds: 300 };
}

export async function getExecutionManifest(
  env: Env,
  leaseToken: string,
  nowSeconds?: number
): Promise<ExecutionManifest> {
  const claims = await verifyLease(env, leaseToken, 'manifest:read', nowSeconds);
  const store = new D1WorkflowStore(env.DB);
  const attempt = await store.getRemoteAttempt(claims.attemptId);
  assertLeaseMatchesAttempt(claims, attempt);
  validateStoredManifest(attempt.executionManifest, claims);
  return attempt.executionManifest as unknown as ExecutionManifest;
}

export async function acceptExecutorCallback(
  env: Env,
  leaseToken: string,
  input: {
    callbackId: string;
    kind: 'result';
    result: Record<string, unknown>;
  },
  options: { nowMs?: number } = {}
): Promise<{ inserted: boolean; notified: boolean; eventType: string }> {
  const nowMs = options.nowMs ?? Date.now();
  const claims = await verifyLease(
    env,
    leaseToken,
    'callback:write',
    Math.floor(nowMs / 1000)
  );
  const store = new D1WorkflowStore(env.DB);
  const attempt = await store.getRemoteAttempt(claims.attemptId);
  assertLeaseMatchesAttempt(claims, attempt);

  const inserted = await store.insertCallbackInbox({
    callbackId: input.callbackId,
    attemptId: claims.attemptId,
    githubRunId: claims.githubRunId,
    githubRunAttempt: claims.githubRunAttempt,
    callbackKind: input.kind,
    result: input.result
  });

  const eventType = attemptEventType(claims.attemptId);
  try {
    const instance = await env.WORKFLOW.get(claims.runId);
    await instance.sendEvent({
      type: eventType,
      payload: { kind: input.kind, callbackId: input.callbackId }
    });
    await store.markCallbackNotified(input.callbackId);
    return { inserted: inserted.inserted, notified: true, eventType };
  } catch {
    await store.recordCallbackNotificationFailure(
      input.callbackId,
      new Date(nowMs + CALLBACK_RETRY_MS).toISOString()
    );
    return { inserted: inserted.inserted, notified: false, eventType };
  }
}

export function attemptEventType(attemptId: string): string {
  const type = `attempt_${attemptId}`;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(type)) {
    throw new Error('Attempt ID cannot be represented as a Workflow event type.');
  }
  return type;
}

export class ExecutorProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

async function verifyLease(
  env: Env,
  token: string,
  permission: Parameters<typeof verifyExecutorLease>[2],
  nowSeconds?: number
): Promise<ExecutorLeaseClaims> {
  const secret = requiredEnv(env.EXECUTOR_LEASE_SECRET, 'EXECUTOR_LEASE_SECRET');
  try {
    return await verifyExecutorLease(token, secret, permission, nowSeconds);
  } catch (error) {
    throw new ExecutorProtocolError(
      401,
      'INVALID_EXECUTOR_LEASE',
      error instanceof Error ? error.message : 'Executor lease is invalid.'
    );
  }
}

function assertCandidateMatchesRegistration(
  identity: GitHubJobIdentity,
  attempt: RemoteAttemptRecord
): void {
  if (
    identity.repositoryId !== attempt.expectedRepositoryId ||
    identity.workflowRef !== attempt.expectedWorkflowRef ||
    identity.ref !== attempt.expectedRef ||
    (attempt.expectedWorkflowSha !== undefined &&
      identity.workflowSha !== attempt.expectedWorkflowSha)
  ) {
    throw new ExecutorProtocolError(
      403,
      'EXECUTOR_IDENTITY_MISMATCH',
      'GitHub Job identity does not match the registered Attempt trust policy.'
    );
  }
}

function assertLeaseMatchesAttempt(
  claims: ExecutorLeaseClaims,
  attempt: RemoteAttemptRecord | null
): asserts attempt is RemoteAttemptRecord {
  if (
    !attempt ||
    attempt.runId !== claims.runId ||
    attempt.stepRunId !== claims.stepRunId ||
    attempt.githubRunId !== claims.githubRunId ||
    attempt.githubRunAttempt !== claims.githubRunAttempt ||
    attempt.claimOwner !== `github:${claims.githubRunId}:${claims.githubRunAttempt}` ||
    (attempt.state !== 'claimed' &&
      attempt.state !== 'running' &&
      attempt.state !== 'cancel_requested')
  ) {
    throw new ExecutorProtocolError(
      403,
      'LEASE_BINDING_MISMATCH',
      'Executor lease is not bound to the current Attempt owner.'
    );
  }
}

function validateManifest(manifest: ExecutionManifest, input: PrepareRemoteAttemptInput): void {
  if (
    manifest.version !== 1 ||
    manifest.runId !== input.runId ||
    manifest.stepRunId !== input.stepRunId ||
    manifest.attemptId !== input.attemptId ||
    typeof manifest.operationId !== 'string' ||
    typeof manifest.capability !== 'string' ||
    !manifest.input ||
    typeof manifest.input !== 'object' ||
    Array.isArray(manifest.input)
  ) {
    throw new Error('Execution Manifest does not match the registered Attempt.');
  }
}

function validateStoredManifest(
  value: Record<string, unknown>,
  claims: ExecutorLeaseClaims
): void {
  if (
    value.version !== 1 ||
    value.runId !== claims.runId ||
    value.stepRunId !== claims.stepRunId ||
    value.attemptId !== claims.attemptId ||
    typeof value.operationId !== 'string' ||
    typeof value.capability !== 'string' ||
    !value.input ||
    typeof value.input !== 'object' ||
    Array.isArray(value.input)
  ) {
    throw new ExecutorProtocolError(500, 'INVALID_EXECUTION_MANIFEST', 'Stored Execution Manifest is invalid.');
  }
}

function oidcConfig(env: Env): GitHubOidcVerificationConfig {
  return {
    issuer: requiredEnv(env.GITHUB_OIDC_ISSUER, 'GITHUB_OIDC_ISSUER'),
    audience: requiredEnv(env.GITHUB_OIDC_AUDIENCE, 'GITHUB_OIDC_AUDIENCE'),
    jwksUrl: requiredEnv(env.GITHUB_OIDC_JWKS_URL, 'GITHUB_OIDC_JWKS_URL')
  };
}

function requiredEnv(value: string | undefined, name: string): string {
  if (!value) throw new ExecutorProtocolError(503, 'EXECUTOR_PROTOCOL_NOT_CONFIGURED', `${name} is not configured.`);
  return value;
}

function randomToken(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64Url(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
