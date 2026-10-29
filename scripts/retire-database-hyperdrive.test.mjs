import test from 'node:test';
import assert from 'node:assert/strict';
import { retireDatabaseHyperdrive } from './retire-database-hyperdrive.mjs';

const registry = 'cbfe6a05-4979-4e6a-9cc2-4f6468586e4a';
const configId = '31fc05c77ac042ff927a6d3cbf5bbb7d';
const binding = 'HYPERDRIVE_AIVEN_MYSQL';
const source = { name: 'database-mcp-worker', main: 'src/index.ts',
  d1_databases: [{ binding: 'DB', database_name: 'database-mcp-registry', database_id: registry }],
  hyperdrive: [] };
const inputs = {
  connectionId: 'retire_test', expectedRevision: '4', actor: 'lirtual',
  ref: 'refs/heads/main', sourceSha: 'a'.repeat(40), accountId: 'b'.repeat(32),
  token: 'synthetic-test-only', source, manifest: []
};
function fixture({ active = false, bound = false, lostAck = false, stale = false, shared = false,
  splitTraffic = false } = {}) {
  const state = {
    record: { id: 'retire_test', dialect: 'mysql', transport: 'hyperdrive',
      status: active ? 'active' : 'disabled', revision: stale ? 5 : 4,
      config_id: configId, binding_name: binding },
    retired: false, writes: 0
  };
  const calls = [];
  async function request(url, init) {
    calls.push({ url, method: init.method });
    const response = result => ({ ok: true, json: async () => ({ success: true, result }) });
    if(url.endsWith('/versions?deployable=true')) return response({items:[{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}]});
    if(url.endsWith('/versions/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')) return response({id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',resources:{bindings:[]}});
    if (url.endsWith('/deployments')) return response({ deployments: [{ versions: splitTraffic
      ? [{ percentage: 50 }, { percentage: 50 }] : [{ percentage: 100 }] }] });
    if (url.endsWith('/settings')) return response({ bindings: [
      { type: 'd1', name: 'DB', id: registry },
      ...(bound ? [{ type: 'hyperdrive', name: binding, id: configId }] : [])
    ] });
    if (url.includes('/d1/database/') && url.endsWith('/query')) {
      const { sql, params } = JSON.parse(init.body);
      if (sql.startsWith('SELECT id,') && sql.includes('FROM database_connections WHERE id=?')) {
        return response([{ success: true, results: state.record ? [state.record] : [] }]);
      }
      if (sql.startsWith('SELECT COUNT')) return response([{ success: true,
        results: [{ n: shared ? 1 : 0 }] }]);
      if (sql.includes('FROM retired_connection_ids')) return response([{ success: true,
        results: state.retired ? [{ id: 'retire_test' }] : [] }]);
      if (sql.startsWith('DELETE')) {
        state.writes++;
        if (!state.record || state.record.status !== 'disabled' ||
            state.record.revision !== Number(params[1])) return response([{ success: true, meta: { changes: 0 } }]);
        state.record = null;
        state.retired = true;
        if (lostAck) throw Error('simulated lost ack');
        return response([{ success: true, meta: { changes: 1 } }]);
      }
    }
    throw Error('unexpected synthetic request');
  }
  return { state, calls, request };
}

test('retire disabled unbound D1 identity after source and deployed readback', async () => {
  const f = fixture();
  assert.deepEqual(await retireDatabaseHyperdrive({ ...inputs, request: f.request }),
    { retired: true, connectionId: 'retire_test' });
  assert.equal(f.state.record, null);
  assert.equal(f.state.retired, true);
  assert.equal(f.state.writes, 1);
  assert.equal(f.calls.some(c => c.url.includes('hyperdrive/configs')), false);
});

test('no write when record active, stale, bound, shared, or production split', async () => {
  for (const option of [{ active: true }, { stale: true }, { bound: true },
    { shared: true }, { splitTraffic: true }]) {
    const f = fixture(option);
    await assert.rejects(retireDatabaseHyperdrive({ ...inputs, request: f.request }), /retirement blocked/);
    assert.equal(f.state.writes, 0);
  }
});
test('retirement rejects source that still lists Hyperdrive binding', async () => {
  const f = fixture();
  const oldSource = { ...source, hyperdrive: [{ binding, id: configId }] };
  const oldManifest = [{ binding, id: configId, dialect: 'mysql' }];
  await assert.rejects(retireDatabaseHyperdrive({ ...inputs, source: oldSource,
    manifest: oldManifest, request: f.request }), /binding has not been removed/);
  assert.equal(f.state.writes, 0);
});
test('unauthorized owner or old D1 never reaches cloud', async () => {
  for (const changes of [{ actor: 'other' }, { expectedRevision: '0' },
    { source: { ...source, d1_databases: [{ binding: 'DB', database_id: 'old' }] } }]) {
    const f = fixture();
    await assert.rejects(retireDatabaseHyperdrive({ ...inputs, ...changes, request: f.request }),
      /retirement blocked/);
    assert.equal(f.calls.length, 0);
  }
});
test('lost delete acknowledgment is confirmed by independent D1 readback, never retried', async () => {
  const f = fixture({ lostAck: true });
  assert.deepEqual(await retireDatabaseHyperdrive({ ...inputs, request: f.request }),
    { retired: true, connectionId: 'retire_test' });
  assert.equal(f.state.writes, 1);
});

// Diagnostic must identify the failing remote operation without reflecting
// upstream response bodies or credentials in the error string.
test('retirement rejects Cloudflare D1 access failure with bounded stage label', async () => {
  const f = fixture();
  const request = async (url, init) => {
    if (url.includes('/d1/database/') && url.endsWith('/query')) {
      return { ok: false, status: 403, text: async () => 'private-database-credential-must-not-appear' };
    }
    return f.request(url, init);
  };
  await assert.rejects(retireDatabaseHyperdrive({ ...inputs, request }), error => {
    assert.match(error.message, /d1_query \(HTTP 403\)/);
    assert.doesNotMatch(error.message, /private-database-credential/);
    return true;
  });
});

test('retained rollback version blocks tombstone before D1 deletion',async()=>{
  const f=fixture();
  const request=async(url,init)=>{
    if(url.endsWith('/versions?deployable=true')) return {ok:true,json:async()=>({success:true,result:{items:[{id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}]}})};
    if(url.endsWith('/versions/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')) return {ok:true,json:async()=>({success:true,result:{id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',resources:{bindings:[{type:'hyperdrive',name:binding,id:configId}]}}})};
    return f.request(url,init);
  };
  await assert.rejects(retireDatabaseHyperdrive({...inputs,request}),/rollback.*reference/);
  assert.equal(f.state.writes,0);
});
