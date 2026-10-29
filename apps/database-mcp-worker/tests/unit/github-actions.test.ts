import { test } from 'vitest';
import assert from 'node:assert/strict';
import { dispatchHyperdriveAction, verifyGithubActionsDispatch } from '../../src/setup/github-actions.js';
import type { Env } from '../../src/types.js';

const token = 'github_pat_synthetic_test_token_never_real';
function env(secret: string | undefined = token): Env {
  return { RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...(secret ? { DATABASE_GITHUB_ACTIONS_TOKEN: secret } : {}) };
}

test('Owner dispatch uses exactly one pinned GitHub workflow with bounded enable inputs', async () => {
  let seen = 0;
  const mocked = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    seen++;
    assert.equal(String(input), 'https://api.github.com/repos/lirtual/mcp-workers/actions/workflows/release.yml/dispatches');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer ' + token);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      ref: 'main',
      inputs: { worker: 'database-mcp-worker', deploy_to_production: 'false',
        database_hyperdrive_enable_approved: 'true',
        database_hyperdrive_enable_id: 'openlist',
        database_hyperdrive_enable_revision: '3' }
    });
    return new Response(null, { status: 204 });
  };
  await dispatchHyperdriveAction(env(), 'enable', 'openlist', 3, mocked as typeof fetch);
  assert.equal(seen, 1);
});

test('retirement dispatch does not request deployment or ever include credentials', async () => {
  let payload: unknown;
  const mocked = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    payload = JSON.parse(String(init?.body));
    return new Response(null, { status: 204 });
  };
  await dispatchHyperdriveAction(env(), 'retire', 'retired_id', 2, mocked as typeof fetch);
  assert.deepEqual(payload, { ref: 'main',
    inputs: { worker: 'database-mcp-worker', deploy_to_production: 'false',
      database_hyperdrive_retire_approved: 'true', database_hyperdrive_retire_id: 'retired_id',
      database_hyperdrive_retire_revision: '2' } });
});

test('invalid input or absent scoped secret rejects without a network call', async () => {
  let calls = 0;
  const mocked = async (): Promise<Response> => {
    calls++;
    throw Error('should not be called');
  };
  await assert.rejects(dispatchHyperdriveAction(env(''), 'enable', 'safe', 1, mocked as typeof fetch), /not configured/);
  await assert.rejects(dispatchHyperdriveAction(env(), 'enable', '../unsafe', 1, mocked as typeof fetch));
  await assert.rejects(dispatchHyperdriveAction(env(), 'enable', 'safe', 0, mocked as typeof fetch));
  assert.equal(calls, 0);
});

test('non-204 or network error does not expose provider response body', async () => {
  const secret = 'do-not-print-this-upstream-body';
  const bad = async () => new Response(secret, { status: 403 });
  await assert.rejects(dispatchHyperdriveAction(env(), 'enable', 'safe', 1, bad as typeof fetch),
    err => { assert.doesNotMatch(String(err), /do-not-print/); return true; });
  const lost = async () => { throw Error(secret); };
  await assert.rejects(dispatchHyperdriveAction(env(), 'retire', 'safe', 1, lost as typeof fetch),
    err => { assert.doesNotMatch(String(err), /do-not-print/); return true; });
});

test('verification-only dispatch sets no release, activation, retirement, or fixture flags', async () => {
  let calls = 0;
  const request = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls++;
    assert.equal(String(input), 'https://api.github.com/repos/lirtual/mcp-workers/actions/workflows/release.yml/dispatches');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      ref: 'main',
      inputs: { worker: 'database-mcp-worker', deploy_to_production: 'false' }
    });
    return new Response(null, { status: 204 });
  };
  await verifyGithubActionsDispatch(env(), request as typeof fetch);
  assert.equal(calls, 1);
});

test('verification-only dispatch rejects missing token or GitHub error without leaks', async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return new Response('protected secret must never appear', { status: 403 });
  };
  await assert.rejects(verifyGithubActionsDispatch(env(''), request as typeof fetch), /not configured/);
  assert.equal(calls, 0);
  await assert.rejects(verifyGithubActionsDispatch(env(), request as typeof fetch), error => {
    assert.doesNotMatch(String(error), /protected secret/);
    return true;
  });
  assert.equal(calls, 1);
});
