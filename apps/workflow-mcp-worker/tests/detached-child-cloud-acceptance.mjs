// Temporary, exact-branch native acceptance. All resources are disposable.
// No production Worker, D1, Workflow, Portal, GitHub Task or user notification.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {writeFileSync,unlinkSync} from 'node:fs';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

const requireEnv=k=>{const v=process.env[k];assert.ok(v,'Missing '+k);return v;};
const cf=requireEnv('CLOUDFLARE_API_TOKEN');
const account=requireEnv('CLOUDFLARE_ACCOUNT_ID');
assert.equal(process.env.GITHUB_REPOSITORY,'lirtual/mcp-workers');
assert.equal(process.env.GITHUB_ACTOR,'lirtual');
assert.equal(process.env.GITHUB_REF,'refs/heads/feat/spec176-detached-child-20261030');
assert.match(requireEnv('GITHUB_SHA'),/^[a-f0-9]{40}$/);
const suffix=randomBytes(5).toString('hex');
const name='workflow-detached-acc-'+suffix;
const config='wrangler.detached-'+suffix+'.json';
const base=new URL('..',import.meta.url);
const endpoint='https://'+name+'.aiyaya.workers.dev';
const ownerToken=randomBytes(32).toString('hex');
let dbId,attemptedDeploy=false,owner,transport;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root='/accounts/'+account;
const clean=e=>String(e instanceof Error?e.message:e).replaceAll(cf,'[redacted]').replaceAll(ownerToken,'[redacted]').slice(0,350);

