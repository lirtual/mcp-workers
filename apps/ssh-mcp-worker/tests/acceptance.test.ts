import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import worker from '../src/handler.ts';
import { getHost, getSshHostCredentials, HostError } from '../src/hosts.ts';
import { resolvePublicAddress } from '../src/public-target.ts';
import type { D1Database, D1Statement, Env } from '../src/types.ts';

const fixture = JSON.parse(await readFile(new URL('./fixtures/edge-ssh-host-v1.json', import.meta.url), 'utf8')) as {
  key: string; accountId: string; hostId: string; encryptedPayload: string;
  changedEncryptedPayload: string; host: Record<string, unknown>; changedHost: { fingerprint: string };
};
const secretCanary = /synthetic-password-do-not-use|synthetic-initial-command-do-not-run|privateKey|ENCRYPTION_KEY|AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=/;
const toolNames = [
  'list_hosts', 'get_host', 'ssh_exec', 'file_list', 'file_read_text', 'file_write_text', 'file_move', 'file_delete', 'file_mkdir',
  'get_operation_status', 'ssh_session_start', 'ssh_session_send', 'ssh_session_stop', 'ssh_session_read', 'ssh_session_status',
] as const;
const specProperties: Record<(typeof toolNames)[number], string[]> = {
  list_hosts: ['cursor', 'limit'],
  get_host: ['host_id'],
  ssh_exec: ['host_id', 'command', 'operation_id', 'timeout_ms'],
  ssh_session_start: ['host_id', 'operation_id', 'term_type'],
  ssh_session_send: ['session_id', 'operation_id', 'input'],
  ssh_session_read: ['session_id', 'offset', 'limit'],
  ssh_session_status: ['session_id'],
  ssh_session_stop: ['session_id', 'operation_id'],
  file_list: ['host_id', 'path', 'timeout_ms'],
  file_read_text: ['host_id', 'path', 'timeout_ms'],
  file_write_text: ['host_id', 'path', 'text', 'overwrite', 'operation_id', 'timeout_ms'],
  file_move: ['host_id', 'old_path', 'new_path', 'overwrite', 'operation_id', 'timeout_ms'],
  file_delete: ['host_id', 'path', 'kind', 'confirm', 'recursive', 'operation_id', 'timeout_ms'],
  file_mkdir: ['host_id', 'path', 'operation_id', 'timeout_ms'],
  get_operation_status: ['operation_id'],
};

class SyntheticD1 implements D1Database {
  readonly queries: string[] = [];
  reads = 0;
  rows = [{ id: fixture.hostId, account_id: fixture.accountId, encrypted_payload: fixture.encryptedPayload, updated_at: 10 }];

  prepare(query: string): D1Statement {
    this.queries.push(query);
    return {
      bind: (...values) => ({
        bind: () => { throw new Error('unexpected rebinding'); },
        all: async <T>() => {
          this.reads += 1;
          if (query.includes('workspace_state')) return { results: [{ account_id: fixture.accountId }] as T[] };
          return { results: this.rows.filter(row => row.account_id === values[0]) as T[] };
        },
        first: async <T>() => {
          this.reads += 1;
          return (this.rows.find(row => row.id === values[0] && row.account_id === values[1]) as T | undefined) ?? null;
        },
      }),
      all: async () => ({ results: [] }),
      first: async () => null,
    };
  }
}

function environment(db: SyntheticD1 | undefined, key: string | undefined, onDoCall: () => void): Env {
  return {
    MCP_ACCESS_TOKEN: 'synthetic-mcp-token',
    ...(key === undefined ? {} : { ENCRYPTION_KEY: key }),
    ...(db === undefined ? {} : { EDGE_SSH_DB: db }),
    SSH_OPERATIONS: { getByName: () => { onDoCall(); throw new Error('unexpected DO call'); } } as unknown as Env['SSH_OPERATIONS'],
  };
}

