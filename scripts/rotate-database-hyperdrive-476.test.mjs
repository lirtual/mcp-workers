import test from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv} from 'node:crypto';
import {runHyperdriveCredentialRotation} from './rotate-database-hyperdrive-476.mjs';

const id='12345678-1234-1234-1234-123456789abc';
const configId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const binding='HYPERDRIVE_ISOLATED';
const registry='cbfe6a05-4979-4e6a-9cc2-4f6468586e4a';
const secret='synthetic-new-password-not-for-logs';
const base64=Buffer.alloc(32,118).toString('base64');
const keyId='rotation-key';
const target={binding,id:configId,dialect:'mysql',origin_host:'mysql.example.net',origin_port:3306,
 origin_database:'catalog',origin_user:'reader',ca_certificate_id:'synthetic-ca-12345'};
function sealed(){
 const iv=Buffer.alloc(12,42);
 const cipher=createCipheriv('aes-256-gcm',Buffer.from(base64,'base64'),iv);
 cipher.setAAD(Buffer.from('database-mcp:hyperdrive-operation:v1:'+id+':rotate_credentials:isolated:4'));
 const encrypted=Buffer.concat([cipher.update(JSON.stringify({password:secret})),cipher.final(),cipher.getAuthTag()]);
 return iv.toString('base64')+'.'+encrypted.toString('base64');
}
const source={name:'database-mcp-worker',main:'src/index.ts',hyperdrive:[],
 d1_databases:[{binding:'DB',database_name:'database-mcp-registry',database_id:registry}]};
const input={operationId:id,runId:'476',actor:'lirtual',ref:'refs/heads/main',
 repo:'lirtual/mcp-workers',event:'workflow_dispatch',sourceSha:'b'.repeat(40),
 accountId:'c'.repeat(32),token:'synthetic-cf-token',encryptionKey:base64,keyId,source,manifest:[]};
function fixture({blocked=false,patchError=false,restartError=false,sharedDuringClaim=false,unrecordedDispatch=false}={}){
 const state={phase:'running',started:null,errors:[],patches:0,restarts:0,recordedRun:unrecordedDispatch?null:476};
 const requests=[];
 const op={operation_id:id,logical_id:'isolated',action:'rotate_credentials',phase:'running',
  expected_revision:4,config_id:configId,binding_name:binding,ciphertext:sealed(),
  key_id:keyId,prepare_run_id:unrecordedDispatch?null:476,resource_write_started_at:null,expires_at:Date.now()+60000};
 const row={id:'isolated',dialect:'mysql',transport:'hyperdrive',status:'disabled',revision:4,
  config_id:configId,binding_name:binding,in_flight_count:0,target_metadata:JSON.stringify(target)};
 const result=(value,method='GET')=>({ok:true,json:async()=>({success:true,result:value})});
 const request=async(url,init)=>{
  requests.push({url,method:init.method});
  if(url.endsWith('/d1/database/'+registry+'/query')){
   const {sql,params}=JSON.parse(init.body);
   const success=(results=[],changes=0)=>result([{success:true,results,meta:{changes}}]);
   if(sql.startsWith('SELECT operation_id,'))return success([{...op,phase:state.phase,resource_write_started_at:state.started,prepare_run_id:state.recordedRun}]);
   if(sql.startsWith('UPDATE hyperdrive_operations SET prepare_run_id=')){state.recordedRun=Number(params[0]);return success([],1);}
   if(sql.startsWith('SELECT id,transport,'))return success([row]);
   if(sql.startsWith('UPDATE hyperdrive_operations SET resource_write_started_at=')){
    if(state.phase!=='running'||state.started!==null)return success([],0);
    if(sharedDuringClaim && !sql.includes('NOT EXISTS (SELECT 1 FROM database_connections WHERE id<>?')) return success([],1);
    if(sharedDuringClaim)return success([],0);
    state.started=Date.now();return success([],1);
   }
   if(sql.startsWith('UPDATE hyperdrive_operations SET phase=')){
    if(state.phase!=='running'||(state.started!==null)!==sql.includes('IS NOT NULL'))return success([],0);
    state.phase=params[0];state.errors.push(params[1]);op.ciphertext=null;return success([],1);
   }
   throw Error('unexpected SQL');
  }
  if(url.endsWith('/hyperdrive/configs/'+configId)&&init.method==='PATCH'){
   state.patches++;
   assert.deepEqual(JSON.parse(init.body),{origin:{password:secret}});
   if(patchError)throw Error('simulated ambiguous PATCH');
   return result({id:configId});
  }
  if(url.endsWith('/hyperdrive/configs/'+configId)&&init.method==='GET')
   return result({id:configId,origin:{scheme:'mysql',host:target.origin_host,
     port:3306,database:'catalog',user:'reader'},caching:{disabled:true},
     mtls:{sslmode:'VERIFY_IDENTITY',ca_certificate_id:target.ca_certificate_id}});
  if(url.endsWith('/hyperdrive/configs/'+configId+'/restart')){
   state.restarts++;if(restartError)throw Error('simulated restart lost ack');
   return result({id:configId});
  }
  throw Error('unexpected remote request');
 };
 const preflight=async args=>{assert.equal(args.operationId,id);
  assert.equal(args.connectionId,'isolated');assert.equal(args.mode,'credentials');
  if(blocked)throw Error('incomplete account inventory');
  return {eligible:true};};
 return {state,requests,request,preflight};
}
test('only an isolated Owner operation PATCHes password; restart leaves status awaiting verification',async()=>{
 const f=fixture();
 const result=await runHyperdriveCredentialRotation({...input,request:f.request,preflight:f.preflight});
 assert.deepEqual(result,{phase:'awaiting_confirmation',operationId:id,sqlVerified:false});
 assert.equal(f.state.patches,1);assert.equal(f.state.restarts,1);
 assert.equal(f.state.phase,'awaiting_confirmation');
 assert.deepEqual(f.state.errors,['credential_health_unverified']);
 assert.equal(JSON.stringify(result).includes(secret),false);
 assert.equal(f.requests.filter(r=>r.method==='PATCH').length,1);
 await assert.rejects(runHyperdriveCredentialRotation({...input,request:f.request,preflight:f.preflight}),/operation_invalid/);
 assert.equal(f.state.patches,1);
});
test('blocked isolation never PATCHes upstream and clears its pending operation',async()=>{
 const f=fixture({blocked:true});
 await assert.rejects(runHyperdriveCredentialRotation({...input,request:f.request,preflight:f.preflight}),/isolation_unproven/);
 assert.equal(f.state.patches,0);assert.equal(f.state.restarts,0);
 assert.equal(f.state.phase,'failed');
 assert.deepEqual(f.state.errors,['credential_isolation_blocked']);
});
test('unknown PATCH or restart receipt never replays and keeps connection disabled',async()=>{
 for(const condition of [{patchError:true},{restartError:true}]){
  const f=fixture(condition);
  await assert.rejects(runHyperdriveCredentialRotation({...input,request:f.request,preflight:f.preflight}),/write_outcome_unknown/);
  assert.equal(f.state.patches,1);assert.equal(f.state.phase,'unknown');
  assert.deepEqual(f.state.errors,['credential_outcome_unknown']);
  await assert.rejects(runHyperdriveCredentialRotation({...input,request:f.request,preflight:f.preflight}),/operation_invalid/);
  assert.equal(f.state.patches,1);
 }
});
test('unauthorized or invalid Runner context never reads or writes Cloudflare',async()=>{
 const f=fixture();
 for(const changed of [{actor:'other'},{ref:'refs/heads/feature'},{runId:'0'},
  {event:'pull_request'},{encryptionKey:''},{operationId:'invalid'}]){
  await assert.rejects(runHyperdriveCredentialRotation({...input,...changed,request:f.request,preflight:f.preflight}),/owner_or_identity/);
 }
 assert.equal(f.requests.length,0);
});

