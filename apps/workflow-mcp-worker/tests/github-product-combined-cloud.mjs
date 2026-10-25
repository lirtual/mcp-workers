// Disposable Cloudflare combined MCP test Portal -> GitHub GitHub end-to-end acceptance.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {writeFileSync,unlinkSync} from 'node:fs';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {TRUSTED_PORTAL_ENDPOINT,scopedPublicMcpFetch} from '../src/mcp-public-fetch.ts';
import {toolSchemaDigest} from '../src/plan.ts';
const need=k=>{assert.ok(process.env[k],'Missing '+k);return process.env[k]};
const cf=need('CLOUDFLARE_API_TOKEN'),account=need('CLOUDFLARE_ACCOUNT_ID');
const pair={clientId:need('MCP_PORTAL_CLIENT_ID'),clientSecret:need('MCP_PORTAL_CLIENT_SECRET')};
assert.equal(need('GITHUB_REPOSITORY'),'lirtual/mcp-workers');
assert.equal(need('GITHUB_REF'),'refs/heads/wip/workflow-github-executor');
const expectedName=process.env.GITHUB_DEDICATED_TEST_NAME||undefined;
if(expectedName!==undefined)assert.match(expectedName,/^workflow-github-plan-[a-f0-9]{10}$/);
const suffix=expectedName?.slice(-10)??randomBytes(5).toString('hex');
const name=expectedName??'workflow-github-plan-'+suffix;
const dedicated=expectedName!==undefined;
const file='wrangler.github-plan-'+suffix+'.json',cwd=new URL('..',import.meta.url).pathname;
const endpoint='https://'+name+'.aiyaya.workers.dev/mcp',ownerToken=randomUUID()+randomUUID();
let dbId,attempted=false,owner,portal,runId;const pause=ms=>new Promise(r=>setTimeout(r,ms));
assert.match(name,/^workflow-github-plan-[a-f0-9]{10}$/);
async function api(method,path,body){
  const r=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{authorization:'Bearer '+cf,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000)});
  const v=await r.json().catch(()=>null);if(!r.ok||!v?.success)throw Error('Cloudflare '+method+' HTTP '+r.status);return v.result;
}
function wr(args,input){
  const r=spawnSync('pnpm',['exec','wrangler',...args],{cwd,encoding:'utf8',input,timeout:120000,maxBuffer:2097152,env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'}});
  if(r.status!==0){
    const safe=String(r.stderr||r.stdout||'')
      .replaceAll(cf,'[redacted]')
      .replaceAll(pair.clientSecret,'[redacted]')
      .replaceAll(process.env.GITHUB_TOKEN||'__not_set__','[redacted]');
    const lines=safe.split('\n').filter(x=>/error|failed|migration|workflow|script|name|binding|account|error code/i.test(x))
      .slice(-8).map(x=>x.slice(0,220));
    throw Error('wrangler '+args[0]+' '+(args[1]||'')+
      ' exit '+r.status+' '+lines.join(' | ').slice(0,850));
  }
  return r.stdout;
}
function mcp(url,options){const client=new Client({name:'isolated-s2',version:'1'});return {client,transport:new StreamableHTTPClientTransport(new URL(url),options)};}
async function tool(name,args,expect){const r=await owner.callTool({name,arguments:args});assert.equal(r.content?.[0]?.type,'text');const v=JSON.parse(r.content[0].text);if(expect){assert.equal(r.isError,true);assert.equal(v.error,expect);}else assert.notEqual(r.isError,true,name+' returned error');return v;}
async function run(){
  portal=mcp(TRUSTED_PORTAL_ENDPOINT,{fetch:scopedPublicMcpFetch(TRUSTED_PORTAL_ENDPOINT,fetch,pair)});
  await portal.client.connect(portal.transport);
  const cand=(await portal.client.listTools()).tools.find(t=>t.name==='ima_list_notebooks');
  assert.ok(cand&&cand.annotations?.readOnlyHint===true&&cand.annotations?.destructiveHint!==true,'IMA read-only contract missing');
  if(dedicated){
    const listed=await api('GET','/accounts/'+account+'/workers/scripts');
    assert.ok(Array.isArray(listed)&&!listed.some(x=>x.id===name||x.name===name),
      'dedicated disposable Worker name is already in use');
  }
  const created=await api('POST','/accounts/'+account+'/d1/database',{name});dbId=created.uuid;
  assert.match(dbId,/^[a-f0-9-]{36}$/i);console.log('DISPOSABLE_DB_CREATED',name);
  writeFileSync(new URL('../'+file,import.meta.url),JSON.stringify({name,main:'tests/fixtures/github-product-test-entry.ts',compatibility_date:'2026-09-10',workers_dev:true,preview_urls:false,keep_vars:false,vars:{MCP_PORTAL_ENDPOINT:TRUSTED_PORTAL_ENDPOINT,
 GITHUB_EXECUTOR_REPOSITORY:process.env.GITHUB_REPOSITORY,
 GITHUB_EXECUTOR_REPOSITORY_ID:process.env.GITHUB_REPOSITORY_ID,
 GITHUB_EXECUTOR_REF:process.env.GITHUB_REF,
 GITHUB_EXECUTOR_AUDIENCE:'workflow-github-claim:test',GITHUB_TEST_WORKER_NAME:name,
 ...(dedicated?{GITHUB_TEST_DEDICATED_EXECUTOR:'true'}:{}),
 GITHUB_TEST_EXPECTED_TOKEN_SHA256:createHash('sha256').update(need('GITHUB_TOKEN')).digest('hex')},d1_databases:[{binding:'DB',database_name:name,database_id:dbId,migrations_dir:'migrations'}],workflows:[{name,binding:'WORKFLOW',class_name:'WorkflowOrchestrator'}]}));
  wr(['d1','migrations','apply',name,'--remote','--config',file]);
  attempted=true;
  try{wr(['deploy','--config',file]);}
  catch(error){
    // Cloudflare occasionally exposes a newly uploaded disposable Worker
    // before its workers.dev subdomain endpoint can see it (10007). Retry
    // ONLY the same declarative upload, never a Workflow Run or GitHub Job.
    const message=String(error);
    if(!message.includes('/subdomain')||!message.includes('10007'))throw error;
    console.log('GITHUB_WORKER_SUBDOMAIN_PROPAGATION_RETRY',name);
    await pause(8500);
    wr(['deploy','--config',file]);
  }
  for(const [key,val] of Object.entries({MCP_ACCESS_TOKEN:ownerToken,MCP_PORTAL_CLIENT_ID:pair.clientId,MCP_PORTAL_CLIENT_SECRET:pair.clientSecret,WORKFLOW_GITHUB_DISPATCH_TOKEN:need('GITHUB_TOKEN')}))wr(['secret','put',key,'--config',file],val);
  console.log('DISPOSABLE_WORKER_READY',name);
  // Each 'wrangler secret put' can publish another Worker version.
  // Require consecutive read-only health checks after all secret writes
  // before ANY state-mutating MCP request. Never retry a create/publish.
  let stable=0;
  for(let i=0;i<25&&stable<3;i++){
    try{
      const response=await fetch('https://'+name+'.aiyaya.workers.dev/health',{
        method:'GET',signal:AbortSignal.timeout(5500),
      });
      if(response.status===200&&((await response.json())?.ok===true))stable++;
      else stable=0;
    }catch{stable=0;}
    if(stable<3)await pause(2200);
  }
  assert.equal(stable,3,'disposable_worker_route_unstable_after_secrets');
  console.log('GITHUB_PRODUCT_STABLE_WORKER_HEALTH_OK',name);
  // Fail closed before Draft/Publish/Run if the temporary Worker did not
  // receive exactly the same Runner token with GitHub actions:write access.
  // This route exists only in the disposable test wrapper, not product code.
  let validIdentity=false;
  for(let i=0;i<3;i++){
    const check=await fetch('https://'+name+'.aiyaya.workers.dev/__test/github-identity',{
      headers:{authorization:'Bearer '+ownerToken},signal:AbortSignal.timeout(15000),
    });
    assert.equal(check.status,200,'read-only test credential probe unavailable');
    const observed=await check.json();
    if(observed.tokenMatches===true&&observed.readStatus===200&&
       observed.invalidDispatchStatus===422){
      validIdentity=true;
      break;
    }
    console.log('GITHUB_PRODUCT_GITHUB_CREDENTIAL_GATE_PENDING',
      JSON.stringify({matching:observed.tokenMatches,read:observed.readStatus,
        deniedBranch:observed.invalidDispatchStatus}));
    if(i<2)await pause(9000);
  }
  assert.ok(validIdentity,'GitHub product Worker GitHub credential gate not ready');
  console.log('GITHUB_PRODUCT_GITHUB_CREDENTIAL_GATE_OK',name);
  let connected=false;for(let i=0;i<15;i++){
    const instance=mcp(endpoint,{requestInit:{headers:{authorization:'Bearer '+ownerToken}}});
    try{await instance.client.connect(instance.transport);owner=instance.client;connected=true;break;}catch{await instance.client.close().catch(()=>{});await pause(2000);}
  }assert.ok(connected,'Isolated Worker unavailable');
  const definition={version:1,name:'isolated-mcp-github-'+suffix,steps:[
    {id:'read',uses:'mcp.call',with:{
      endpoint:TRUSTED_PORTAL_ENDPOINT,tool:'ima_list_notebooks',scope:'read',
      input_schema:cand.inputSchema,
      ...(cand.outputSchema?{output_schema:cand.outputSchema}:{}),arguments:{limit:1}}},
    {id:'heavy',needs:['read'],uses:'github.run',
      with:{capability:'github.workflow.check'}},
    {id:'emit',needs:['heavy'],uses:'result.emit',
      with:{data:{ref:'steps.heavy.output'}}},
  ]};
  const draft=await tool('workflow_create',{definition:JSON.stringify(definition)});
  const validation=await tool('workflow_validate',{workflow_id:draft.workflow_id,revision:1});
  assert.equal(validation.valid,true);
  assert.equal(validation.required_approvals?.length,1);
  assert.equal(validation.requires_heavy_execution_approval,true);
  assert.deepEqual(validation.required_approvals[0],{
    endpoint:TRUSTED_PORTAL_ENDPOINT,tool:'ima_list_notebooks',scope:'read',
    schema_digest:await toolSchemaDigest(cand.inputSchema,cand.outputSchema)});
  const base={workflow_id:draft.workflow_id,expected_revision:1};
  await tool('workflow_publish',{...base,
    approved_operations:validation.required_approvals,
    accept_target_risks:true},'github_execution_approval_required');
  await tool('workflow_publish',{...base,
    approved_operations:[],accept_target_risks:true,
    approve_heavy_execution:true},'external_approval_required');
  const published=await tool('workflow_publish',{...base,
    approved_operations:validation.required_approvals,
    accept_target_risks:true,approve_heavy_execution:true});
  assert.ok(published.published_version_id);
  const params={workflow_id:draft.workflow_id,inputs:{},idempotency_key:'github-plan-'+suffix};
  const started=await tool('workflow_run',params);runId=started.run_id;
  console.log('GITHUB_PRODUCT_WORKFLOW_RUN_STARTED',name);
  async function readOnlyResult(){
    for(let attempt=0;attempt<3;attempt++){
      try{return await tool('workflow_result',{run_id:runId});}
      catch(error){
        // Only idempotent result reads may retry. An ambiguous workflow_run
        // or GitHub dispatch is never repeated.
        if(!/Request timed out/i.test(String(error)))throw error;
        console.log('GITHUB_PRODUCT_READONLY_RESULT_TIMEOUT',attempt+1);
        try{
          const queried=await api('POST',
            '/accounts/'+account+'/d1/database/'+dbId+'/query',{
              sql:'SELECT outcome,error_code FROM runs WHERE id=?',
              params:[runId],
            });
          const row=queried[0]?.results?.[0]??null;
          console.log('GITHUB_PRODUCT_D1_READONLY_STATUS',
            JSON.stringify(row?{status:row.outcome,error_code:row.error_code}:null));
        }catch{console.log('GITHUB_PRODUCT_D1_READONLY_STATUS_UNAVAILABLE');}
        if(attempt===2)throw error;
        await pause(2500);
      }
    }
    throw Error('result_read_exhausted');
  }
  let outcome;
  for(let i=0;i<170;i++){
    outcome=await readOnlyResult();
    if(['succeeded','failed','indeterminate','cancelled'].includes(outcome.status))break;
    await pause(1000);
  }
  if(outcome?.status!=='succeeded'){
    const safe=outcome?.steps?.map(s=>({
      step:s.step_id,status:s.status,error_code:s.error_code||null,
    }))||[];
    console.log('GITHUB_PRODUCT_RUN_FAILURE_STATE',
      JSON.stringify({status:outcome?.status,error_code:outcome?.error_code||null,steps:safe}));
  }
  assert.equal(outcome.status,'succeeded',
    'MCP+GitHub Product Run failed: '+String(outcome?.error_code||outcome?.status));
  assert.equal(outcome.steps.length,3);
  assert.ok(outcome.steps.every(s=>s.status==='succeeded'));
  assert.equal(outcome.result?.source,
    dedicated?'workflow-github-executor':'separate-github-workflow-dispatch');
  assert.equal(outcome.result?.echo,'ok');
  assert.equal((await tool('workflow_run',params)).run_id,runId);
  console.log('GITHUB_PRODUCT_MCP_PORTAL_GITHUB_WORKFLOW_RESULT_PASS',name);

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
  if(!/^workflow-github-plan-[a-f0-9]{10}$/.test(name))
    throw Error('Unsafe cleanup identity');
  const result=spawnSync('node',['tests/github-disposable-cleanup.mjs',name],{
    cwd,timeout:90000,encoding:'utf8',
    env:process.env,
  });
  try{unlinkSync(new URL('../'+file,import.meta.url));}catch{}
  if(result.status!==0)throw Error('GITHUB_PRODUCT_DISPOSABLE_CLEANUP_FAILED '+name+
    ' exit '+String(result.status));
  console.log('GITHUB_PRODUCT_DISPOSABLE_CLEANUP_OK',name);
}

let failure;
try{await run()}catch(e){failure=e;console.error('GITHUB_PRODUCT_CLOUD_E2E_FAILED',String(e.message).replaceAll(cf,'[redacted]').replaceAll(pair.clientSecret,'[redacted]'),'name='+name);}
finally{try{await cleanup();}catch(e){failure??=e;console.error(String(e.message));}}
// CLI has completed all awaited cleanup. Close lingering SDK/HTTP handles rather
// than letting a successful test hang until GitHub cancels the entire job.
process.exit(failure?1:0);