async function post(env: Env, id: number, method: string, params: unknown, headers: HeadersInit = {}) {
  const response = await worker.fetch(new Request('https://worker.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  }), env);
  const text = await response.text();
  return { status: response.status, text };
}

function toolBody(text: string): { isError: boolean; value: Record<string, unknown> } {
  const data = text.split('\n').find(line => line.startsWith('data: '))?.slice(6);
  assert.ok(data, text.slice(0, 300));
  const envelope = JSON.parse(data) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  const body = envelope.result?.content?.[0]?.text;
  assert.equal(typeof body, 'string', data);
  return { isError: envelope.result?.isError === true, value: JSON.parse(body!) as Record<string, unknown> };
}

async function encrypt(hostId: string, payload: Record<string, unknown>): Promise<string> {
  const key = await crypto.subtle.importKey('raw', Buffer.from(fixture.key, 'base64'), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`edgessh:v1:${fixture.accountId}:${hostId}`),
  }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return `v1.${Buffer.from(iv).toString('base64')}.${Buffer.from(encrypted).toString('base64')}`;
}

test('a real MCP client discovers all 15 tools and their SPEC parameters', async () => {
  const db = new SyntheticD1();
  let doCalls = 0;
  const env = environment(db, fixture.key, () => { doCalls += 1; });
  const transport = new StreamableHTTPClientTransport(new URL('https://worker.example/mcp'), {
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      return worker.fetch(new Request(new URL(`${url.pathname}${url.search}`, 'https://worker.example/'), request), env);
    },
    requestInit: { headers: { authorization: 'Bearer synthetic-mcp-token' } },
  });
  const client = new Client({ name: 'ssh-mcp-acceptance', version: '0.1.0' });
  await client.connect(transport);
  try {
    const instructions = client.getInstructions() ?? '';
    assert.doesNotMatch(instructions, /redact|sanitiz(?:e|ed) (?:stdout|stderr|output|file)/i);
    assert.match(instructions, /Credentials are never returned/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), [...toolNames]);
    for (const tool of tools) {
      const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [...specProperties[tool.name as (typeof toolNames)[number]]].sort(), tool.name);
      for (const field of Object.keys(schema.properties ?? {})) {
        assert.equal(['password', 'privateKey', 'private_key', 'ENCRYPTION_KEY', 'initialCommand'].includes(field), false, field);
      }
      assert.doesNotMatch(JSON.stringify(tool), secretCanary);
    }
    const listed = await client.callTool({ name: 'list_hosts', arguments: { limit: 10 } });
    const fetched = await client.callTool({ name: 'get_host', arguments: { host_id: fixture.hostId } });
    const rendered = JSON.stringify([listed, fetched]);
    assert.match(rendered, /Synthetic fixture/);
    assert.doesNotMatch(rendered, secretCanary);
    assert.equal(doCalls, 0, 'host metadata must not open a Durable Object session');
    const rejected = await client.callTool({
      name: 'ssh_exec',
      arguments: { host_id: fixture.hostId, operation_id: '33333333-3333-4333-8333-333333333333', command: '😀'.repeat(4097) },
    });
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected), /invalid_args/);
    assert.doesNotMatch(JSON.stringify(rejected), secretCanary);
    assert.equal(doCalls, 0);
    assert.equal(db.reads, 4, 'list and get each read the workspace and one host page');
  } finally {
    await client.close();
  }
});

