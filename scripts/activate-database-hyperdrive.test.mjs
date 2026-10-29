import test from 'node:test';
import assert from 'node:assert/strict';
import { activateDatabaseHyperdrive } from './activate-database-hyperdrive.mjs';

const configId = '12345678-1234-1234-1234-123456789abc';
const databaseId = 'cbfe6a05-4979-4e6a-9cc2-4f6468586e4a';
const caId = 'abcd1234-0000-1111-2222-123456789abc';
const binding = 'HYPERDRIVE_TEST';
const manifest = [{
  binding, id: configId, dialect: 'mysql', origin_host: 'mysql.example.net',
  origin_port: 3306, origin_database: 'approved', origin_user: 'test', ca_certificate_id: caId
}];
const source = { name: 'database-mcp-worker', main: 'src/index.ts',
  d1_databases: [{ binding: 'DB', database_name: 'database-mcp-registry', database_id: databaseId }],
  hyperdrive: [{ binding, id: configId }] };
const config = { id: configId, mtls: { sslmode: 'VERIFY_IDENTITY', ca_certificate_id: caId },
  caching: { disabled: true },
  origin: { scheme: 'mysql', host: 'mysql.example.net', port: 3306,
    database: 'approved', user: 'test' } };
const good = {
  connectionId: 'test_mysql', expectedRevision: '1', accountId: 'a'.repeat(32),
  token: 'cloudflare-secret', portalToken: 'portal-secret', actor: 'lirtual',
  ref: 'refs/heads/main', sourceSha: 'b'.repeat(40), source, manifest
};
function fixture({ wrongCA = false, healthOk = true, differentBinding = false, lostActivationAck = false, lostBeforeWrite = false, lostDisableAck = false, disableRejected = false, externalDisableOnHealth = false } = {}) {
  const row = { id: 'test_mysql', dialect: 'mysql', transport: 'hyperdrive',
    status: 'disabled', revision: 1, config_id: configId, binding_name: binding };
  const calls = [];
  const response = result => ({ ok: true, json: async () => ({ success: true, result }) });
  async function request(url, init) {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (url.includes('/hyperdrive/configs/')) return response({
      ...config, mtls: { ...config.mtls, ...(wrongCA ? { ca_certificate_id: 'different-ca' } : {}) }
    });
    if (url.includes('/workers/scripts/database-mcp-worker/settings')) return response({
      bindings: [
        { type: 'hyperdrive', name: binding, id: differentBinding ? 'different-config' : configId },
        { type: 'd1', name: 'DB', id: databaseId },
        { type: 'secret_text', name: 'MCP_ACCESS_TOKEN' }
      ]
    });
    if (url.includes('/d1/database/')) {
      const sql = init.body && JSON.parse(init.body);
      if (sql.sql.includes('FROM d1_migrations')) return response([{
        success: true, results: [{ n: 1 }]
      }]);
      if (sql.sql.startsWith('SELECT id,')) return response([{
        success: true, results: [{ ...row }]
      }]);
      if (sql.sql.startsWith('SELECT status')) return response([{
        success: true, results: [{ ...row }]
      }]);
      if (sql.sql.startsWith('UPDATE database_connections')) {
        if (lostBeforeWrite && sql.sql.includes("SET status='active'")) throw Error('simulated network outage');
        if (disableRejected && sql.sql.includes("SET status='disabled'")) return response([{ success: true, meta: { changes: 0 } }]);
        const enabling = sql.sql.includes("SET status='active'");
        const expected = Number(sql.params[2]);
        if (row.revision === expected && row.status === (enabling ? 'disabled' : 'active')) {
          row.status = enabling ? 'active' : 'disabled';
          row.revision++;
          if (enabling && lostActivationAck) throw Error('simulated lost commit acknowledgement');
          if (!enabling && lostDisableAck) throw Error('simulated lost disable acknowledgement');
          return response([{ success: true, meta: { changes: 1 } }]);
        }
        return response([{ success: true, meta: { changes: 0 } }]);
      }
      throw Error('Unexpected D1 query');
    }
    if (url.endsWith('/mcp')) {
      if (externalDisableOnHealth) { row.status = 'disabled'; row.revision++; }
      return {
      ok: true, headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({
        jsonrpc: '2.0', id: 1, result: { structuredContent: {
          connection: 'test_mysql', dialect: 'mysql', transport: 'hyperdrive', ok: healthOk
        }}
      })
    };
    }
    throw Error('Unexpected remote request: ' + url);
  }
  return { request, row, calls };
}

