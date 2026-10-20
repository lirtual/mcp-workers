import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionError, GitHubActionsClient } from '../src/github.ts';
import type { Env } from '../src/github.ts';

const config: Env = {
  MCP_ACCESS_TOKEN: 'mcp-secret',
  GH_TOKEN: 'primary-pat',
};

function mockGitHub(
  onRequest: (url: string, init?: RequestInit) => Promise<Response>,
  repositories: Record<string, string[]> = {
    'primary-pat': ['autoactions/tsrv', 'autoactions/tsvc'],
    'secondary-pat': ['lirtual/mcp-workers'],
  },
): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.github.com/user/repos?')) {
      const pat = (new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, '');
      const page = Number(new URL(url).searchParams.get('page'));
      return Response.json(page === 1 ? (repositories[pat] ?? []).map(full_name => ({ full_name })) : []);
    }
    return onRequest(url, init);
  }) as typeof fetch;
}

test('repositories are discovered from PAT permission rather than a static allowlist', async () => {
  const client = new GitHubActionsClient(config, mockGitHub(async () => {
    throw Error('No actions request expected');
  }));
  assert.deepEqual(await client.listRepositories(), {
    repositories: ['autoactions/tsrv', 'autoactions/tsvc'],
    ambiguous_repositories: [],
  });
  await assert.rejects(() => client.listWorkflows('other/repo'),
    { code: 'repository_not_accessible' });
  await assert.rejects(() => client.listWorkflows('../escape'),
    { code: 'invalid_repository' });
});

test('two PATs select the correct account without passing credentials in MCP replies', async () => {
  const calls: Array<{ url: string; auth: string }> = [];
  const client = new GitHubActionsClient({
    ...config, GH_TOKEN_SECONDARY: 'secondary-pat',
  }, mockGitHub(async (url, init) => {
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') ?? '' });
    return Response.json({ total_count: 0, workflows: [] });
  }));
  assert.deepEqual(await client.listRepositories(), {
    repositories: ['autoactions/tsrv', 'autoactions/tsvc', 'lirtual/mcp-workers'],
    ambiguous_repositories: [],
  });
  await client.listWorkflows('autoactions/tsrv');
  await client.listWorkflows('lirtual/mcp-workers');
  assert.deepEqual(calls.map(({ auth }) => auth), ['Bearer primary-pat', 'Bearer secondary-pat']);
  assert.equal(JSON.stringify(await client.listRepositories()).includes('pat'), false);
});

test('overlapping token access fails closed, including case-insensitive repository matches', async () => {
  const client = new GitHubActionsClient({
    ...config, GH_TOKEN_SECONDARY: 'secondary-pat',
  }, mockGitHub(async () => { throw Error('No mutation must be dispatched'); }, {
    'primary-pat': ['lirtual/mcp-workers'],
    'secondary-pat': ['LIRTUAL/MCP-WORKERS'],
  }));
  assert.deepEqual(await client.listRepositories(), {
    repositories: [],
    ambiguous_repositories: ['lirtual/mcp-workers'],
  });
  await assert.rejects(
    () => client.dispatchWorkflow('lirtual/mcp-workers', 'ci.yml', 'main', {}),
    { code: 'ambiguous_repository_credentials' },
  );
  assert.throws(() => new GitHubActionsClient({ ...config, GH_TOKEN_SECONDARY: 'primary-pat' }),
    { code: 'duplicate_github_token' });
});

test('dispatch sends one write to the discovered PAT and refuses cross-PAT fallback', async () => {
  const requests: Array<{ url: string; auth: string; body: any }> = [];
  const client = new GitHubActionsClient({
    ...config, GH_TOKEN_SECONDARY: 'secondary-pat',
  }, mockGitHub(async (url, init) => {
    requests.push({
      url, auth: new Headers(init?.headers).get('authorization') ?? '',
      body: JSON.parse(String(init?.body)),
    });
    return Response.json({ workflow_run_id: 777 }, { status: 200 });
  }));
  assert.deepEqual(await client.dispatchWorkflow('lirtual/mcp-workers', 'ci.yml', 'main', {
    worker: 'remote-control-mcp-worker',
  }), { workflow_run_id: 777 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].auth, 'Bearer secondary-pat');
  assert.equal(requests[0].url,
    'https://api.github.com/repos/lirtual/mcp-workers/actions/workflows/ci.yml/dispatches');
  assert.equal(requests[0].body.return_run_details, true);

  let deniedRequests = 0;
  const denied = new GitHubActionsClient({
    ...config, GH_TOKEN_SECONDARY: 'secondary-pat',
  }, mockGitHub(async (_, init) => {
    deniedRequests++;
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secondary-pat');
    return Response.json({ message: 'contains private data' }, { status: 403 });
  }));
  await assert.rejects(() => denied.dispatchWorkflow('lirtual/mcp-workers', 'ci.yml', 'main', {}),
    (error: unknown) => error instanceof ActionError &&
      error.code === 'github_http_403' && !error.message.includes('private'));
  assert.equal(deniedRequests, 1);
});

test('repository_dispatch, cancellations and run metadata preserve existing semantics', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const client = new GitHubActionsClient(config, mockGitHub(async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.endsWith('/actions/runs/42')) {
      return Response.json({ id: 42, status: 'completed', conclusion: 'success',
        private_token: 'never-show' });
    }
    return new Response(null, { status: 202 });
  }));
  assert.deepEqual(await client.dispatchRepository('autoactions/tsrv', 'deploy', {}), { accepted: true });
  assert.equal((await client.cancelRun('autoactions/tsrv', 42)).completion_confirmed, false);
  assert.equal((await client.forceCancelRun('autoactions/tsrv', 42)).completion_confirmed, false);
  assert.equal(JSON.stringify(await client.getRun('autoactions/tsrv', 42)).includes('never-show'), false);
  assert.deepEqual(calls.map(c => c.method), ['POST', 'POST', 'POST', 'GET']);
});

test('bounded repository discovery refuses truncation and upstream failure', async () => {
  let actionCalls = 0;
  const tooMany = new GitHubActionsClient(config, (async (input) => {
    const url = String(input);
    if (url.includes('/user/repos?')) return Response.json(
      Array.from({ length: 25 }, (_, i) => ({ full_name: 'many/repo-' + i })));
    actionCalls++;
    return Response.json({});
  }) as typeof fetch);
  await assert.rejects(() => tooMany.getRun('many/repo-1', 42),
    { code: 'repository_discovery_limit' });
  assert.equal(actionCalls, 0);
  const invalid = new GitHubActionsClient(config, mockGitHub(async () => {
    throw Error('No action should happen');
  }, { 'primary-pat': ['bad/../repo'] }));
  await assert.rejects(() => invalid.listRepositories(), { code: 'invalid_repository' });
});

test('injected fetch is called without a class receiver (Workers compatibility)', async () => {
  const receiverCheckedFetch = function (this: unknown, input: RequestInfo | URL) {
    assert.equal(this, undefined);
    if (String(input).includes('/user/repos?')) {
      return Promise.resolve(Response.json([{ full_name: 'autoactions/tsrv' }]));
    }
    return Promise.resolve(Response.json({ total_count: 0, workflows: [] }));
  } as typeof fetch;
  const client = new GitHubActionsClient(config, receiverCheckedFetch);
  assert.deepEqual(await client.listWorkflows('autoactions/tsrv'), {
    total_count: 0, workflows: [],
  });
});