test('the external /mcp entry enforces 16 KiB commands and 4 KiB SFTP paths, including each error path', async () => {
  const db = new SyntheticD1();
  let doCalls: number = 0;
  const env = environment(db, fixture.key, () => { doCalls += 1; });
  const headers = { authorization: 'Bearer synthetic-mcp-token' };
  const operation = '33333333-3333-4333-8333-333333333333';
  const overPath = '😀'.repeat(1025);
  const exactPath = 'x'.repeat(4 * 1024);
  const rejected: Array<[string, Record<string, unknown>]> = [
    ['ssh_exec', { host_id: fixture.hostId, operation_id: operation, command: '😀'.repeat(4097) }],
    ['file_list', { host_id: fixture.hostId, path: overPath }],
    ['file_read_text', { host_id: fixture.hostId, path: overPath }],
    ['file_write_text', { host_id: fixture.hostId, operation_id: operation, path: overPath, text: 'x', overwrite: false }],
    ['file_move', { host_id: fixture.hostId, operation_id: operation, old_path: overPath, new_path: '/fixture/b', overwrite: false }],
    ['file_move', { host_id: fixture.hostId, operation_id: operation, old_path: '/fixture/a', new_path: overPath, overwrite: true }],
    ['file_delete', { host_id: fixture.hostId, operation_id: operation, path: overPath, kind: 'file', confirm: true }],
    ['file_mkdir', { host_id: fixture.hostId, operation_id: operation, path: overPath }],
    ['file_write_text', { host_id: fixture.hostId, operation_id: operation, path: '/fixture/out.txt', text: 'x' }],
    ['file_delete', { host_id: fixture.hostId, operation_id: operation, path: '/fixture/a', kind: 'file', confirm: true, recursive: true }],
  ];
  for (const [index, [name, args]] of rejected.entries()) {
    const response = await post(env, 70 + index, 'tools/call', { name, arguments: args }, headers);
    assert.equal(response.status, 200, name);
    const body = toolBody(response.text);
    assert.equal(body.isError, true, name);
    assert.equal(body.value.error, 'invalid_args', `${name} ${JSON.stringify(body.value)}`);
    assert.deepEqual(Object.keys(body.value), ['error'], name);
    assert.doesNotMatch(response.text, secretCanary);
  }
  assert.equal(db.reads, 0);
  assert.equal(doCalls, 0);
  const admitted: Array<[string, Record<string, unknown>]> = [
    ['ssh_exec', { host_id: fixture.hostId, operation_id: operation, command: 'x'.repeat(16 * 1024) }],
    ['file_list', { host_id: fixture.hostId, path: exactPath }],
    ['file_read_text', { host_id: fixture.hostId, path: exactPath }],
    ['file_write_text', { host_id: fixture.hostId, operation_id: operation, path: exactPath, text: 'x', overwrite: false }],
    ['file_move', { host_id: fixture.hostId, operation_id: operation, old_path: exactPath, new_path: '/fixture/b', overwrite: false }],
    ['file_move', { host_id: fixture.hostId, operation_id: operation, old_path: '/fixture/a', new_path: exactPath, overwrite: false }],
    ['file_delete', { host_id: fixture.hostId, operation_id: operation, path: exactPath, kind: 'file', confirm: true }],
    ['file_mkdir', { host_id: fixture.hostId, operation_id: operation, path: exactPath }],
  ];
  for (const [index, [name, args]] of admitted.entries()) {
    const callsBefore: number = doCalls;
    const response = await post(env, 90 + index, 'tools/call', { name, arguments: args }, headers);
    const body = toolBody(response.text);
    assert.equal(body.value.error, 'receipt_store_unavailable', `${name} passed the byte gate and reached the DO stub`);
    assert.equal(doCalls, callsBefore + 1, name);
    assert.doesNotMatch(response.text, secretCanary);
  }
});

test('auth, bearer rotation, Origin, and missing key or D1 fail closed without secrets', async () => {
  const db = new SyntheticD1();
  let doCalls = 0;
  const env = environment(db, fixture.key, () => { doCalls += 1; });
  const denied: Array<[HeadersInit, number, string]> = [
    [{}, 401, 'unauthorized'],
    [{ authorization: 'Bearer wrong' }, 401, 'unauthorized'],
    [{ authorization: 'Bearer synthetic-mcp-token', origin: 'https://untrusted.example' }, 403, 'invalid_origin'],
  ];
  for (const [headers, status, code] of denied) {
    const response = await worker.fetch(new Request('https://worker.example/mcp', {
      method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }), env);
    assert.equal(response.status, status);
    const body = await response.json() as { error?: string; message?: string };
    assert.equal(body.error, code);
    assert.equal(typeof body.message, 'string');
    assert.doesNotMatch(JSON.stringify(body), secretCanary);
  }
  assert.equal(db.reads, 0);
  assert.equal(doCalls, 0);

  const rotated = environment(db, fixture.key, () => { doCalls += 1; });
  rotated.MCP_ACCESS_TOKEN = 'rotated-mcp-bearer';
  const stale = await worker.fetch(new Request('https://worker.example/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer synthetic-mcp-token', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ssh_session_stop', arguments: {
      session_id: '33333333-3333-4333-8333-333333333333', operation_id: '44444444-4444-4444-8444-444444444444',
    } } }),
  }), rotated);
  assert.equal(stale.status, 401);
  assert.equal((await stale.json() as { error?: string }).error, 'unauthorized');
  const fresh = await post(rotated, 3, 'tools/call', { name: 'list_hosts', arguments: { limit: 1 } }, { authorization: 'Bearer rotated-mcp-bearer' });
  assert.equal(fresh.status, 200);
  assert.equal(toolBody(fresh.text).isError, false);
  assert.doesNotMatch(`${stale.status} ${fresh.text}`, /stopped|killed|reaped|redact/i);
  assert.equal(doCalls, 0);

  const missingConfig = environment(db, fixture.key, () => { doCalls += 1; });
  missingConfig.MCP_ACCESS_TOKEN = undefined;
  const misconfigured = await worker.fetch(new Request('https://worker.example/mcp', { method: 'POST', body: '{}' }), missingConfig);
  assert.equal(misconfigured.status, 503);
  assert.equal((await misconfigured.json() as { error?: string }).error, 'auth_misconfigured');

  for (const broken of [environment(db, undefined, () => { doCalls += 1; }), environment(undefined, fixture.key, () => { doCalls += 1; })]) {
    const response = await post(broken, 4, 'tools/call', { name: 'list_hosts', arguments: {} }, { authorization: 'Bearer synthetic-mcp-token' });
    const body = toolBody(response.text);
    assert.equal(body.value.error, 'host_catalog_unavailable');
    assert.doesNotMatch(response.text, secretCanary);
  }
  assert.equal(doCalls, 0);
});