test('cannot target the deleted legacy D1 or an unreviewed registry', async () => {
  for (const old of [
    { database_name: 'database-mcp-db', database_id: '8853a6ac-beaa-45aa-bdb2-0867e6f3df6d' },
    { database_name: 'database-mcp-registry', database_id: '99999999-9999-4999-8999-999999999999' },
    { database_name: 'unapproved-registry', database_id: databaseId }
  ]) {
    const f = fixture();
    const badSource = { ...source, d1_databases: [{ binding: 'DB', ...old }] };
    await assert.rejects(activateDatabaseHyperdrive({ ...good, source: badSource, request: f.request }),
      /reviewed Worker\/D1 source is missing/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.row.status, 'disabled');
  }
});

test('protected activation checks binding, CA and CAS before live MCP health', async () => {
  const f = fixture();
  assert.deepEqual(await activateDatabaseHyperdrive({ ...good, request: f.request }), {
    activated: true, connectionId: 'test_mysql', revision: 2
  });
  assert.equal(f.row.status, 'active');
  assert.equal(f.row.revision, 2);
  assert.equal(f.calls.filter(x => x.url.endsWith('/mcp')).length, 1);
});
test('invalid CA or deployed Binding cannot activate or mutate D1', async () => {
  for (const opts of [{ wrongCA: true }, { differentBinding: true }]) {
    const f = fixture(opts);
    await assert.rejects(activateDatabaseHyperdrive({ ...good, request: f.request }),
      /verification failed|activation blocked/);
    assert.equal(f.row.status, 'disabled');
    assert.equal(f.calls.some(x => x.method === 'POST' && x.body?.sql?.startsWith('UPDATE')), false);
  }
});
test('failed post-activation MCP health CAS-disables the connection', async () => {
  const f = fixture({ healthOk: false });
  await assert.rejects(activateDatabaseHyperdrive({ ...good, request: f.request }), /CAS-disabled/);
  assert.equal(f.row.status, 'disabled');
  assert.equal(f.row.revision, 3);
});
test('rejects unauthorized actor, ref, stale/non-numeric revision before network', async () => {
  for (const bad of [
    { actor: 'not-owner' }, { ref: 'refs/heads/development' },
    { expectedRevision: '1 OR 1=1' }, { connectionId: '../legacy' },
    { token: undefined }
  ]) {
    const f = fixture();
    await assert.rejects(activateDatabaseHyperdrive({ ...good, ...bad, request: f.request }), /blocked/);
    assert.equal(f.calls.length, 0);
  }
});

test('lost acknowledgment after successful D1 CAS is recovered and disabled before MCP health', async () => {
  const f = fixture({ lostActivationAck: true });
  await assert.rejects(activateDatabaseHyperdrive({ ...good, request: f.request }),
    /ambiguous D1 write; connection confirmed disabled/);
  assert.equal(f.row.status, 'disabled');
  assert.equal(f.row.revision, 3);
  assert.equal(f.calls.filter(x => x.url.endsWith('/mcp')).length, 0);
});

test('D1 outage before write leaves connection disabled, with no MCP health', async () => {
  const f = fixture({ lostBeforeWrite: true });
  await assert.rejects(activateDatabaseHyperdrive({ ...good, request: f.request }),
    /ambiguous D1 write; connection confirmed disabled/);
  assert.equal(f.row.status, 'disabled');
  assert.equal(f.row.revision, 1);
  assert.equal(f.calls.filter(x => x.url.endsWith('/mcp')).length, 0);
});

test('lost compensation acknowledgement is independently confirmed disabled', async () => {
  const f = fixture({ healthOk: false, lostDisableAck: true });
  await assert.rejects(activateDatabaseHyperdrive({ ...good, request: f.request }), /CAS-disabled/);
  assert.equal(f.row.status, 'disabled');
  assert.equal(f.row.revision, 3);
});
test('rejected compensation never claims a successful disable', async () => {
  const f = fixture({ healthOk: false, disableRejected: true });
  await assert.rejects(activateDatabaseHyperdrive({ ...good, request: f.request }),
    /disabled state unconfirmed; manual intervention required/);
  assert.equal(f.row.status, 'active');
  assert.equal(f.row.revision, 2);
});
test('concurrent external disable cannot be reported as successful activation', async () => {
  const f = fixture({ externalDisableOnHealth: true });
  await assert.rejects(activateDatabaseHyperdrive({ ...good, request: f.request }), /CAS-disabled/);
  assert.equal(f.row.status, 'disabled');
});
