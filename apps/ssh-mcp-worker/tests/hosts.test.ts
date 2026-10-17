import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import worker from '../src/handler.ts';
import { getHost, listHosts } from '../src/hosts.ts';
import type { D1Database, D1Statement, Env } from '../src/types.ts';

const fixture = JSON.parse(await readFile(new URL('./fixtures/edge-ssh-host-v1.json', import.meta.url), 'utf8')) as {
  key: string; accountId: string; hostId: string; encryptedPayload: string;
  secondHostId: string; secondEncryptedPayload: string; changedEncryptedPayload: string;
  host: Record<string, unknown>; source: string;
};
const longCatalog = JSON.parse(await readFile(new URL('./fixtures/long-catalog-v1.json', import.meta.url), 'utf8')) as {
  source: string; key: string; accountId: string;
  rows: Array<{ id: string; account_id: string; encrypted_payload: string; updated_at: number }>;
};

class SyntheticD1 implements D1Database {
  readonly queries: string[] = [];
  reads = 0;
  accountId: string | null = fixture.accountId;
  workspaceRows = 1;
  rows = [{ id: fixture.hostId, account_id: fixture.accountId, encrypted_payload: fixture.encryptedPayload, updated_at: 10 }];

  constructor(rows?: SyntheticD1['rows']) {
    if (rows) this.rows = rows;
  }

  prepare(query: string): D1Statement {
    this.queries.push(query);
    return {
      bind: (...values) => {
        const bound = values;
        return {
          bind: () => { throw new Error('unexpected rebinding'); },
          all: async <T>() => {
            this.reads += 1;
            if (query.includes('workspace_state')) return {
              results: this.accountId ? Array.from({ length: this.workspaceRows }, () => ({ account_id: this.accountId! })) as T[] : [],
            };
            const account = bound[0];
            const cursor = query.includes('id >') ? bound[1] : undefined;
            const limit = Number(bound.at(-1));
            return { results: this.rows.filter(row => row.account_id === account && (!cursor || row.id > cursor)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit) as T[] };
          },
          first: async <T>() => {
            this.reads += 1;
            const row = this.rows.find(item => item.id === bound[0] && item.account_id === bound[1]);
            return row as T | undefined ?? null;
          },
        };
      },
      all: async () => ({ results: [] }),
      first: async () => null,
    };
  }
}

function environment(db = new SyntheticD1(), key = fixture.key, onDoCall: () => void = () => { throw new Error('unexpected DO call'); }): Env & { EDGE_SSH_DB: SyntheticD1 } {
  return {
    MCP_ACCESS_TOKEN: 'synthetic-mcp-token', ENCRYPTION_KEY: key, EDGE_SSH_DB: db,
    SSH_OPERATIONS: { getByName: () => { onDoCall(); throw new Error('unexpected DO call'); } } as unknown as Env['SSH_OPERATIONS'],
  };
}

test('reads the pinned upstream-generated AES-GCM v1 fixture and projects only host metadata', async () => {
  assert.match(fixture.source, /EdgeSSH@7a051e412d2cfa4ee52edec30e6ccefedb4e1c99/);
  const db = new SyntheticD1();
  const result = await getHost(environment(db), fixture.hostId);
  assert.deepEqual(result, {
    id: fixture.hostId, name: 'Synthetic fixture', group: 'Tests', host: 'fixture.example.test',
    port: 2222, username: 'fixture-user', authMethod: 'password', trustReady: true, readinessReason: 'ready',
  });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-password|synthetic-initial-command|encryptedPayload|ENCRYPTION_KEY|privateKey/);
});

test('the authenticated MCP boundary rejects commands over 16 KiB UTF-8 before D1 or DO access', async () => {
  const db = new SyntheticD1();
  let doCalls = 0;
  const env = environment(db, fixture.key, () => { doCalls += 1; });
  const response = await worker.fetch(new Request('https://worker.example/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer synthetic-mcp-token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 44, method: 'tools/call', params: {
      name: 'ssh_exec', arguments: { host_id: fixture.hostId, operation_id: '33333333-3333-4333-8333-333333333333', command: '😀'.repeat(4097),
      },
    } }),
  }), env);
  assert.equal(response.status, 200);
  const data = (await response.text()).split('\n').find(line => line.startsWith('data: '))?.slice(6);
  assert.ok(data);
  assert.match(data, /invalid_args/);
  assert.equal(db.reads, 0);
  assert.equal(doCalls, 0);
});