test('fingerprint unknown fails closed and a changed pin is not treated as the previous pin', async () => {
  const unknownId = '55555555-5555-4555-8555-555555555555';
  const db = new SyntheticD1();
  db.rows.push({
    id: unknownId, account_id: fixture.accountId, updated_at: 10,
    encrypted_payload: await encrypt(unknownId, { ...fixture.host, fingerprint: '' }),
  });
  db.rows[0] = { ...db.rows[0]!, encrypted_payload: fixture.changedEncryptedPayload };
  const env = environment(db, fixture.key, () => { throw new Error('unexpected DO call'); });
  const unknown = await getHost(env, unknownId);
  assert.equal(unknown.trustReady, false);
  assert.equal(unknown.readinessReason, 'host_untrusted');
  assert.doesNotMatch(JSON.stringify(unknown), secretCanary);
  await assert.rejects(getSshHostCredentials(env, unknownId), (error: unknown) => error instanceof HostError && error.code === 'host_untrusted');
  const changed = await getHost(env, fixture.hostId);
  assert.equal(changed.trustReady, true);
  assert.doesNotMatch(JSON.stringify(changed), secretCanary);
  assert.doesNotMatch(JSON.stringify(changed), /SHA256:/);
  const credentials = await getSshHostCredentials(env, fixture.hostId);
  assert.equal(credentials.fingerprint, fixture.changedHost.fingerprint);
  assert.notEqual(credentials.fingerprint, fixture.host.fingerprint);
  assert.equal(JSON.stringify(changed).includes(String(credentials.password)), false);
});

test('one DNS lookup rejects a rebinding answer set and does not query again for that admission', async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  const answerFor = (type: number): Array<{ type: number; data: string }> => type === 1
    ? [{ type: 1, data: '8.8.8.8' }, { type: 1, data: '10.1.2.3' }]
    : [{ type: 28, data: '2001:4860:4860::8888' }];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'cloudflare-dns.com');
    const type = url.searchParams.get('type') ?? '';
    calls.push(`${url.searchParams.get('name')}:${type}`);
    if (url.searchParams.get('name') === 'xn--r8jz45g.xn--zckzah') return Response.json({ Answer: [{ type: 1, data: '8.8.8.8' }] });
    return Response.json({ Answer: answerFor(Number(type)) });
  };
  try {
    await assert.rejects(resolvePublicAddress('rebind.example.test'), (error: unknown) => error instanceof HostError && error.code === 'invalid_target');
    assert.deepEqual(calls, ['rebind.example.test:1', 'rebind.example.test:28']);
    calls.length = 0;
    assert.equal(await resolvePublicAddress('例え.テスト'), '8.8.8.8');
    assert.deepEqual(calls, ['xn--r8jz45g.xn--zckzah:1', 'xn--r8jz45g.xn--zckzah:28']);
  } finally {
    globalThis.fetch = original;
  }
  await assert.rejects(resolvePublicAddress('10.1.2.3'), (error: unknown) => error instanceof HostError && error.code === 'invalid_target');
  await assert.rejects(resolvePublicAddress('169.254.169.254'), (error: unknown) => error instanceof HostError && error.code === 'invalid_target');
});

