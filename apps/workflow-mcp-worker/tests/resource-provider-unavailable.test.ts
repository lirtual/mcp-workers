import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Env } from '../src/store.ts';

const hook = registerHooks({resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return {
    url: 'data:text/javascript,export class WorkflowEntrypoint { constructor(ctx,env){this.env=env;} }',
    shortCircuit: true,
  };
  return next(specifier, context);
}});
const {default: ownerWorker} = await import('../src/index.ts');
hook.deregister();

const OWNER = 'https://owner.example.org/mcp';
const TOKEN = 'disposable-portal-token-resource-block';
const GITHUB_TOKEN = 'fixture-token-must-not-leak';
const MIGRATIONS = ['0001_s1.sql', '0002_native_complete_seen.sql', '0003_s3_attempt_claim.sql', '0004_s3_callback_receipts.sql', '0005_github_workflow_check.sql', '0006_github_registered_action.sql', '0007_run_cancel.sql', '0008_grant_revocation.sql'];

const TSRV = {
  version: 1,
  name: 'Tsrv session',
  steps: [{id: 'boot', uses: 'tsrv.start', with: {subject: 'session'}}],
};
const TSRV_CAPABILITY = {
  version: 1,
  name: 'Tsrv via GitHub',
  steps: [{id: 'boot', uses: 'github.run', with: {capability: 'tsrv'}}],
};

function database(t: test.TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  for (const name of MIGRATIONS) sqlite.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  function prepare(sql: string) {
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) { args = values; return this; },
      async first() { return sqlite.prepare(sql).get(...(args as never[])) ?? null; },
      async all() { return {results: sqlite.prepare(sql).all(...(args as never[]))}; },
      async run() { return {meta: {changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes)}}; },
    };
  }
  const env = {
    MCP_ACCESS_TOKEN: TOKEN,
    WORKFLOW_EXECUTOR_GITHUB_TOKEN: GITHUB_TOKEN,
    GITHUB_EXECUTOR_REPOSITORY: 'lirtual/mcp-workers',
    GITHUB_EXECUTOR_REPOSITORY_ID: '1',
    GITHUB_EXECUTOR_REF: 'refs/heads/main',
    GITHUB_EXECUTOR_AUDIENCE: 'workflow-audience',
    DB: {prepare, async batch(items: {run: () => Promise<unknown>}[]) { return Promise.all(items.map(item => item.run())); }},
    WORKFLOW: {async create() {}, async get() { return {async status() { return {status: 'running'}; }}; }},
  } as unknown as Env;
  return {sqlite, env};
}

test('tsrv stays unavailable and validate or publish cannot invent Ready', async t => {
  const {sqlite, env} = database(t);
  const client = new Client({name: 'resource-provider-block', version: '0.1.0'});
  const transport = new StreamableHTTPClientTransport(new URL(OWNER), {
    requestInit: {headers: {authorization: 'Bearer ' + TOKEN}},
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
      ownerWorker.fetch(new Request(input, init), env)) as typeof fetch,
  });
  await client.connect(transport);
  t.after(() => client.close());
  const listed = await client.listTools();
  assert.ok(listed.tools.some(tool => tool.name === 'workflow_cancel'));
  async function call(name: string, args: Record<string, unknown>, error?: string) {
    const output = await client.callTool({name, arguments: args});
    const first = output.content[0];
    if (!first || first.type !== 'text') throw Error('unexpected_tool_content');
    assert.equal(first.text.includes(TOKEN), false);
    assert.equal(first.text.includes(GITHUB_TOKEN), false);
    const value = JSON.parse(first.text) as Record<string, any>;
    if (error) {
      assert.equal(output.isError, true);
      assert.equal(value.error, error);
    } else assert.notEqual(output.isError, true, name + ' ' + first.text);
    return value;
  }
  const counts = () => ({
    versions: Number(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_versions').get()?.n ?? 0),
    runs: Number(sqlite.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n ?? 0),
  });

  const overview = await call('workflow_capabilities', {});
  const tsrv = overview.capabilities.find((item: {id: string}) => item.id === 'action.tsrv');
  assert.equal(tsrv.status, 'unsupported');
  assert.equal('example' in tsrv, false);
  assert.equal(overview.connections.resource_provider.status, 'unavailable');
  assert.equal(overview.connections.github_executor.status, 'configured');
  assert.match(overview.connections.resource_provider.reason, /not Ready/);
  const detail = await call('workflow_capabilities', {id: 'action.tsrv'});
  assert.equal(detail.status, 'unsupported');
  assert.equal('example' in detail, false);
  assert.equal('completion' in detail, false);
  assert.match(detail.summary, /unavailable/);
  assert.match(detail.summary, /GitHub job result is not Ready/);
  const instructions = client.getInstructions() ?? '';
  assert.match(instructions, /tsrv resource actions are unavailable/);
  assert.match(instructions, /GitHub job result is not Ready/);

  const inline = await call('workflow_validate', {definition: JSON.stringify(TSRV)});
  assert.equal(inline.valid, false);
  assert.equal(inline.issues.length, 1);
  assert.equal(inline.issues[0].code, 'resource_provider_unavailable');
  assert.equal(inline.issues[0].path, '/steps/0/uses');
  assert.match(inline.issues[0].message, /not Ready/);
  const disguised = await call('workflow_validate', {definition: JSON.stringify(TSRV_CAPABILITY)});
  assert.equal(disguised.valid, false);
  assert.equal(disguised.issues[0].code, 'resource_provider_unavailable');
  assert.equal(disguised.issues[0].path, '/steps/0/with/capability');

  const registered = await call('workflow_capabilities', {id: 'action.github.registered'});
  assert.equal(registered.status, 'supported');
  assert.equal((await call('workflow_validate', {definition: JSON.stringify(registered.example)})).valid, true);
  const check = await call('workflow_capabilities', {id: 'action.github.run'});
  assert.equal((await call('workflow_validate', {definition: JSON.stringify(check.example)})).valid, true);

  assert.deepEqual(counts(), {versions: 0, runs: 0});
  const created = await call('workflow_create', {definition: JSON.stringify(TSRV)});
  const stored = await call('workflow_validate', {workflow_id: created.workflow_id, revision: 1});
  assert.equal(stored.valid, false);
  assert.equal(stored.issues[0].code, 'resource_provider_unavailable');
  await call('workflow_publish', {
    workflow_id: created.workflow_id,
    expected_revision: 1,
    approve_heavy_execution: true,
  }, 'resource_provider_unavailable');
  assert.deepEqual(counts(), {versions: 0, runs: 0});
  const after = await call('workflow_get', {workflow_id: created.workflow_id});
  assert.equal(after.published_version_id, null);
});
