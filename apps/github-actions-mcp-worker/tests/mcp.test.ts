import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import worker from '../src/index.ts';
import { buildMcpServer } from '../src/tools.ts';
import type { Env } from '../src/github.ts';

const env: Env = {
  MCP_ACCESS_TOKEN: 'synthetic-mcp-token',
  ACTIONS_GITHUB_DISPATCH_TOKENS: 'synthetic-github-token',
};

function githubFor(secondary = false): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.github.com/user/repos?')) {
      const auth = new Headers(init?.headers).get('authorization');
      return Response.json(auth === 'Bearer synthetic-github-token'
        ? [{ full_name: 'autoactions/tsrv' }, { full_name: 'autoactions/tsvc' }]
        : secondary ? [{ full_name: 'lirtual/mcp-workers' }] : []);
    }
    throw Error('Unexpected real GitHub API request');
  }) as typeof fetch;
}

async function connectedClient(settings: Env) {
  const handler = createMcpHandler(
    () => buildMcpServer(settings, githubFor(settings.ACTIONS_GITHUB_DISPATCH_TOKENS.includes('\n'))),
    { legacy: 'stateless' },
  );
  const transport = new StreamableHTTPClientTransport(new URL('https://worker.example/mcp'), {
    fetch: async (input, init) => handler.fetch(input instanceof Request
      ? input : new Request(input, init)),
  });
  const client = new Client({ name: 'github-actions-acceptance', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

test('real MCP protocol advertises eleven tools and rejects unauthorized repositories', async () => {
  const client = await connectedClient(env);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 11);
    for (const name of ['repositories_list', 'workflows_list', 'runs_list',
      'run_get', 'run_jobs_list', 'run_artifacts_list', 'workflow_dispatch',
      'repository_dispatch', 'run_cancel', 'run_force_cancel', 'run_rerun']) {
      assert.ok(tools.some(x => x.name === name), name);
    }
    const force = tools.find(tool => tool.name === 'run_force_cancel');
    assert.ok(force?.inputSchema.required?.includes('confirm'));
    const refused = await client.callTool({
      name: 'run_force_cancel',
      arguments: { repo: 'autoactions/tsrv', run_id: 2, confirm: false },
    });
    assert.equal(refused.isError, true);
    const found = await client.callTool({ name: 'repositories_list', arguments: {} });
    assert.ok(JSON.stringify(found).includes('autoactions/tsrv'));
    assert.ok(!JSON.stringify(found).includes('synthetic-github-token'));
    const denied = await client.callTool({
      name: 'workflows_list', arguments: { repo: 'someone/else' },
    });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /repository_not_accessible/);
  } finally {
    await client.close();
  }
});

test('MCP lists all PAT-accessible repositories without exposing PATs', async () => {
  const dual: Env = {
    ...env, ACTIONS_GITHUB_DISPATCH_TOKENS: env.ACTIONS_GITHUB_DISPATCH_TOKENS + '\nsynthetic-other-github-token',
  };
  const client = await connectedClient(dual);
  try {
    const result = await client.callTool({ name: 'repositories_list', arguments: {} });
    assert.equal(result.isError, undefined);
    const response = JSON.stringify(result);
    assert.ok(response.includes('autoactions/tsrv'));
    assert.ok(response.includes('lirtual/mcp-workers'));
    assert.doesNotMatch(response, /synthetic-other-github-token|synthetic-github-token/);
  } finally {
    await client.close();
  }
});

test('Worker MCP endpoint still fails closed without trusted owner authentication', async () => {
  const request = (headers: Record<string, string>) => new Request('https://worker.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal((await worker.fetch(request({}), env)).status, 401);
  assert.equal((await worker.fetch(request({ authorization: 'Bearer wrong' }), env)).status, 401);
  assert.equal((await worker.fetch(request({ authorization: 'Bearer synthetic-mcp-token', origin: 'https://not-allowed.example' }), env)).status, 403);
  assert.equal((await worker.fetch(request({ authorization: 'Bearer synthetic-mcp-token' }), { ...env, ACTIONS_GITHUB_DISPATCH_TOKENS: '' })).status, 503);
  assert.equal((await worker.fetch(request({ authorization: 'Bearer synthetic-mcp-token' }), {
    ...env, ACTIONS_GITHUB_DISPATCH_TOKENS: env.ACTIONS_GITHUB_DISPATCH_TOKENS + '\n' + env.ACTIONS_GITHUB_DISPATCH_TOKENS,
  })).status, 503);
});