test('a new shared D1 binding discovered at the write claim refuses an upstream mutation',async()=>{
 const f=fixture({sharedDuringClaim:true});
 await assert.rejects(runHyperdriveCredentialRotation({...input,request:f.request,preflight:f.preflight}),/write_claim_failed/);
 assert.equal(f.state.patches,0);
});


test('Runner claim and final receipt execute against actual migration 0003 SQLite constraints',async()=>{
 const {DatabaseSync}=await import('node:sqlite');
 const {readFileSync}=await import('node:fs');
 const db=new DatabaseSync(':memory:');
 try{
  for(const filename of ['0001_connections.sql','0002_transport_and_retired_ids.sql','0003_hyperdrive_operations.sql']){
   db.exec(readFileSync(new URL('../apps/database-mcp-worker/migrations/'+filename,import.meta.url),'utf8'));
  }
  db.prepare(`INSERT INTO database_connections
   (id,dialect,transport,status,revision,config_id,binding_name,target_metadata,created_at,updated_at)
   VALUES ('isolated','mysql','hyperdrive','disabled',4,?,?,?,1,1)`)
   .run(configId,binding,JSON.stringify(target));
  db.prepare(`INSERT INTO hyperdrive_operations
   (operation_id,logical_id,action,expected_revision,phase,ciphertext,key_id,config_id,binding_name,prepare_run_id,created_at,updated_at,expires_at)
   VALUES (?,'isolated','rotate_credentials',4,'running',?,?,?,?,476,1,1,?)`)
   .run(id,sealed(),keyId,configId,binding,Date.now()+60000);
  const upstream=fixture();
  const request=async(url,init)=>{
   if(!url.endsWith('/d1/database/'+registry+'/query'))return upstream.request(url,init);
   const {sql,params}=JSON.parse(init.body);
   if(sql.trim().startsWith('SELECT')){
    const rows=db.prepare(sql).all(...params);
    return {ok:true,json:async()=>({success:true,result:[{success:true,results:rows}]})};
   }
   const outcome=db.prepare(sql).run(...params);
   return {ok:true,json:async()=>({success:true,result:[{success:true,results:[],meta:{changes:outcome.changes}}]})};
  };
  const receipt=await runHyperdriveCredentialRotation({...input,request,preflight:upstream.preflight});
  assert.equal(receipt.phase,'awaiting_confirmation');
  assert.equal(upstream.state.patches,1);
  assert.deepEqual({...db.prepare('SELECT phase,error_class,ciphertext,key_id FROM hyperdrive_operations WHERE operation_id=?').get(id)},
   {phase:'awaiting_confirmation',error_class:'credential_health_unverified',ciphertext:null,key_id:null});
  assert.deepEqual({...db.prepare('SELECT status,revision FROM database_connections WHERE id=?').get('isolated')},
   {status:'disabled',revision:4});
 }finally{db.close()}
});

test('a faster Runner records its exact GitHub Run ID before the Owner dispatch receipt arrives',async()=>{
 const f=fixture({unrecordedDispatch:true});
 const result=await runHyperdriveCredentialRotation({...input,request:f.request,preflight:f.preflight});
 assert.equal(result.phase,'awaiting_confirmation');
 assert.equal(f.state.recordedRun,476);
 assert.equal(f.state.patches,1);
});
