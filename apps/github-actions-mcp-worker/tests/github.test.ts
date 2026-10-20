import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionError, assertRepo, configuredAccounts, configuredRepos, GitHubActionsClient } from '../src/github.ts';
import type { Env } from '../src/github.ts';

const config: Env = {
  MCP_ACCESS_TOKEN: 'mcp-secret',
  GH_TOKEN: 'github-secret',
  GITHUB_REPOS: 'autoactions/tsrv, autoactions/tsvc',
};

test('allowlist is explicit and rejects unknown repositories before transport', async () => {
  assert.deepEqual(configuredRepos(config.GITHUB_REPOS), ['autoactions/tsrv', 'autoactions/tsvc']);
  assert.throws(() => assertRepo(configuredRepos(config.GITHUB_REPOS), 'other/repo'), { code: 'repository_not_allowed' });
  assert.throws(() => configuredRepos('autoactions/tsrv,../evil'), { code: 'invalid_repository_configuration' });
  let count = 0;
  const client = new GitHubActionsClient(config, (async () => { count += 1; return Response.json({}); }) as typeof fetch);
  await assert.rejects(() => client.listWorkflows('evil/repo'), { code: 'repository_not_allowed' });
  assert.equal(count, 0);
});


test('two GitHub accounts route by exact repository without credential fallback', async () => {
  const twoAccounts: Env = {
    ...config,
    GH_TOKEN_SECONDARY: 'lirtual-private-token',
    GITHUB_REPOS_SECONDARY: 'lirtual/mcp-workers',
  };
  const requests: Array<{ repo: string; authorization: string }> = [];
  const client = new GitHubActionsClient(twoAccounts, (async (url, init) => {
    const full = String(url);
    requests.push({
      repo: full.split('/repos/')[1]?.split('/actions/')[0] ?? '',
      authorization: new Headers(init?.headers).get('authorization') ?? '',
    });
    return Response.json({ total_count: 0, workflows: [] });
  }) as typeof fetch);
  assert.deepEqual(client.allowlist, ['autoactions/tsrv', 'autoactions/tsvc', 'lirtual/mcp-workers']);
  await client.listWorkflows('autoactions/tsrv');
  await client.listWorkflows('lirtual/mcp-workers');
  await client.listWorkflows('LIRTUAL/MCP-WORKERS');
  assert.deepEqual(requests, [
    { repo: 'autoactions/tsrv', authorization: 'Bearer github-secret' },
    { repo: 'lirtual/mcp-workers', authorization: 'Bearer lirtual-private-token' },
    { repo: 'LIRTUAL/MCP-WORKERS', authorization: 'Bearer lirtual-private-token' },
  ]);
  await assert.rejects(() => client.listWorkflows('not-authorized/other'), {
    code: 'repository_not_allowed',
  });
  assert.equal(requests.length, 3);
});

test('missing, overlapping or unassigned second-account secrets fail closed', async () => {
  const base: Env = { ...config, GITHUB_REPOS_SECONDARY: 'lirtual/mcp-workers' };
  assert.throws(() => configuredAccounts(base), { code: 'github_token_secondary_not_configured' });
  assert.throws(() => configuredAccounts({
    ...config, GH_TOKEN_SECONDARY: 'unused-secret',
  }), { code: 'secondary_repository_not_configured' });
  assert.throws(() => configuredAccounts({
    ...base, GH_TOKEN_SECONDARY: 'other-token',
    GITHUB_REPOS_SECONDARY: 'AUTOACTIONS/TSRV',
  }), { code: 'duplicate_repository_configuration' });
  assert.throws(() => configuredAccounts({
    ...base, GH_TOKEN_SECONDARY: 'other-token',
    GITHUB_REPOS_SECONDARY: 'lirtual/mcp-workers,../invalid',
  }), { code: 'invalid_repository_configuration' });
  assert.deepEqual(configuredAccounts(config).all,
    ['autoactions/tsrv', 'autoactions/tsvc']);

  const client = new GitHubActionsClient({
    ...base, GH_TOKEN_SECONDARY: 'second-secret',
  }, (async () => Response.json({ message: 'only secondary secret could access' }, { status: 403 })) as typeof fetch);
  await assert.rejects(() => client.listWorkflows('lirtual/mcp-workers'), { code: 'github_http_403' });
  // Never retry a GitHub 403/401 with the other account credential.
});

