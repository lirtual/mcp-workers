// Disposable Cloudflare MCP -> test Portal -> IMA end-to-end acceptance.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {writeFileSync,unlinkSync} from 'node:fs';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {TRUSTED_PORTAL_ENDPOINT,scopedPublicMcpFetch} from '../src/mcp-public-fetch.ts';
import {toolSchemaDigest} from '../src/plan.ts';
const need=k=>{assert.ok(process.env[k],'Missing '+k);return process.env[k]};
const cf=need('CLOUDFLARE_API_TOKEN'),account=need('CLOUDFLARE_ACCOUNT_ID');
const pair={clientId:need('MCP_PORTAL_CLIENT_ID'),clientSecret:need('MCP_PORTAL_CLIENT_SECRET')};
const suffix=randomBytes(5).toString('hex'),name='workflow-mcp-ima-'+suffix;
const file='wrangler.mcp-isolated-'+suffix+'.json',cwd=new URL('..',import.meta.url).pathname;
const endpoint='https://'+name+'.aiyaya.workers.dev/mcp',ownerToken=randomUUID()+randomUUID();
let dbId,attempted=false,owner,portal,runId;const pause=ms=>new Promise(r=>setTimeout(r,ms));
assert.match(name,/^workflow-mcp-ima-[a-f0-9]{10}$/);
async function api(method,path,body){
  const r=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{authorization:'Bearer '+cf,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000)});
  const v=await r.json().catch(()=>null);if(!r.ok||!v?.success)throw Error('Cloudflare '+method+' HTTP '+r.status);return v.result;
}
function wr(args,input){
  const r=spawnSync('pnpm',['exec','wrangler',...args],{cwd,encoding:'utf8',input,timeout:120000,maxBuffer:2097152,env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'}});
  if(r.status!==0)throw Error('wrangler '+args[0]+' '+(args[1]||'')+' failed '+r.status+' (details suppressed)');return r.stdout;
}
function mcp(url,options){const client=new Client({name:'isolated-s2',version:'1'});return {client,transport:new StreamableHTTPClientTransport(new URL(url),options)};}
async function tool(name,args,expect){const r=await owner.callTool({name,arguments:args});assert.equal(r.content?.[0]?.type,'text');const v=JSON.parse(r.content[0].text);if(expect){assert.equal(r.isError,true);assert.equal(v.error,expect);}else assert.notEqual(r.isError,true,name+' returned error');return v;}
async function run(){
  portal=mcp(TRUSTED_PORTAL_ENDPOINT,{fetch:scopedPublicMcpFetch(TRUSTED_PORTAL_ENDPOINT,fetch,pair)});
  await portal.client.connect(portal.transport);
  const cand=(await portal.client.listTools()).tools.find(t=>t.name==='ima_list_notebooks');
  assert.ok(cand&&cand.annotations?.readOnlyHint===true&&cand.annotations?.destructiveHint!==true,'IMA read-only contract missing');
  const created=await api('POST','/accounts/'+account+'/d1/database',{name});dbId=created.uuid;
  assert.match(dbId,/^[a-f0-9-]{36}$/i);console.log('DISPOSABLE_DB_CREATED',name);
  writeFileSync(new URL('../'+file,import.meta.url),JSON.stringify({name,main:'src/index.ts',compatibility_date:'2026-09-10',workers_dev:true,preview_urls:false,keep_vars:false,vars:{MCP_CALL_ENABLED:'true',MCP_PORTAL_ENDPOINT:TRUSTED_PORTAL_ENDPOINT},d1_databases:[{binding:'DB',database_name:name,database_id:dbId,migrations_dir:'migrations'}],workflows:[{name,binding:'WORKFLOW',class_name:'WorkflowRunner'}],services:[{binding:'READONLY_TARGET',service:'workflow-readonly-fixture'}]}));
  wr(['d1','migrations','apply',name,'--remote','--config',file]);
  attempted=true;wr(['deploy','--config',file]);
  for(const [key,val] of Object.entries({MCP_ACCESS_TOKEN:ownerToken,MCP_PORTAL_CLIENT_ID:pair.clientId,MCP_PORTAL_CLIENT_SECRET:pair.clientSecret}))wr(['secret','put',key,'--config',file],val);
  console.log('DISPOSABLE_WORKER_READY',name);
  let connected=false;for(let i=0;i<15;i++){
    const instance=mcp(endpoint,{requestInit:{headers:{authorization:'Bearer '+ownerToken}}});
    try{await instance.client.connect(instance.transport);owner=instance.client;connected=true;break;}catch{await instance.client.close().catch(()=>{});await pause(2000);}
  }assert.ok(connected,'Isolated Worker unavailable');
  const definition={version:1,name:'isolated-ima-'+suffix,steps:[{id:'read',uses:'mcp.call',with:{endpoint:TRUSTED_PORTAL_ENDPOINT,tool:'ima_list_notebooks',scope:'read',input_schema:cand.inputSchema,...(cand.outputSchema?{output_schema:cand.outputSchema}:{}),arguments:{limit:1}}},{id:'emit',uses:'result.emit',needs:['read'],with:{data:{ref:'steps.read.output'}}}]};
  const draft=await tool('workflow_create',{definition:JSON.stringify(definition)});
  const validation=await tool('workflow_validate',{workflow_id:draft.workflow_id,revision:1});
  assert.equal(validation.valid,true);assert.equal(validation.required_approvals?.length,1);
  assert.deepEqual(validation.required_approvals[0],{endpoint:TRUSTED_PORTAL_ENDPOINT,tool:'ima_list_notebooks',scope:'read',schema_digest:await toolSchemaDigest(cand.inputSchema,cand.outputSchema)});
  const base={workflow_id:draft.workflow_id,expected_revision:1};
  await tool('workflow_publish',{...base,approved_operations:validation.required_approvals},'target_risk_acknowledgment_required');
  await tool('workflow_publish',{...base,approved_operations:[],accept_target_risks:true},'external_approval_required');
  const published=await tool('workflow_publish',{...base,approved_operations:validation.required_approvals,accept_target_risks:true});assert.ok(published.published_version_id);
  const params={workflow_id:draft.workflow_id,inputs:{},idempotency_key:'mcp-ima-'+suffix};
  const started=await tool('workflow_run',params);runId=started.run_id;let outcome;
  for(let i=0;i<60;i++){outcome=await tool('workflow_result',{run_id:runId});if(['succeeded','failed','indeterminate','cancelled'].includes(outcome.status))break;await pause(1000);}
  assert.equal(outcome.status,'succeeded','Actual Cloudflare Workflow failed');
  assert.equal(outcome.steps.length,2);assert.ok(outcome.steps.every(s=>s.status==='succeeded'));
  assert.ok(Array.isArray(outcome.result?.content),'IMA tool data missing');
  assert.equal((await tool('workflow_run',params)).run_id,runId);
  console.log('MCP_ISOLATED_CLOUD_E2E_OK',JSON.stringify({worker:name,runId,steps:outcome.steps.map(s=>s.status),tool:'ima_list_notebooks'}));
}
async function resourcePresent(path){
  const response=await fetch('https://api.cloudflare.com/client/v4'+path,{
    headers:{authorization:'Bearer '+cf},signal:AbortSignal.timeout(15000),
  });
  const doc=await response.json().catch(()=>null);
  if(response.status===404||doc?.errors?.some(e=>e.code===10007))return false;
  if(!response.ok||doc?.success!==true)throw Error('Cleanup verification failed: HTTP '+response.status);
  return true;
}
async function removeExact(path){
  if(await resourcePresent(path))await api('DELETE',path);
  if(await resourcePresent(path))throw Error('Disposable resource still present');
}
async function cleanup(){
  try{await owner?.close();await portal?.client?.close();}catch{}
  if(!/^workflow-mcp-ima-[a-f0-9]{10}$/.test(name))throw Error('Unsafe cleanup identity');
  const failed=[];
  const worker='/accounts/'+account+'/workers/scripts/'+name;
  const workflow='/accounts/'+account+'/workflows/'+name;
  if(attempted){
    try{
      if(await resourcePresent(worker+'/script-settings'))
        await api('DELETE',worker+'?force=true');
      if(await resourcePresent(worker+'/script-settings'))throw Error('worker remains');
    }catch{failed.push('worker');}
    try{await removeExact(workflow);}catch{failed.push('workflow');}
  }
  if(dbId){
    try{await removeExact('/accounts/'+account+'/d1/database/'+dbId);}
    catch{failed.push('d1');}
  }
  try{unlinkSync(new URL('../'+file,import.meta.url));}catch{}
  if(failed.length)throw Error('DISPOSABLE_CLEANUP_FAILED: '+failed.join(',')+' name='+name);
  console.log('DISPOSABLE_CLEANUP_OK',name);
}
let failure;
try{await run()}catch(e){failure=e;console.error('MCP_CLOUD_E2E_FAILED',String(e.message).replaceAll(cf,'[redacted]').replaceAll(pair.clientSecret,'[redacted]'),'name='+name);}
finally{try{await cleanup();}catch(e){failure??=e;console.error(String(e.message));}}
// CLI has completed all awaited cleanup. Close lingering SDK/HTTP handles rather
// than letting a successful test hang until GitHub cancels the entire job.
process.exit(failure?1:0);