test('rejects wrong key, account AAD, host AAD, tampering, bad versions, missing host, and ambiguous workspace', async () => {
  await assert.rejects(getHost(environment(new SyntheticD1(), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='), fixture.hostId), { code: 'secret_mismatch' });

  const wrongAccount = new SyntheticD1();
  wrongAccount.accountId = '33333333-3333-4333-8333-333333333333';
  wrongAccount.rows[0]!.account_id = wrongAccount.accountId;
  await assert.rejects(getHost(environment(wrongAccount), fixture.hostId), { code: 'secret_mismatch' });

  const wrongHost = new SyntheticD1();
  wrongHost.rows[0]!.id = '44444444-4444-4444-8444-444444444444';
  await assert.rejects(getHost(environment(wrongHost), wrongHost.rows[0]!.id), { code: 'secret_mismatch' });

  const tampered = new SyntheticD1();
  tampered.rows[0]!.encrypted_payload = `${fixture.encryptedPayload.slice(0, -1)}A`;
  await assert.rejects(getHost(environment(tampered), fixture.hostId), { code: 'secret_mismatch' });

  const unsupported = new SyntheticD1();
  unsupported.rows[0]!.encrypted_payload = fixture.encryptedPayload.replace(/^v1\./, 'v2.');
  await assert.rejects(getHost(environment(unsupported), fixture.hostId), { code: 'unsupported_crypto_version' });

  const missing = new SyntheticD1();
  missing.rows = [];
  await assert.rejects(getHost(environment(missing), fixture.hostId), { code: 'host_not_found' });

  const noWorkspace = new SyntheticD1();
  noWorkspace.accountId = null;
  await assert.rejects(listHosts(environment(noWorkspace), {}), { message: 'host_catalog_unavailable' });
  const ambiguousWorkspace = new SyntheticD1();
  ambiguousWorkspace.workspaceRows = 2;
  await assert.rejects(listHosts(environment(ambiguousWorkspace), {}), { message: 'host_catalog_unavailable' });
});

test('paginates deterministically, reflects changed ciphertext without relying on updated_at, and issues SELECT-only SQL', async () => {
  const db = new SyntheticD1();
  const nextId = fixture.secondHostId;
  db.rows.push({ ...db.rows[0]!, id: nextId, encrypted_payload: fixture.secondEncryptedPayload });
  const first = await listHosts(environment(db), { limit: 1 });
  assert.equal(first.hosts.length, 1);
  assert.equal(first.nextCursor, first.hosts[0]!.id);
  const second = await listHosts(environment(db), { cursor: first.nextCursor!, limit: 1 });
  assert.deepEqual(second.hosts.map(host => host.id), [nextId]);
  db.rows = [];
  assert.deepEqual((await listHosts(environment(db), {})).hosts, []);
  db.rows = [{ ...db.rows[0]!, id: fixture.hostId, account_id: fixture.accountId, encrypted_payload: fixture.changedEncryptedPayload, updated_at: 10 }];
  assert.equal((await getHost(environment(db), fixture.hostId)).name, 'Changed synthetic fixture');
  assert.ok(db.queries.every(query => /^SELECT\b/i.test(query.trim())));
  assert.ok(db.queries.every(query => !/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(query)));
});

test('the real /mcp outer handler rejects missing/bad bearer and Origin before any D1 access', async () => {
  const db = new SyntheticD1();
  const env = environment(db);
  const rejectedHeaders: HeadersInit[] = [
    {},
    { authorization: 'Bearer wrong' },
    { authorization: 'Bearer synthetic-mcp-token', origin: 'https://untrusted.example' },
  ];
  for (const headers of rejectedHeaders) {
    const response = await worker.fetch(new Request('https://worker.example/mcp', { method: 'POST', headers, body: '{}' }), env);
    assert.ok(response.status === 401 || response.status === 403);
    assert.equal(db.reads, 0);
  }
  const outside = await worker.fetch(new Request('https://worker.example/debug', { headers: { authorization: 'Bearer synthetic-mcp-token' } }), env);
  assert.equal(outside.status, 404);
  assert.equal(db.reads, 0);

  const accepted = await worker.fetch(new Request('https://worker.example/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer synthetic-mcp-token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  }), env);
  assert.equal(accepted.status, 200);
  const eventStream = await accepted.text();
  const payload = eventStream.split('\n').find(line => line.startsWith('data: '))?.slice(6);
  assert.ok(payload, eventStream);
  const response = JSON.parse(payload) as { result?: { tools?: Array<{ name: string }> } };
  assert.deepEqual(response.result?.tools?.map(tool => tool.name), [
    'list_hosts', 'get_host', 'ssh_exec', 'get_operation_status', 'ssh_session_start', 'ssh_session_input', 'ssh_session_stop', 'ssh_session_output', 'ssh_session_status',
  ]);
  const callTool = async (id: number, name: string, args: Record<string, unknown>) => {
    const result = await worker.fetch(new Request('https://worker.example/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer synthetic-mcp-token',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    }), env);
    const data = (await result.text()).split('\n').find(line => line.startsWith('data: '))?.slice(6);
    assert.ok(data);
    return JSON.parse(data) as { result?: { content?: Array<{ text: string }> } };
  };
  const listResult = await callTool(2, 'list_hosts', { limit: 10 });
  const detailResult = await callTool(3, 'get_host', { host_id: fixture.hostId });
  const rendered = JSON.stringify([listResult, detailResult]);
  assert.match(rendered, /Synthetic fixture/);
  assert.doesNotMatch(rendered, /synthetic-password-do-not-use|synthetic-initial-command-do-not-run|privateKey/);
  assert.ok(db.reads >= 4, 'authenticated tool calls query workspace and host records');
});

test('the real /mcp list_hosts enforces the UTF-8 result cap and pages every long Unicode record once', async () => {
  assert.match(longCatalog.source, /EdgeSSH@7a051e412d2cfa4ee52edec30e6ccefedb4e1c99/);
  assert.equal(longCatalog.rows.length, 200);
  const db = new SyntheticD1(longCatalog.rows);
  const env = environment(db, longCatalog.key);
  const callTool = async (id: number, name: string, args: Record<string, unknown>) => {
    const response = await worker.fetch(new Request('https://worker.example/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer synthetic-mcp-token',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
    }), env);
    const eventStream = await response.text();
    assert.equal(response.status, 200);
    assert.ok(new TextEncoder().encode(eventStream).byteLength <= 64 * 1024, `MCP response was ${new TextEncoder().encode(eventStream).byteLength} bytes`);
    const data = eventStream.split('\n').find(line => line.startsWith('data: '))?.slice(6);
    assert.ok(data, eventStream.slice(0, 300));
    return JSON.parse(data) as { result?: { content?: Array<{ text: string }>; isError?: boolean } };
  };

  const discovered: string[] = [];
  let cursor: string | undefined;
  let requestId = 10;
  for (;;) {
    const reply = await callTool(requestId++, 'list_hosts', { ...(cursor ? { cursor } : {}), limit: 200 });
    const text = reply.result?.content?.[0]?.text;
    assert.ok(text, JSON.stringify(reply));
    assert.equal(reply.result?.isError, undefined);
    const page = JSON.parse(text) as { hosts: Array<{ id: string; name: string; group: string; username: string }>; nextCursor: string | null };
    assert.ok(page.hosts.length > 0);
    assert.ok(page.hosts.every(host => host.name === '主'.repeat(80) && host.group === '组'.repeat(40) && host.username === '用'.repeat(128)));
    discovered.push(...page.hosts.map(host => host.id));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  assert.deepEqual(discovered, longCatalog.rows.map(row => row.id));
  assert.equal(new Set(discovered).size, 200);
  assert.ok(db.queries.every(query => /^SELECT\b/i.test(query.trim())));

  const detail = await callTool(999, 'get_host', { host_id: longCatalog.rows[0]!.id });
  assert.ok(detail.result?.content?.[0]?.text);
  assert.equal(detail.result?.isError, undefined);
});
