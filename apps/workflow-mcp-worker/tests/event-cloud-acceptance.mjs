/** Disposable Cloudflare-native relative sleep acceptance. No production routes, Workflows or D1 writes. */
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {writeFileSync,unlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

assert.equal(process.env.GITHUB_REPOSITORY,'lirtual/mcp-workers');
assert.equal(process.env.GITHUB_REF,'refs/heads/feat/workflow-durable-event-wait');
const token=process.env.CLOUDFLARE_API_TOKEN;
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
assert.ok(token&&/^[0-9a-f]{32}$/.test(account||''),'Cloudflare acceptance credentials missing');
const run=process.env.GITHUB_RUN_ID,attempt=process.env.GITHUB_RUN_ATTEMPT;
assert.match(run??'',/^\d+$/);assert.match(attempt??'',/^\d+$/);
const name='workflow-event-acc-'+run+'-'+attempt;
const workdir=fileURLToPath(new URL('..',import.meta.url));
const config='.acceptance-event-'+run+'-'+attempt+'.json';
const secrets='.acceptance-event-'+run+'-'+attempt+'.secrets.json';
const configPath=new URL('../'+config,import.meta.url);
const secretPath=new URL('../'+secrets,import.meta.url);
const owner=randomBytes(32).toString('hex');
let dbId=null,workerCreated=false,workflowCreated=false,client=null,failed=false;
const errors=[];
const apiRoot='https://api.cloudflare.com/client/v4/accounts/'+account;
const clean=e=>String(e?.message||e).replaceAll(token,'[redacted]').replaceAll(owner,'[redacted]').slice(0,250);
async function api(method,path,body){
 const r=await fetch(apiRoot+path,{method,headers:{
  authorization:'Bearer '+token,'content-type':'application/json'},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
  signal:AbortSignal.timeout(30000)});
 const json=await r.json().catch(()=>({}));
 if(!r.ok||json.success!==true)throw Error('Cloudflare '+method+' failed '+r.status);
 return json.result;
}
async function query(sql,params=[]){
 const r=await api('POST','/d1/database/'+dbId+'/query',{sql,params});
 assert.equal(r[0]?.success,true,'D1 query failed');
 return r[0].results||[];
}
function wrangler(args){
 const r=spawnSync('pnpm',['exec','wrangler',...args],{
  cwd:workdir,encoding:'utf8',timeout:180000,
  env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},
  stdio:['ignore','pipe','pipe']});
 if(r.status!==0)throw Error('Wrangler '+args[0]+' exit '+r.status);
}
async function tool(name,args){
 const res=await client.callTool({name,arguments:args});
 const text=res.content?.find(x=>x.type==='text')?.text;
 assert.ok(text,'Missing MCP tool result: '+name);
 assert.notEqual(res.isError,true,name+' reported error');
 return JSON.parse(text);
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function accept(){
 const ds=await api('GET','/d1/database');
 assert.ok(!ds.some(x=>x.name===name),'Refusing to reuse preexisting test database');
 const created=await api('POST','/d1/database',{name});dbId=created.uuid;
 assert.match(dbId,/^[0-9a-f-]{36}$/i);
 writeFileSync(configPath,JSON.stringify({
  name,main:'src/index.ts',compatibility_date:'2026-09-10',
  workers_dev:true,preview_urls:false,
  d1_databases:[{binding:'DB',database_name:name,database_id:dbId,migrations_dir:'migrations'}],
  workflows:[{name,binding:'WORKFLOW',class_name:'WorkflowOrchestrator'}],
 }),{mode:0o600});
 writeFileSync(secretPath,JSON.stringify({MCP_ACCESS_TOKEN:owner}),{mode:0o600});
 wrangler(['d1','migrations','apply',name,'--remote','--config',config]);
 assert.equal((await query("SELECT COUNT(*) AS n FROM d1_migrations WHERE name='0012_event_wait_receipts.sql'"))[0].n,1);
 workerCreated=true;workflowCreated=true;
 wrangler(['deploy','--config',config,'--secrets-file',fileURLToPath(secretPath)]);
 const url='https://'+name+'.aiyaya.workers.dev/mcp';
 client=new Client({name:'disposable-wait-acceptance',version:'1.0.0'});
 for(let i=0;i<15;i++){
  try{
   await client.connect(new StreamableHTTPClientTransport(new URL(url),
    {requestInit:{headers:{authorization:'Bearer '+owner}}}));
   break;
  }catch(e){if(i===14)throw e;await pause(1000);}
 }
 const capability=await tool('workflow_capabilities',{id:'flow.wait_event'});
 assert.equal(capability.availability,'supported');
 const signalSecret=randomBytes(32).toString('base64url');
 const signalHash=createHash('sha256').update(signalSecret).digest('hex');
 const definition={version:1,name:name+'-definition',steps:[
  {id:'pre',flow:'wait',duration_seconds:4},
  {id:'signal',flow:'wait_event',needs:['pre'],timeout_seconds:3,token_sha256:signalHash},
  {id:'out',uses:'result.emit',needs:['signal'],with:{data:{ref:'steps.signal.output.value'}}},
 ]};
 const validation=await tool('workflow_validate',{definition:JSON.stringify(definition)});
 assert.equal(validation.valid,true,'Compiler rejected native event wait');
 const createdW=await tool('workflow_create',{definition:JSON.stringify(definition)});
 await tool('workflow_publish',{workflow_id:createdW.workflow_id,expected_revision:1});
 const ingress='https://'+name+'.aiyaya.workers.dev/events/';
 async function send(runId,eventId='early-1',body={value:'resumed'}){
  const result=await fetch(ingress+runId+'/signal',{method:'POST',headers:{
   authorization:'Bearer '+signalSecret,'content-type':'application/json',
   'x-workflow-event-id':eventId},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  return {status:result.status,body:await result.json()};
 }
 async function settle(runId){
  let result;
  for(let i=0;i<60;i++){
   result=await tool('workflow_result',{run_id:runId});
   if(['succeeded','failed','cancelled','indeterminate'].includes(result.status))return result;
   await pause(500);
  }
  throw Error('Run did not settle in bounded acceptance');
 }
 // Early signal: dispatch before native signal Step is reached.
 const early=await tool('workflow_run',{workflow_id:createdW.workflow_id,idempotency_key:'early-'+run});
 assert.ok(early.run_id);
 const ack=await send(early.run_id);
 assert.equal(ack.status,202,'Early signal ingress must ACK existing instance');
 assert.equal((await send(early.run_id)).status,200,'Same signal must be idempotent');
 assert.equal((await send(early.run_id,'other-id')).status,409,'Distinct event identity must conflict');
 const pre=await query('SELECT step_id,status FROM run_steps WHERE run_id=?',[early.run_id]);
 assert.notEqual(pre.find(x=>x.step_id==='out')?.status,'succeeded');
 const resumed=await settle(early.run_id);
 assert.equal(resumed.status,'succeeded','Buffered native event did not resume');
 assert.equal(resumed.result,'resumed');
 const final=await query('SELECT step_id,status FROM run_steps WHERE run_id=? ORDER BY step_id',[early.run_id]);
 assert.deepEqual(final.map(x=>[x.step_id,x.status]),[['out','succeeded'],['pre','succeeded'],['signal','succeeded']]);
 const native=await api('GET','/workflows/'+name+'/instances/'+early.run_id);
 assert.equal(native.status,'complete');
 console.log('EVENT_EARLY_BUFFER_REPLAY_NATIVE_RESUME_OK');

 // Finite timeout must mark failure and block downstream result.emit.
 const timeout=await tool('workflow_run',{workflow_id:createdW.workflow_id,idempotency_key:'timeout-'+run});
 const expired=await settle(timeout.run_id);
 assert.equal(expired.status,'failed','Timed out event should be a failed Run');
 assert.ok(expired.steps.some(x=>x.step_id==='out'&&x.status==='skipped'));
 assert.equal((await send(timeout.run_id,'late-timeout')).status,409);
 const expiredNative=await api('GET','/workflows/'+name+'/instances/'+timeout.run_id);
 assert.equal(expiredNative.status,'complete');
 console.log('EVENT_TIMEOUT_AND_LATE_REJECT_OK');

 // Native cancellation is a request, not a false claim about other effects.
 const cancel=await tool('workflow_run',{workflow_id:createdW.workflow_id,idempotency_key:'cancel-'+run});
 let waiting=false;
 for(let i=0;i<25;i++){
  const rows=await query('SELECT step_id,status FROM run_steps WHERE run_id=?',[cancel.run_id]);
  if(rows.some(x=>x.step_id==='signal'&&x.status==='waiting')){waiting=true;break;}
  await pause(400);
 }
 assert.ok(waiting,'Native signal Step never reached waiting');
 const cancelled=await tool('workflow_cancel',{run_id:cancel.run_id,step_id:'signal'});
 assert.equal(cancelled.physical_terminated,false,'External resources are never declared physically terminated');
 assert.equal((await send(cancel.run_id,'late-cancel')).status,409);
 const after=await tool('workflow_result',{run_id:cancel.run_id});
 assert.equal(after.status,'cancelled');
 assert.notEqual(after.steps.find(x=>x.step_id==='out')?.status,'succeeded');
 let nativeCancel=null;
 for(let i=0;i<18;i++){
  nativeCancel=await api('GET','/workflows/'+name+'/instances/'+cancel.run_id);
  if(nativeCancel.status==='terminated')break;
  await pause(500);
 }
 assert.equal(nativeCancel?.status,'terminated','Native cancellation not physically confirmed');
 console.log('EVENT_CANCEL_NATIVE_TERMINATION_OK');

 // Cleanup MUST only follow physical terminal observations for every instance.
 for(const runId of [early.run_id,timeout.run_id,cancel.run_id]){
  const state=await api('GET','/workflows/'+name+'/instances/'+runId);
  assert.ok(['complete','terminated','errored'].includes(state.status),'Refuse cleanup: native instance still active');
 }
 assert.equal((await query("SELECT COUNT(*) AS n FROM runs WHERE outcome IN ('queued','running','indeterminate')"))[0].n,0);
 assert.equal((await query("SELECT COUNT(*) AS n FROM pragma_foreign_key_check"))[0].n,0);

}
async function cleanup(){
 if(client)try{await client.close();}catch{}
 // A failed acceptance does not authorize an unverified native stop or
 // deletion of an in-flight instance. Report a cleanup blocker instead.
 if(dbId&&workerCreated){
  try{
   const rows=await query("SELECT instance_id,outcome FROM runs WHERE outcome NOT IN ('succeeded','failed','cancelled')");
   if(rows.length)throw Error('Disallow deleting nonterminal native test instances');
  }catch(e){failed=true;errors.push('guard:'+clean(e));return;}
 }
 if(workerCreated)try{await api('DELETE','/workers/scripts/'+name);workerCreated=false;}
  catch(e){failed=true;errors.push('worker:'+clean(e));}
 if(workflowCreated)try{await api('DELETE','/workflows/'+name);workflowCreated=false;}
  catch(e){failed=true;errors.push('workflow:'+clean(e));}
 if(dbId)try{await api('DELETE','/d1/database/'+dbId);dbId=null;}
  catch(e){failed=true;errors.push('d1:'+clean(e));}
 for(const f of [configPath,secretPath])try{unlinkSync(f);}catch{}
 if(!workerCreated&&!workflowCreated&&!dbId)console.log('EVENT_DISPOSABLE_RESOURCES_REMOVED');
}
try{await accept();}catch(e){failed=true;errors.push('acceptance:'+clean(e));}
finally{await cleanup();}
for(const error of errors)console.error('EVENT_ACCEPTANCE_FAILED',error);
if(!failed)console.log('EVENT_NATIVE_ACCEPTANCE_AND_CLEANUP_OK');
process.exitCode=failed?1:0;
