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
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.redirect, 'manual');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer ' + token);
    assert.equal(headers.get('user-agent'), 'lirtual-database-mcp-worker');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      ref: 'main',
      return_run_details: true,
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
  assert.deepEqual(payload, { ref: 'main', return_run_details: true,
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
      return_run_details: true,
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

test('GitHub HTTP 200 with validated run ID is accepted for both smoke and enable', async () => {
  const mocked = async () => Response.json({ workflow_run_id: 40850012345,
    run_url: 'https://api.github.com/repos/lirtual/mcp-workers/actions/runs/40850012345',
    html_url: 'https://github.com/lirtual/mcp-workers/actions/runs/40850012345' }, { status: 200 });
  assert.deepEqual(await verifyGithubActionsDispatch(env(), mocked as typeof fetch), { runId: 40850012345 });
  assert.deepEqual(await dispatchHyperdriveAction(env(), 'enable', 'safe', 1, mocked as typeof fetch),
    { runId: 40850012345 });
});

test('GitHub HTTP 204 remains accepted without claiming a run ID', async () => {
  const mocked = async () => new Response(null, { status: 204 });
  assert.deepEqual(await verifyGithubActionsDispatch(env(), mocked as typeof fetch), {});
});

test('invalid HTTP 200 run receipt fails closed without provider details', async () => {
  for (const value of [null, {}, { workflow_run_id: '40850012345' },
    { workflow_run_id: 0 }, { workflow_run_id: -1 }]) {
    const request = async () => Response.json(value, { status: 200 });
    await assert.rejects(verifyGithubActionsDispatch(env(), request as typeof fetch),
      /receipt unavailable/);
  }
});

test('GitHub error status classes are fixed, and provider body is never exposed', async () => {
  const cases: Array<[number,string]> = [[401,'unauthorized'],[403,'forbidden'],[404,'workflow unavailable'],
    [422,'inputs rejected'],[429,'rate limited'],[500,'upstream unavailable'],[418,'HTTP rejected']];
  for (const [status, expected] of cases) {
    const request = async () => new Response('secret-upstream-response', { status });
    await assert.rejects(verifyGithubActionsDispatch(env(), request as typeof fetch), error => {
      assert.match(String(error), new RegExp(expected));
      assert.doesNotMatch(String(error), /secret-upstream-response/);
      return true;
    });
  }
});

test('Cloudflare Workers fetch contract: unsupported redirect error never reaches GitHub', async () => {
  // The real workerd runtime throws TypeError for redirect: 'error'.
  // Preserve this narrow runtime behavior in the existing unit suite.
  let calls = 0;
  const workerdLikeFetch = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls++;
    if (init?.redirect === 'error') throw new TypeError('Unsupported redirect mode: error');
    assert.equal(init?.redirect, 'manual');
    return Response.json({ workflow_run_id: 40850012345 }, { status: 200 });
  };
  assert.deepEqual(await verifyGithubActionsDispatch(env(), workerdLikeFetch as typeof fetch),
    { runId: 40850012345 });
  assert.equal(calls, 1);
});

test('GitHub redirects are rejected without following authorization header', async () => {
  let calls = 0;
  const mocked = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls++;
    assert.equal(init?.redirect, 'manual');
    return new Response(null, {
      status: 302,
      headers: { location: 'https://untrusted.example.org/steal-pat' }
    });
  };
  await assert.rejects(verifyGithubActionsDispatch(env(), mocked as typeof fetch), /redirect rejected/);
  assert.equal(calls, 1);
});

test('workerd GitHub REST contract includes mandatory User-Agent on every action', async () => {
  let accepted = 0;
  const strictGithub = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (!headers.get('user-agent')) return new Response('GitHub API requires User-Agent', { status: 403 });
    assert.equal(headers.get('user-agent'), 'lirtual-database-mcp-worker');
    accepted++;
    return Response.json({ workflow_run_id: 40850012345 }, { status: 200 });
  };
  assert.deepEqual(await verifyGithubActionsDispatch(env(), strictGithub as typeof fetch),
    { runId: 40850012345 });
  assert.deepEqual(await dispatchHyperdriveAction(env(), 'enable', 'openlist', 1, strictGithub as typeof fetch),
    { runId: 40850012345 });
  assert.equal(accepted, 2);
});
