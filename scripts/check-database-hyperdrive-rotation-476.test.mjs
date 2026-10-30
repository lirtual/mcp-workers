import test from 'node:test';
import assert from 'node:assert/strict';
import {checkDatabaseHyperdriveRotation} from './check-database-hyperdrive-rotation-476.mjs';
const registry='cbfe6a05-4979-4e6a-9cc2-4f6468586e4a';
const configId='31fc05c77ac042ff927a6d3cbf5bbb7d';
const version='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const other='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const input={mode:'credentials',connectionId:'rotation_fixture',expectedRevision:'7',
 actor:'lirtual',ref:'refs/heads/main',sourceSha:'a'.repeat(40),accountId:'b'.repeat(32),
 token:'private-token-must-not-leak',source:{name:'database-mcp-worker',main:'src/index.ts',
 d1_databases:[{binding:'DB',database_name:'database-mcp-registry',database_id:registry}],hyperdrive:[]},
 manifest:[]};
function fixture({status='disabled',count=0,revision=7,shared=0,operations=0,
 migration=1,sourceBound=false,currentBound=false,rollbackBound=false,
 unknownRollback=false,changeDeployment=false,caDrift=false,otherWorkerRollbackBound=false,rowRecheckChanged=false,versionInventoryDrift=false,configReadbackDrift=false,workerInventoryDrift=false,targetDrift=false,missingTarget=false}={}){
 const target={binding:'HYPERDRIVE_TEST',id:configId,dialect:'mysql',
  origin_host:'db.example.com',origin_port:3306,origin_database:'sample',
  origin_user:'service',ca_certificate_id:'test-cert-1234'};
 const calls=[];let deployments=0,rowReads=0,inventoryReads=0,configReads=0,workerReads=0;
 const source=sourceBound?{...input.source,hyperdrive:[{binding:'HYPERDRIVE_TEST',id:configId}]}:input.source;
 const manifest=sourceBound?[{binding:'HYPERDRIVE_TEST',id:configId,dialect:'mysql'}]:[];
 const respond=result=>({ok:true,json:async()=>({success:true,result})});
 const request=async(url,init)=>{
  const path=url.split('/accounts/'+input.accountId)[1];calls.push({path,method:init.method});
  if(path.includes('/d1/database/')&&path.endsWith('/query')){
   const {sql}=JSON.parse(init.body);
   if(sql.startsWith('SELECT id')){rowReads++;return respond([{success:true,results:[{
    id:'rotation_fixture',dialect:'mysql',transport:'hyperdrive',status,revision,
    config_id:configId,binding_name:'HYPERDRIVE_TEST',in_flight_count:count,
    target_metadata:missingTarget?null:JSON.stringify(target)
   }].map(row=>rowRecheckChanged&&rowReads>1?{...row,revision:8}:row)}]);}
   if(sql.includes('FROM d1_migrations'))return respond([{success:true,results:[{n:migration}]}]);
   if(sql.includes('FROM database_connections'))return respond([{success:true,results:[{n:shared}]}]);
   if(sql.includes('FROM hyperdrive_operations'))return respond([{success:true,results:[{n:operations}]}]);
  }
  if(path==='/hyperdrive/configs/'+configId){
   configReads++;
   return respond({id:configId,caching:{disabled:true},origin:{scheme:'mysql',
    host:targetDrift?'wrong.example.com':target.origin_host,port:target.origin_port,
    database:target.origin_database,user:target.origin_user},
    mtls:{sslmode:'VERIFY_IDENTITY',ca_certificate_id:caDrift?null:configReadbackDrift&&configReads>1?'unexpected-new-ca':target.ca_certificate_id}});
  }
  if(path==='/workers/scripts'){
   workerReads++;
   return respond([{id:'database-mcp-worker'},{id:'other-worker'},
    ...(workerInventoryDrift&&workerReads>1?[{id:'unexpected-worker'}]:[])]);
  }
  if(path.endsWith('/settings'))return respond({bindings:currentBound?[{type:'hyperdrive',name:'HYPERDRIVE_TEST',id:configId}]:[]});
  if(path.endsWith('/deployments')){
   deployments++;
   return respond({deployments:[{versions:[{version_id:changeDeployment&&deployments>1?other:version,percentage:100}]}]});
  }
  if(path.endsWith('/versions?deployable=true')){
   inventoryReads++;
   const changed=versionInventoryDrift&&path.includes('/database-mcp-worker/')&&inventoryReads>1;
   return respond({items:[{id:version},{id:other},...(changed?[{id:'cccccccc-cccc-cccc-cccc-cccccccccccc'}]:[])]});
  }
  if(path.endsWith('/versions/'+version))return respond({id:version,resources:{bindings:path.includes('/other-worker/')&&otherWorkerRollbackBound?[{type:'hyperdrive',name:'HYPERDRIVE_TEST',id:configId}]:[]}});
  if(path.endsWith('/versions/'+other))return respond({id:other,resources:unknownRollback?null:{bindings:rollbackBound?
   [{type:'hyperdrive',name:'HYPERDRIVE_TEST',id:configId}]:[]}});
  throw Error('unexpected test request');
 };
 return {request,calls,source,manifest};
}
const run=(f,overrides={})=>checkDatabaseHyperdriveRotation({...input,source:f.source,manifest:f.manifest,request:f.request,...overrides});
const onlyRead=f=>assert.ok(f.calls.every(c=>c.method==='GET'||
 (c.method==='POST'&&c.path.includes('/d1/database/')&&c.path.endsWith('/query'))));
