import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import worker from '../src/index.ts';
import type { Env } from '../src/github.ts';

const env: Env = {
  MCP_ACCESS_TOKEN: 'synthetic-mcp-token',
  GITHUB_TOKEN: 'synthetic-github-token',
  GITHUB_REPOS: 'autoactions/tsrv,autoactions/tsvc',
};

test('real MCP protocol advertises all 10 tools and enforces the repository allowlist', async () => {
  const transport = new StreamableHTTPClientTransport(new URL('https://worker.example/mcp'), {
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return worker.fetch(request, env);
    },
    requestInit: { headers: { authorization: 'Bearer synthetic-mcp-token' } },
  });
  const client = new Client({ name: 'github-actions-acceptance', version: '0.1.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((x) => x.name);
    assert.equal(names.length, 10);
    for (const expected of [
      'repositories_list', 'workflows_list', 'runs_list', 'run_get',
      'run_jobs_list', 'run_artifacts_list', 'workflow_dispatch',
      'repository_dispatch', 'run_cancel', 'run_rerun',
    ]) assert.ok(names.includes(expected), expected);
    const result = await client.callTool({ name: 'repositories_list', arguments: {} });
    assert.match(JSON.stringify(result), /autoactions\/tsrv/);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-github-token|synthetic-mcp-token/);
    const denied = await client.callTool({ name: 'workflows_list', arguments: { repo: 'someone/else' } });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /repository_not_allowed/);
  } finally {
    await client.close();
  }
});

test('MCP endpoint fails closed for missing or wrong bearer and untrusted Origin', async () => {
  const request = (headers: Record<string, string>) => new Request('https://worker.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal((await worker.fetch(request({}), env)).status, 401);
  assert.equal((await worker.fetch(request({ authorization: 'Bearer wrong' }), env)).status, 401);
  assert.equal((await worker.fetch(request({ authorization: 'Bearer synthetic-mcp-token', origin: 'https://not-allowed.example' }), env)).status, 403);
  assert.equal((await worker.fetch(request({ authorization: 'Bearer synthetic-mcp-token' }), { ...env, GITHUB_TOKEN: '' })).status, 503);
});
