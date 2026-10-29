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
 unknownRollback=false,changeDeployment=false,caDrift=false,otherWorkerRollbackBound=false,rowRecheckChanged=false}={}){
 const calls=[];let deployments=0,rowReads=0;
 const source=sourceBound?{...input.source,hyperdrive:[{binding:'HYPERDRIVE_TEST',id:configId}]}:input.source;
 const manifest=sourceBound?[{binding:'HYPERDRIVE_TEST',id:configId,dialect:'mysql'}]:[];
 const respond=result=>({ok:true,json:async()=>({success:true,result})});
 const request=async(url,init)=>{
  const path=url.split('/accounts/'+input.accountId)[1];calls.push({path,method:init.method});
  if(path.includes('/d1/database/')&&path.endsWith('/query')){
   const {sql}=JSON.parse(init.body);
   if(sql.startsWith('SELECT id')){rowReads++;return respond([{success:true,results:[{
    id:'rotation_fixture',dialect:'mysql',transport:'hyperdrive',status,revision,
    config_id:configId,binding_name:'HYPERDRIVE_TEST',in_flight_count:count
   }].map(row=>rowRecheckChanged&&rowReads>1?{...row,revision:8}:row)}]);}
   if(sql.includes('FROM d1_migrations'))return respond([{success:true,results:[{n:migration}]}]);
   if(sql.includes('FROM database_connections'))return respond([{success:true,results:[{n:shared}]}]);
   if(sql.includes('FROM hyperdrive_operations'))return respond([{success:true,results:[{n:operations}]}]);
  }
  if(path==='/hyperdrive/configs/'+configId)return respond({id:configId,caching:{disabled:true},
   origin:{scheme:'mysql'},mtls:{sslmode:'VERIFY_IDENTITY',ca_certificate_id:caDrift?null:'fake-ca'}});
  if(path==='/workers/scripts')return respond([{id:'database-mcp-worker'},{id:'other-worker'}]);
  if(path.endsWith('/settings'))return respond({bindings:currentBound?[{type:'hyperdrive',name:'HYPERDRIVE_TEST',id:configId}]:[]});
  if(path.endsWith('/deployments')){
   deployments++;
   return respond({deployments:[{versions:[{version_id:changeDeployment&&deployments>1?other:version,percentage:100}]}]});
  }
  if(path.endsWith('/versions?deployable=true'))return respond({items:[{id:version},{id:other}]});
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