test('read-only credential and CA isolation checks use no Cloudflare mutation',async()=>{
 for(const mode of ['credentials','ca']){
  const f=fixture();
  assert.deepEqual(await run(f,{mode}),{eligible:true,mode,logicalId:'rotation_fixture',revision:7,
   verifiedVersions:4,verifiedWorkers:2});
  onlyRead(f);
  assert.equal(f.calls.filter(x=>x.path.endsWith('/deployments')).length,4);
 }
});
test('rotation rejects active/stale/in-flight/shared/unfinished states before changing anything',async()=>{
 for(const [options,code] of [[{status:'active'},'disabled_drain_unproven'],
  [{count:1},'disabled_drain_unproven'],[{revision:8},'disabled_drain_unproven'],
  [{migration:0},'drain_schema_unavailable'],[{shared:1},'shared_registry_reference'],
  [{operations:1},'unfinished_operation']]){
  const f=fixture(options);
  await assert.rejects(run(f),new RegExp(code));onlyRead(f);
 }
});
test('read-only rotation rejects versioned/current/rollback dependencies and drift',async()=>{
 for(const [options,code] of [[{sourceBound:true},'reviewed_source_reference'],
  [{currentBound:true},'current_worker_reference'],[{rollbackBound:true},'rollback_reference'],
  [{unknownRollback:true},'rollback_version_unavailable'],
  [{changeDeployment:true},'deployment_changed'],[{caDrift:true},'config_drift'],
  [{otherWorkerRollbackBound:true},'other_worker_rollback_reference']]){
  const f=fixture(options);
  await assert.rejects(run(f),new RegExp(code));onlyRead(f);
 }
});
test('no Owner gate or credential allows a Cloudflare request, and errors exclude secrets',async()=>{
 for(const override of [{actor:'outsider'},{mode:'overwrite'},{token:''},{expectedRevision:'0'}]){
  const f=fixture();await assert.rejects(run(f,override),/identity/);
  assert.equal(f.calls.length,0);
 }
 const f=fixture({rollbackBound:true});
 await assert.rejects(run(f),error=>{
  assert.doesNotMatch(error.message,/private-token|password|fake-ca/);
  assert.match(error.message,/rollback_reference/);return true;
 });
 onlyRead(f);
});

test('registry changes while scanning historical versions invalidate an earlier clean observation',async()=>{
 const f=fixture({rowRecheckChanged:true});
 await assert.rejects(run(f),/registry_changed_during_check/);
 onlyRead(f);
});

test('a rollback version appearing during the isolation scan invalidates eligibility',async()=>{
 const f=fixture({versionInventoryDrift:true});
 await assert.rejects(run(f),/rollback_inventory_changed/);
 onlyRead(f);
});

test('a Cloudflare CA change during the scan cannot return stale eligibility',async()=>{
 const f=fixture({configReadbackDrift:true});
 await assert.rejects(run(f),/config_changed_during_check/);
 onlyRead(f);
});

test('a newly registered Worker during inventory scan cannot return stale eligibility',async()=>{
 const f=fixture({workerInventoryDrift:true});
 await assert.rejects(run(f),/worker_inventory_changed/);
 onlyRead(f);
});

test('rotation rejects altered origin identity and absent immutable D1 target metadata',async()=>{
 for(const options of [{targetDrift:true},{missingTarget:true}]){
  const f=fixture(options);
  await assert.rejects(run(f),/target_identity_unconfirmed/);
  onlyRead(f);
 }
});

test('a paginated second Worker inventory never confirms rotation eligibility',async()=>{
 const f=fixture();let scans=0;
 const request=async(url,init)=>{
  const response=await f.request(url,init);
  if(!url.endsWith('/workers/scripts'))return response;
  scans++;
  const data=await response.json();
  return {ok:true,json:async()=>({...data,result_info:{page:1,count:2,total_count:scans===2?3:2,total_pages:scans===2?2:1}})};
 };
 await assert.rejects(run(f,{request}),/worker_inventory_changed/);
 onlyRead(f);
});

test('a Worker settings change after the historical scan invalidates rotation eligibility',async()=>{
 const f=fixture();let settingReads=0;
 const request=async(url,init)=>{
  const response=await f.request(url,init);
  if(!url.endsWith('/workers/scripts/other-worker/settings'))return response;
  settingReads++;
  if(settingReads<2)return response;
  return {ok:true,json:async()=>({success:true,result:{bindings:[{type:'hyperdrive',name:'HYPERDRIVE_TEST',id:configId}]}})};
 };
 await assert.rejects(run(f,{request}),/worker_settings_changed/);
 onlyRead(f);
});


test('the protected rotation Runner can exclude only its own reserved operation from the unresolved census',async()=>{
 const f=fixture({operations:1});
 await assert.rejects(run(f),/unfinished_operation/);
 const operationId='12345678-1234-1234-1234-123456789abc';
 const request=async(url,init)=>{
  if(url.includes('/d1/database/')&&String(init?.body??'').includes('operation_id<>?')){
   const params=JSON.parse(String(init.body)).params;
   assert.equal(params[1],operationId);
   return {ok:true,json:async()=>({success:true,result:[{success:true,results:[{n:0}]}]})};
  }
  return f.request(url,init);
 };
 assert.equal((await run(f,{request,operationId})).eligible,true);
});