test('workflow dispatch sends correct payload and returns GitHub accepted run id', async () => {
  const requests: Array<{ url: string, method: string, authorization: string, body: any }> = [];
  const client = new GitHubActionsClient(config, (async (url, init) => {
    requests.push({
      url: String(url), method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('authorization') ?? '',
      body: JSON.parse(String(init?.body)),
    });
    return Response.json({ workflow_run_id: 777, html_url: 'https://github.com/autoactions/tsrv/actions/runs/777' });
  }) as typeof fetch);
  const value = await client.dispatchWorkflow('autoactions/tsrv', 'linux.yml', 'main', { access_profile: 'mini' });
  assert.equal(value.workflow_run_id, 777);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://api.github.com/repos/autoactions/tsrv/actions/workflows/linux.yml/dispatches');
  assert.equal(requests[0]?.method, 'POST');
  assert.equal(requests[0]?.authorization, 'Bearer github-secret');
  assert.deepEqual(requests[0]?.body, { ref: 'main', inputs: { access_profile: 'mini' }, return_run_details: true });
});

test('repository dispatch uses dedicated GitHub event API', async () => {
  let body: any;
  const client = new GitHubActionsClient(config, (async (_, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(null, { status: 204 });
  }) as typeof fetch);
  const value = await client.dispatchRepository('autoactions/tsvc', 'deploy', { service: 'chrome' });
  assert.deepEqual(body, { event_type: 'deploy', client_payload: { service: 'chrome' } });
  assert.equal(value.accepted, true);
});

test('normal and force cancellation only acknowledge requests and use explicit endpoints', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const client = new GitHubActionsClient(config, (async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    return new Response(null, { status: 202 });
  }) as typeof fetch);

  assert.deepEqual(await client.cancelRun('autoactions/tsrv', 39365524170), {
    accepted: true, cancellation: 'requested', completion_confirmed: false, run_id: 39365524170,
  });
  assert.deepEqual(await client.forceCancelRun('autoactions/tsrv', 39365524170), {
    accepted: true, cancellation: 'force_requested', completion_confirmed: false, run_id: 39365524170,
  });
  assert.deepEqual(calls, [
    { url: 'https://api.github.com/repos/autoactions/tsrv/actions/runs/39365524170/cancel', method: 'POST' },
    { url: 'https://api.github.com/repos/autoactions/tsrv/actions/runs/39365524170/force-cancel', method: 'POST' },
  ]);
});

test('force cancel validates repository and run id before sending and sanitizes conflict', async () => {
  let callCount = 0;
  const client = new GitHubActionsClient(config, (async () => {
    callCount++;
    return Response.json({ message: 'private credentials' }, { status: 409 });
  }) as typeof fetch);
  await assert.rejects(() => client.forceCancelRun('unlisted/repo', 8), { code: 'repository_not_allowed' });
  await assert.rejects(() => client.forceCancelRun('autoactions/tsrv', 0), { code: 'invalid_run_id' });
  assert.equal(callCount, 0);
  await assert.rejects(() => client.forceCancelRun('autoactions/tsrv', 8), (err: unknown) =>
    err instanceof ActionError && err.code === 'github_http_409' &&
    !err.message.includes('private credentials'));
  assert.equal(callCount, 1);
});

test('upstream errors reveal only status, not response body or credentials', async () => {
  const client = new GitHubActionsClient(config, (async () =>
    Response.json({ message: 'github-secret and private data' }, { status: 403 })) as typeof fetch);
  await assert.rejects(() => client.getRun('autoactions/tsrv', 42), (err: unknown) =>
    err instanceof ActionError && err.code === 'github_http_403' &&
    !err.message.includes('github-secret'));
});

test('run lookup returns bounded metadata rather than the raw upstream object', async () => {
  const client = new GitHubActionsClient(config, (async () =>
    Response.json({ id: 42, status: 'in_progress', conclusion: null,
      html_url: 'https://github.com/autoactions/tsrv/actions/runs/42',
      private_token: 'do-not-return' })) as typeof fetch);
  const value = await client.getRun('autoactions/tsrv', 42);
  assert.equal(value.id, 42);
  assert.equal(value.status, 'in_progress');
  assert.equal(JSON.stringify(value).includes('do-not-return'), false);
});


test('injected fetch is called without a class receiver (Workers compatibility)', async () => {
  // Workerd enforces the receiver on native fetch; Node does not.
  const receiverCheckedFetch = function (this: unknown) {
    assert.equal(this, undefined);
    return Promise.resolve(Response.json({ total_count: 0, workflows: [] }));
  } as typeof fetch;
  const client = new GitHubActionsClient(config, receiverCheckedFetch);
  assert.deepEqual(await client.listWorkflows('autoactions/tsrv'), {
    total_count: 0,
    workflows: [],
  });
});
