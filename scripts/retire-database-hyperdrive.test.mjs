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
  splitTraffic = false, inFlight = false, unknownActive = false, currentDrift = false,
  otherWorkerCurrentBound = false, otherWorkerRollbackBound = false,
  otherWorkerInventoryUnknown = false, otherWorkerVersionDrift = false,
  workerInventoryDrift = false } = {}) {
  const state = {
    record: { id: 'retire_test', dialect: 'mysql', transport: 'hyperdrive',
      status: active ? 'active' : 'disabled', revision: stale ? 5 : 4,
      config_id: configId, binding_name: binding, in_flight_count: inFlight ? 1 : 0 },
    retired: false, writes: 0
  };
  const calls = []; let otherVersionReads = 0; let workerInventoryReads = 0;
  async function request(url, init) {
    calls.push({ url, method: init.method });
    const response = result => ({ ok: true, json: async () => ({ success: true, result }) });
    if (url.endsWith('/workers/scripts')) {
      workerInventoryReads++;
      return response([{ id: 'database-mcp-worker' }, { id: 'other-worker' },
        ...(workerInventoryDrift && workerInventoryReads > 1 ? [{ id: 'unexpected-worker' }] : [])]);
    }
    if (url.includes('/workers/scripts/other-worker/')) {
      if (otherWorkerInventoryUnknown) throw Error('synthetic unreadable other worker');
      if (url.endsWith('/settings')) return response({ bindings: otherWorkerCurrentBound
        ? [{ type: 'hyperdrive', name: binding, id: configId }] : [] });
      if (url.endsWith('/deployments')) return response({ deployments: [{ versions: [
        { version_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', percentage: 100 }
      ] }] });
      if (url.endsWith('/versions?deployable=true')) {
        otherVersionReads++;
        return response({ items: [{ id: 'dddddddd-dddd-dddd-dddd-dddddddddddd' },
          ...(otherWorkerVersionDrift && otherVersionReads > 1
            ? [{ id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' }] : [])] });
      }
      if (url.endsWith('/versions/dddddddd-dddd-dddd-dddd-dddddddddddd'))
        return response({ id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
          resources: { bindings: otherWorkerRollbackBound
            ? [{ type: 'hyperdrive', name: binding, id: configId }] : [] } });
    }
    if(url.endsWith('/versions?deployable=true')) return response({items:[{id:unknownActive?'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb':'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}]});
    if(url.endsWith('/versions/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')) return response({id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',resources:{bindings:currentDrift?[{type:'hyperdrive',name:'HYPERDRIVE_UNREVIEWED',id:'cccccccccccccccccccccccccccccccc'}]:[{type:'d1',name:'DB',database_id:registry}]}});
    if (url.endsWith('/deployments')) return response({ deployments: [{ versions: splitTraffic
      ? [{ version_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',percentage: 50 }, { version_id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',percentage: 50 }] : [{ version_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',percentage: 100 }] }] });
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
            state.record.revision !== Number(params[1]) || state.record.in_flight_count !== 0) return response([{ success: true, meta: { changes: 0 } }]);
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
    { shared: true }, { splitTraffic: true }, { inFlight: true }]) {
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
    if (url.endsWith('/workers/scripts')) {
      workerInventoryReads++;
      return response([{ id: 'database-mcp-worker' }, { id: 'other-worker' },
        ...(workerInventoryDrift && workerInventoryReads > 1 ? [{ id: 'unexpected-worker' }] : [])]);
    }
    if (url.includes('/workers/scripts/other-worker/')) {
      if (otherWorkerInventoryUnknown) throw Error('synthetic unreadable other worker');
      if (url.endsWith('/settings')) return response({ bindings: otherWorkerCurrentBound
        ? [{ type: 'hyperdrive', name: binding, id: configId }] : [] });
      if (url.endsWith('/deployments')) return response({ deployments: [{ versions: [
        { version_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', percentage: 100 }
      ] }] });
      if (url.endsWith('/versions?deployable=true')) {
        otherVersionReads++;
        return response({ items: [{ id: 'dddddddd-dddd-dddd-dddd-dddddddddddd' },
          ...(otherWorkerVersionDrift && otherVersionReads > 1
            ? [{ id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' }] : [])] });
      }
      if (url.endsWith('/versions/dddddddd-dddd-dddd-dddd-dddddddddddd'))
        return response({ id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
          resources: { bindings: otherWorkerRollbackBound
            ? [{ type: 'hyperdrive', name: binding, id: configId }] : [] } });
    }
    if(url.includes('/workers/scripts/database-mcp-worker/') && url.endsWith('/versions?deployable=true')) return {ok:true,json:async()=>({success:true,result:{items:[{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'},{id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}]}})};
    if(url.endsWith('/versions/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')) return {ok:true,json:async()=>({success:true,result:{id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',resources:{bindings:[{type:'hyperdrive',name:binding,id:configId}]}}})};
    return f.request(url,init);
  };
  await assert.rejects(retireDatabaseHyperdrive({...inputs,request}),/rollback.*reference/);
  assert.equal(f.state.writes,0);
});

test('unknown active version or mismatched live resources block D1 retirement', async()=>{
  for (const option of [{unknownActive:true},{currentDrift:true}]){
    const f=fixture(option);
    await assert.rejects(retireDatabaseHyperdrive({...inputs,request:f.request}),/retirement blocked/);
    assert.equal(f.state.writes,0);
  }
});
test('missing current version UUID blocks before any D1 retirement',async()=>{
 const f=fixture();const request=async(url,init)=>{
   if(url.includes('/workers/scripts/database-mcp-worker/') && url.endsWith('/deployments'))return {ok:true,json:async()=>({success:true,result:{deployments:[{versions:[{percentage:100}]}]}})};
   return f.request(url,init);
 };
 await assert.rejects(retireDatabaseHyperdrive({...inputs,request}),/retirement blocked/);
 assert.equal(f.state.writes,0);
});

test('a changed live deployment during final readback is rejected without D1 write',async()=>{
  const f=fixture();let deployments=0;
  const request=async(url,init)=>{
    if(url.includes('/workers/scripts/database-mcp-worker/') && url.endsWith('/deployments')){
      deployments++;
      return {ok:true,json:async()=>({success:true,result:{deployments:[{versions:[{
        version_id:deployments===1?'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa':'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        percentage:100
      }]}]}})};
    }
    return f.request(url,init);
  };
  await assert.rejects(retireDatabaseHyperdrive({...inputs,request}),/deployment changed/);
  assert.equal(deployments,2);
  assert.equal(f.state.writes,0);
});

// The live Cloudflare inventory contained 26 rollback-eligible versions and
// 13 still referenced the current config. Use synthetic IDs to exercise the
// real response shape; this test must never touch production resources.
test('26 deployable versions with 13 retained bindings block retirement without writes',async()=>{
 const live='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
 const ids=[live,...Array.from({length:25},(_,i)=>
   '00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'))];
 const retained=new Set(ids.slice(13));
 assert.equal(retained.size,13);
 const f=fixture();
 const request=async(url,init)=>{
   if(url.includes('/workers/scripts/database-mcp-worker/') && url.endsWith('/versions?deployable=true'))return {
     ok:true,json:async()=>({success:true,result:{items:ids.map(id=>({id}))}})
   };
   const id=ids.find(x=>url.endsWith('/versions/'+x));
   if(id)return {
     ok:true,json:async()=>({success:true,result:{id,resources:{bindings:[
       {type:'d1',name:'DB',database_id:registry},
       ...(retained.has(id)?[{type:'hyperdrive',name:binding,id:configId}]:[])
     ]}}})
   };
   return f.request(url,init);
 };
 await assert.rejects(retireDatabaseHyperdrive({...inputs,request}),/rollback.*reference/);
 assert.equal(f.state.writes,0);
 assert.equal(f.state.record?.id,'retire_test');
 assert.equal(f.calls.some(c=>c.url.includes('hyperdrive/configs')),false);
});

test('full 26-version clean rollback inventory permits only the D1 tombstone',async()=>{
 const live='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
 const ids=[live,...Array.from({length:25},(_,i)=>
   '00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'))];
 const checked=[];
 const f=fixture();
 const request=async(url,init)=>{
   if(url.includes('/workers/scripts/database-mcp-worker/') && url.endsWith('/versions?deployable=true'))return {
     ok:true,json:async()=>({success:true,result:{items:ids.map(id=>({id}))}})
   };
   const id=ids.find(x=>url.endsWith('/versions/'+x));
   if(id){checked.push(id);return {
     ok:true,json:async()=>({success:true,result:{id,resources:{bindings:[
       {type:'d1',name:'DB',database_id:registry}
     ]}}})
   };}
   return f.request(url,init);
 };
 const result=await retireDatabaseHyperdrive({...inputs,request});
 assert.deepEqual(result,{retired:true,connectionId:'retire_test'});
 assert.deepEqual(checked,ids);
 assert.equal(f.state.writes,1);
});

test('partially unreadable rollback inventory refuses destructive D1 retirement',async()=>{
 const f=fixture();
 const request=async(url,init)=>{
   if(url.includes('/workers/scripts/database-mcp-worker/') && url.endsWith('/versions?deployable=true'))return {
     ok:true,json:async()=>({success:true,result:{items:[
       {id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'},
       {id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}
     ]}})
   };
   if(url.endsWith('/versions/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'))return {
     ok:true,json:async()=>({success:true,result:{id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}})
   };
   return f.request(url,init);
 };
 await assert.rejects(retireDatabaseHyperdrive({...inputs,request}),/reference remains or is unconfirmed/);
 assert.equal(f.state.writes,0);
});

test('other Workers current and deployable rollback references block D1 retirement',async()=>{
  for(const option of [{otherWorkerCurrentBound:true},{otherWorkerRollbackBound:true}]){
    const f=fixture(option);
    await assert.rejects(retireDatabaseHyperdrive({...inputs,request:f.request}),/retirement blocked/);
    assert.equal(f.state.writes,0);
  }
});

test('unknown or drifting account-wide Worker inventory blocks retirement',async()=>{
  for(const option of [{otherWorkerInventoryUnknown:true},
    {otherWorkerVersionDrift:true},{workerInventoryDrift:true}]){
    const f=fixture(option);
    await assert.rejects(retireDatabaseHyperdrive({...inputs,request:f.request}),/retirement blocked/);
    assert.equal(f.state.writes,0);
  }
});

test('clean other Worker version history is required before retiring D1 identity',async()=>{
  const f=fixture();
  await retireDatabaseHyperdrive({...inputs,request:f.request});
  assert.equal(f.state.writes,1);
  assert.ok(f.calls.some(c=>c.url.endsWith('/workers/scripts/other-worker/versions/dddddddd-dddd-dddd-dddd-dddddddddddd')));
});

test('new rollback version discovered after account scan blocks D1 retirement',async()=>{
 const f=fixture();let inventories=0;
 const request=async(url,init)=>{
   if(url.endsWith('/workers/scripts/database-mcp-worker/versions?deployable=true')){
     inventories++;
     return {ok:true,json:async()=>({success:true,result:{items:[
       {id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'},
       ...(inventories>1?[{id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}]:[])
     ]}})};
   }
   return f.request(url,init);
 };
 await assert.rejects(retireDatabaseHyperdrive({...inputs,request}),/rollback.*changed/);
 assert.equal(inventories,2);assert.equal(f.state.writes,0);
});

test('paginated account Worker inventory refuses irreversible retirement even if first page appears clean', async () => {
  for (const paginatedRead of [1, 2]) {
    const f = fixture();
    let reads = 0;
    const request = async (url, init) => {
      const response = await f.request(url, init);
      if (!url.endsWith('/workers/scripts')) return response;
      reads++;
      const json = await response.json();
      return { ok: true, json: async () => ({ ...json, result_info: {
        page: 1, per_page: 2, count: 2, total_count: paginatedRead === reads ? 3 : 2,
        total_pages: paginatedRead === reads ? 2 : 1
      } }) };
    };
    await assert.rejects(retireDatabaseHyperdrive({ ...inputs, request }),
      /inventory (?:incomplete|changed)/);
    assert.equal(f.state.writes, 0);
  }
});