test('D1 stays SELECT-only, quotas stay at the spec defaults, and secrets are not logged', async () => {
  const db = new SyntheticD1();
  const env = environment(db, fixture.key, () => { throw new Error('unexpected DO call'); });
  await getHost(env, fixture.hostId);
  assert.ok(db.queries.length > 0);
  assert.ok(db.queries.every(query => /^\s*SELECT\b/i.test(query)));
  assert.ok(db.queries.every(query => !/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|ATTACH)\b/i.test(query)));
  const sources = await Promise.all(['hosts.ts', 'handler.ts', 'tools.ts', 'operations.ts', 'public-target.ts', 'index.ts'].map(async name => ({
    name, text: await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8'),
  })));
  const hosts = sources.find(source => source.name === 'hosts.ts')!.text;
  const sqlLiterals = [...hosts.matchAll(/'([^']*)'/g)].map(match => match[1] ?? '').filter(literal => /\b(SELECT|INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|ATTACH)\b/i.test(literal));
  assert.ok(sqlLiterals.length >= 4);
  assert.ok(sqlLiterals.every(literal => /^\s*SELECT\b/i.test(literal)), sqlLiterals.join('\n'));
  assert.equal(sources.filter(source => source.text.includes('EDGE_SSH_DB')).map(source => source.name).join(','), 'hosts.ts');
  assert.equal(sources.some(source => /\bconsole\./.test(source.text)), false);
  const operations = sources.find(source => source.name === 'operations.ts')!.text;
  assert.match(operations, /const HOST_CONNECTION_LIMIT = 2;/);
  assert.match(operations, /const TOTAL_CONNECTION_LIMIT = 4;/);
  assert.match(operations, /const SESSION_IDLE_MS = 10 \* 60 \* 1000;/);
  assert.match(operations, /const SESSION_MAX_AGE_MS = 60 \* 60 \* 1000;/);
  const sftp = operations.slice(operations.indexOf('async function runBoundedSftp'), operations.indexOf('export class SshOperationsDO'));
  assert.ok(sftp.indexOf('const deadline = Date.now() + request.timeoutMs') < sftp.indexOf('resolveTarget(saved.host, controller.signal)'));
  assert.match(sftp, /hostname: checkedIp/);
  assert.equal(sftp.includes('hostname: saved.host'), false);
  const record = JSON.parse(await readFile(new URL('../acceptance-record.json', import.meta.url), 'utf8')) as {
    commands: string[]; runtime: { wrangler: string; workerd: string }; ci: { workflow: string; appCheck: string };
  };
  for (const command of ['pnpm --filter ssh-mcp-worker typecheck', 'pnpm --filter ssh-mcp-worker test', 'pnpm --filter ssh-mcp-worker test:g0', 'pnpm --filter ssh-mcp-worker test:exec', 'node --test scripts/select-affected-apps.test.mjs']) {
    assert.ok(record.commands.includes(command), command);
  }
  const workflow = await readFile(new URL(`../../../${record.ci.workflow}`, import.meta.url), 'utf8');
  assert.match(workflow, /pnpm --filter "\$app" check/);
  if (workflow.includes('name: Public source checks')) {
    assert.match(workflow, /ssh-mcp-worker/);
    assert.doesNotMatch(workflow, /workflow_dispatch|pull_request_target|secrets\./);
  } else {
    assert.match(workflow, /node scripts\/select-affected-apps\.mjs/);
    assert.equal(workflow.includes('- ssh-mcp-worker'), true);
  }
  const lockfile = await readFile(new URL('../../../pnpm-lock.yaml', import.meta.url), 'utf8');
  const pinned = lockfile.split(`wrangler@${record.runtime.wrangler}(@cloudflare/workers-types@`)[1] ?? '';
  assert.match(pinned.slice(0, 800), new RegExp(`workerd: ${record.runtime.workerd}`));
  const workerConfig = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const config = JSON.parse(workerConfig);
  assert.equal(config.observability.enabled, true);
  assert.equal(config.observability.logs?.invocation_logs, true);
  assert.equal(config.d1_databases, undefined);
  assert.equal(config.vars?.MCP_BROKER_FULL_ACCESS, undefined);
  assert.deepEqual(config.services, [{
    binding: 'EDGE_SSH_BROKER', service: 'edgessh', entrypoint: 'HostBrokerEntrypoint',
  }]);
  assert.deepEqual(config.secrets.required, ['MCP_ACCESS_TOKEN', 'MCP_BROKER_TOKEN']);
});
