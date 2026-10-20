import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionError, assertRepo, configuredRepos, GitHubActionsClient, SessionDeckClient } from '../src/github.ts';
import type { Env } from '../src/github.ts';

const config: Env = {
  MCP_ACCESS_TOKEN: 'mcp-secret',
  GITHUB_TOKEN: 'github-secret',
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
  assert.deepEqual(requests[0]?.body, { ref: 'main', inputs: { access_profile: 'mini' } });
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

test('Session Deck hides sensitive locators and rejects targets not on allowlist', async () => {
  const requests: string[] = [];
  const fakeFetch = (async (url: string | URL | Request) => {
    requests.push(String(url));
    if (String(url).endsWith('/api/targets')) return Response.json({
      targets: [
        { id: 'tsrv/linux', repo: 'autoactions/tsrv', facts: [
          { label: 'Host', value: 'tsrv-linux', sensitive: false },
          { label: 'Password', value: 'hidden-value', sensitive: true },
        ] },
        { id: 'alien/target', repo: 'alien/repo', facts: [] },
      ],
    });
    if (String(url).endsWith('/api/targets/alien/target'))
      return Response.json({ id: 'alien/target', repo: 'alien/repo' });
    return Response.json({ id: 'tsrv/linux', repo: 'autoactions/tsrv', facts: [
      { label: 'Password', value: 'hidden-value', sensitive: true },
    ] });
  }) as typeof fetch;
  const deck = new SessionDeckClient({
    ...config, SESSION_DECK_URL: 'https://sd.example.com', SESSION_PASSWORD: 'deck-pass',
  }, configuredRepos(config.GITHUB_REPOS), fakeFetch);
  const listed = await deck.list();
  assert.equal(listed.targets.length, 1);
  assert.equal(listed.targets[0].facts[1].value, '[redacted]');
  assert.equal((await deck.get('tsrv/linux')).facts[0].value, '[redacted]');
  assert.equal((await deck.get('tsrv/linux', true)).facts[0].value, 'hidden-value');
  await assert.rejects(() => deck.get('alien/target'), { code: 'target_not_allowed' });
  assert.equal(requests.length, 4);
});

test('Session Deck checks target ownership before changing session state', async () => {
  const requests: Array<{ method: string, url: string, body?: string }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body?.toString() });
    return Response.json({ id: 'tsvc/service:chrome', repo: 'autoactions/tsvc', state: 'starting' });
  }) as typeof fetch;
  const deck = new SessionDeckClient({
    ...config, SESSION_DECK_URL: 'https://sd.example.com', SESSION_PASSWORD: 'deck-pass',
  }, configuredRepos(config.GITHUB_REPOS), fetcher);
  const value = await deck.change('tsvc/service:chrome', 'start', { service: 'chrome' }).catch((error) => error);
  assert.equal(value instanceof Error, true); // Target IDs cannot contain ':' or unvalidated characters.
  assert.equal(requests.length, 0);
  await deck.change('tsrv/linux', 'start', { session_profile: 'core' });
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.method, 'GET');
  assert.equal(requests[1]?.method, 'POST');
  assert.deepEqual(JSON.parse(requests[1]?.body ?? '{}'), { session_profile: 'core' });
});

test('Session Deck refuses plain HTTP and credentials in URLs', () => {
  for (const SESSION_DECK_URL of ['http://sd.example.com', 'https://user:pass@sd.example.com', 'https://sd.example.com/x']) {
    assert.throws(() => new SessionDeckClient({
      ...config, SESSION_DECK_URL, SESSION_PASSWORD: 'pass',
    }, configuredRepos(config.GITHUB_REPOS)), { code: 'invalid_session_deck_url' });
  }
});
