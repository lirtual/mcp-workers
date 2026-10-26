/** Disposable Cloudflare-native relative sleep acceptance. No production routes, Workflows or D1 writes. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {writeFileSync,unlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

assert.equal(process.env.GITHUB_REPOSITORY,'lirtual/mcp-workers');
assert.equal(process.env.GITHUB_REF,'refs/heads/feat/176-bounded-durable-wait');
const token=process.env.CLOUDFLARE_API_TOKEN;
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
assert.ok(token&&/^[0-9a-f]{32}$/.test(account||''),'Cloudflare acceptance credentials missing');
const run=process.env.GITHUB_RUN_ID,attempt=process.env.GITHUB_RUN_ATTEMPT;
assert.match(run??'',/^\d+$/);assert.match(attempt??'',/^\d+$/);
const name='workflow-wait-acc-'+run+'-'+attempt;
const workdir=fileURLToPath(new URL('..',import.meta.url));
const config='.acceptance-wait-'+run+'-'+attempt+'.json';
const secrets='.acceptance-wait-'+run+'-'+attempt+'.secrets.json';
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
 assert.equal((await query("SELECT COUNT(*) AS n FROM d1_migrations WHERE name='0011_awaited_child_capacity.sql'"))[0].n,1);
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
 const capability=await tool('workflow_capabilities',{id:'flow.wait'});
 assert.equal(capability.availability,'supported');
 const definition={version:1,name:name+'-definition',steps:[
  {id:'hold',flow:'wait',duration_seconds:12},
  {id:'out',uses:'result.emit',needs:['hold'],with:{data:'waited'}},
 ]};
 const validation=await tool('workflow_validate',{definition:JSON.stringify(definition)});
 assert.equal(validation.valid,true,'Compiler rejected bounded wait');
 const createdW=await tool('workflow_create',{definition:JSON.stringify(definition)});
 assert.equal((await tool('workflow_validate',{workflow_id:createdW.workflow_id,revision:1})).valid,true);
 await tool('workflow_publish',{workflow_id:createdW.workflow_id,expected_revision:1});
 const started=await tool('workflow_run',{workflow_id:createdW.workflow_id,idempotency_key:'hold-'+run});
 assert.ok(started.run_id);
 let seenWaiting=false,earlyEffect=false,result=null;
 for(let i=0;i<80;i++){
  const rows=await query("SELECT step_id,status FROM run_steps WHERE run_id=?",[started.run_id]);
  const hold=rows.find(r=>r.step_id==='hold');
  const out=rows.find(r=>r.step_id==='out');
  if(hold?.status==='waiting'){
   seenWaiting=true;
   if(out?.status==='succeeded')earlyEffect=true;
  }
  result=await tool('workflow_result',{run_id:started.run_id});
  if(['succeeded','failed','cancelled','indeterminate'].includes(result.status))break;
  await pause(500);
 }
 assert.equal(seenWaiting,true,'Native wait never appeared in D1 status as waiting');
 assert.equal(earlyEffect,false,'Dependent effect ran before native sleep completed');
 assert.equal(result?.status,'succeeded','Native wait did not resume to success');
 assert.equal(result.result,'waited');
 const final=await query("SELECT step_id,status FROM run_steps WHERE run_id=? ORDER BY step_id",[started.run_id]);
 assert.deepEqual(final.map(x=>[x.step_id,x.status]),[['hold','succeeded'],['out','succeeded']]);
 assert.equal((await query("SELECT COUNT(*) AS n FROM runs WHERE outcome NOT IN ('succeeded','failed','cancelled')"))[0].n,0);
 console.log('WAIT_NATIVE_SLEEP_RESUME_AND_DEPENDENCY_OK');
 const native=await api('GET','/workflows/'+name+'/instances/'+started.run_id);
 assert.equal(native.status,'complete','Native instance has not reached physical completion');
 console.log('WAIT_NATIVE_INSTANCE_COMPLETE_OK');
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
 if(!workerCreated&&!workflowCreated&&!dbId)console.log('WAIT_DISPOSABLE_RESOURCES_REMOVED');
}
try{await accept();}catch(e){failed=true;errors.push('acceptance:'+clean(e));}
finally{await cleanup();}
for(const error of errors)console.error('WAIT_ACCEPTANCE_FAILED',error);
if(!failed)console.log('WAIT_NATIVE_ACCEPTANCE_AND_CLEANUP_OK');
process.exitCode=failed?1:0;