async function api(method,path,body){
  const response=await fetch('https://api.cloudflare.com/client/v4'+path,{method,
    headers:{authorization:'Bearer '+cf,'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  const value=await response.json().catch(()=>null);
  if(!response.ok||value?.success!==true)throw Error('Cloudflare '+method+' '+path.split('/').slice(-2,-1).join('')+' HTTP '+response.status);
  return value.result;
}
function wr(args,input){
  const r=spawnSync('pnpm',['exec','wrangler',...args],{cwd:base.pathname,encoding:'utf8',input,
    timeout:120000,maxBuffer:2097152,env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'}});
  if(r.status!==0)throw Error('Disposable Wrangler '+args[0]+' failed '+r.status);
}
async function query(sql,params=[]){
  const result=await api('POST',root+'/d1/database/'+dbId+'/query',{sql,params});
  assert.equal(result[0]?.success,true,'Isolated D1 query failed');
  return result[0].results||[];
}
async function tool(name,args,expectedError){
  const response=await owner.callTool({name,arguments:args},{timeout:15000});
  const text=response.content?.find(x=>x.type==='text')?.text;
  assert.ok(text,'MCP missing text for '+name);
  const value=JSON.parse(text);
  if(expectedError){assert.equal(response.isError,true,name+' should fail closed');assert.equal(value.error,expectedError);}
  else assert.notEqual(response.isError,true,name+' error '+JSON.stringify(value).slice(0,180));
  return value;
}
async function settle(id,allowRunning=false){
  for(let i=0;i<150;i++){
    const result=await tool('workflow_result',{run_id:id});
    if(['succeeded','failed','indeterminate','cancelled'].includes(result.status))return result;
    if(allowRunning)return result;
    await sleep(700);
  }
  throw Error('Run did not reach terminal within bounded native acceptance');
}
async function run(){
  const created=await api('POST',root+'/d1/database',{name});
  dbId=created.uuid;
  assert.match(dbId,/^[a-f0-9-]{36}$/i);
  const cfg={name,main:'src/index.ts',compatibility_date:'2026-09-10',workers_dev:true,
    preview_urls:false,keep_vars:false,
    d1_databases:[{binding:'DB',database_name:name,database_id:dbId,migrations_dir:'migrations'}],
    workflows:[{name,binding:'WORKFLOW',class_name:'WorkflowOrchestrator'}]};
  writeFileSync(new URL('../'+config,import.meta.url),JSON.stringify(cfg));
  wr(['d1','migrations','apply',name,'--remote','--config',config]);
  attemptedDeploy=true;
  wr(['deploy','--config',config]);
  wr(['secret','put','MCP_ACCESS_TOKEN','--config',config],ownerToken);
  let healthy=false;
  for(let i=0;i<25;i++){
    try{const response=await fetch(endpoint+'/health',{signal:AbortSignal.timeout(5000)});
      healthy=response.ok&&(await response.json()).ok===true;if(healthy)break;
    }catch{}await sleep(1800);
  }
  assert.ok(healthy,'Disposable native Worker /health unavailable');
  for(let i=0;i<18;i++){
    const candidate=new Client({name:'isolated-detached-child',version:'1.0'});
    const link=new StreamableHTTPClientTransport(new URL(endpoint+'/mcp'),{
      requestInit:{headers:{authorization:'Bearer '+ownerToken}}});
    try{await candidate.connect(link,{timeout:10000});owner=candidate;transport=link;break;}
    catch{await candidate.close().catch(()=>{});await sleep(1500);}
  }
  assert.ok(owner,'Disposable MCP route unavailable');
  const advertised=await owner.listTools();
  for(const name of ['workflow_create','workflow_validate','workflow_publish','workflow_run','workflow_result','workflow_cancel'])
    assert.ok(advertised.tools.some(x=>x.name===name),'Isolated tool missing '+name);
  console.log('DETACHED_ISOLATED_NATIVE_WORKER_AND_D1_READY');
  const child=await tool('workflow_create',{definition:JSON.stringify({version:1,
    name:'isolated-'+suffix+'-child',steps:[
      {id:'wait',flow:'wait',duration_seconds:50},
      {id:'finish',needs:['wait'],uses:'result.emit',with:{data:{value:'detached-native-ok'}}},
    ]})});
  const childPublished=await tool('workflow_publish',{workflow_id:child.workflow_id,expected_revision:1});
  assert.ok(childPublished.published_version_id);
  const parent=await tool('workflow_create',{definition:JSON.stringify({version:1,
    name:'isolated-'+suffix+'-parent',steps:[
      {id:'launch',flow:'child',mode:'detached',workflow_id:child.workflow_id,
        version_id:childPublished.published_version_id,inputs:{}},
      {id:'forward',uses:'result.emit',needs:['launch'],with:{data:{ref:'steps.launch.output'}}},
    ]})});
  const validation=await tool('workflow_validate',{workflow_id:parent.workflow_id,revision:1});
  assert.equal(validation.valid,true,'Detached source must validate');
  assert.equal(validation.required_children?.length,1);
  const required=validation.required_children[0];
  assert.equal(required.workflow_id,child.workflow_id);
  assert.equal(required.version_id,childPublished.published_version_id);
  await tool('workflow_publish',{workflow_id:parent.workflow_id,expected_revision:1},'child_approval_required');
  const parentPublished=await tool('workflow_publish',{
    workflow_id:parent.workflow_id,expected_revision:1,
    approved_children:validation.required_children});
  assert.ok(parentPublished.published_version_id);
  console.log('DETACHED_ISOLATED_EXACT_GRANT_PASS');
  const start=await tool('workflow_run',{workflow_id:parent.workflow_id,
    idempotency_key:'detached-'+suffix});
  assert.equal((await tool('workflow_run',{workflow_id:parent.workflow_id,
    idempotency_key:'detached-'+suffix})).run_id,start.run_id);
  const parentResult=await settle(start.run_id);
  assert.equal(parentResult.status,'succeeded','Native parent must complete');
  const reference=parentResult.result;
  assert.equal(reference?.published_version_id,childPublished.published_version_id);
  assert.match(reference?.run_id||'',/^[a-f0-9-]{36}$/i);
  const childRows=await query('SELECT id,parent_run_id,parent_step_id,version_id,outcome,capacity_weight FROM runs WHERE parent_run_id=?',[start.run_id]);
  assert.equal(childRows.length,1,'Exactly one detached child Run');
  assert.equal(childRows[0].id,reference.run_id);
  assert.equal(childRows[0].parent_step_id,'launch');
  assert.equal(childRows[0].capacity_weight,1);
  const parentRows=await query('SELECT outcome,capacity_weight FROM runs WHERE id=?',[start.run_id]);
  assert.equal(parentRows[0].outcome,'succeeded');
  assert.equal(parentRows[0].capacity_weight,1);
  // The child remains active after its parent is already terminal. This
  // distinguishes detached mode from the already-implemented awaited mode.
  assert.ok(['queued','running'].includes(childRows[0].outcome),
    'Child must still be live after the parent completes');
  console.log('DETACHED_ISOLATED_PARENT_TERMINAL_CHILD_STILL_ACTIVE_PASS');
  await tool('workflow_cancel',{run_id:start.run_id,step_id:'launch'},'child_not_cancellable');
  const childResult=await settle(reference.run_id);
  assert.equal(childResult.status,'succeeded');
  assert.deepEqual(childResult.result,{value:'detached-native-ok'});
  const parentStill=await tool('workflow_result',{run_id:start.run_id});
  assert.equal(parentStill.status,'succeeded');
  const workflow=root+'/workflows/'+name;
  const nativeParent=await api('GET',workflow+'/instances/'+start.run_id);
  const nativeChild=await api('GET',workflow+'/instances/'+reference.run_id);
  assert.equal(nativeParent?.status,'complete');
  assert.equal(nativeChild?.status,'complete');
  assert.equal((await query('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id=?',[start.run_id]))[0].n,1);
  console.log('DETACHED_ISOLATED_NATIVE_PARENT_CHILD_COMPLETE_PASS');
  console.log('DETACHED_ISOLATED_REPLAY_AND_CANCEL_INDEPENDENCE_PASS');
}
async function exists(path){
  const r=await fetch('https://api.cloudflare.com/client/v4'+path,{headers:{authorization:'Bearer '+cf},
    signal:AbortSignal.timeout(18000)});
  const v=await r.json().catch(()=>null);
  if(r.status===404||v?.errors?.some(e=>e.code===10007))return false;
  if(!r.ok||v?.success!==true)throw Error('Cannot verify cleanup: HTTP '+r.status);
  return true;
}
async function cleanup(){
  try{await Promise.race([Promise.resolve().then(()=>owner?.close()).catch(()=>{}),sleep(1500)]);}catch{}
  const failures=[];
  assert.match(name,/^workflow-detached-acc-[a-f0-9]{10}$/);
  const worker=root+'/workers/scripts/'+name;
  const workflow=root+'/workflows/'+name;
  if(attemptedDeploy){
    try{if(await exists(worker+'/script-settings'))await api('DELETE',worker+'?force=true');
      if(await exists(worker+'/script-settings'))throw Error('Worker remains');}
    catch{failures.push('Worker');}
    try{if(await exists(workflow))await api('DELETE',workflow);
      if(await exists(workflow))throw Error('Workflow remains');}
    catch{failures.push('Workflow');}
  }
  if(dbId){
    try{if(await exists(root+'/d1/database/'+dbId))await api('DELETE',root+'/d1/database/'+dbId);
      if(await exists(root+'/d1/database/'+dbId))throw Error('D1 remains');}
    catch{failures.push('D1');}
  }
  try{unlinkSync(new URL('../'+config,import.meta.url));}catch{}
  if(failures.length)throw Error('Disposable cleanup unconfirmed: '+failures.join(',')+' '+name+' '+(dbId||''));
  console.log('DETACHED_ISOLATED_EXACT_RESOURCE_CLEANUP_PASS',name);
}
let problem;
try{await run();}
catch(e){problem=e;console.error('DETACHED_ISOLATED_NATIVE_FAILED:',clean(e));}
finally{try{await cleanup();}catch(e){problem||=e;console.error('DETACHED_ISOLATED_CLEANUP_FAILED:',clean(e));}}
if(problem)process.exitCode=1;
