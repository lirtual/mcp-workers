/**
 * Manual, branch-locked proof: REAL GitHub-hosted OIDC JWT -> temporary
 * Cloudflare Worker -> REAL D1 atomic Claim -> durable callback.
 *
 * The GitHub Actions job is its own CONFIRMED physical candidate for this
 * isolation fixture; this DOES NOT prove production dispatch acknowledgement
 * or a separate external heavy executor. No GitHub secret leaves the Runner.
 * The GitHub token is only sent to this disposable verifier via HTTPS.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import {
  registerGithubAttempt,recordGithubDispatchResult,
} from '../src/github-claim.ts';
import { dispatchGithubAttempt } from '../src/github-dispatch.ts';

const get=k=>{const v=process.env[k];assert.ok(v,'Missing '+k);return v;};
const token=get('CLOUDFLARE_API_TOKEN');
const account=get('CLOUDFLARE_ACCOUNT_ID');
const repo=get('GITHUB_REPOSITORY');
const repositoryId=get('GITHUB_REPOSITORY_ID');
const ref=get('GITHUB_REF');
const workflowRef=get('GITHUB_WORKFLOW_REF');
const githubRunId=Number(get('GITHUB_RUN_ID'));
const githubRunAttempt=Number(get('GITHUB_RUN_ATTEMPT'));
assert.equal(repo,'lirtual/mcp-workers');
assert.equal(ref,'refs/heads/wip/workflow-github-executor');
assert.equal(workflowRef,repo+'/.github/workflows/ci.yml@'+ref);
assert.equal(githubRunAttempt,1,'reruns are intentionally not pre-authorized');
assert.ok(Number.isSafeInteger(githubRunId)&&githubRunId>0);
assert.match(repositoryId,/^\d+$/);
const suffix=randomBytes(5).toString('hex');
const name='workflow-github-oidc-'+suffix;
const dir=new URL('..',import.meta.url).pathname;
const file='wrangler.github-oidc-'+suffix+'.json';
const url='https://'+name+'.aiyaya.workers.dev';
const audience='workflow-github-claim:test';
const independent=process.env.GITHUB_INDEPENDENT_DISPATCH==='true';
const workflowId='w-'+suffix,versionId='v-'+suffix,runId='r-'+suffix;
const attemptId=randomUUID(),dispatchId=randomUUID(),callbackId=randomUUID();
let databaseId=null,deployAttempted=false;
const root='/accounts/'+account;
function cleanError(error){
  // No credential, JWT, SQL or Cloudflare error body in Action logs.
  return error instanceof Error?error.message.replaceAll(token,'[REDACTED]'):'unknown';
}
async function api(method,path,body){
  const response=await fetch('https://api.cloudflare.com/client/v4'+path,{
    method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},
    ...(body!==undefined?{body:JSON.stringify(body)}:{}),
    signal:AbortSignal.timeout(25000),
  });
  const value=await response.json().catch(()=>null);
  if(!response.ok||value?.success!==true)
    throw Error('Cloudflare '+method+' failed HTTP '+response.status);
  return value.result;
}
async function d1(sql,params=[]){
  const result=await api('POST',root+'/d1/database/'+databaseId+'/query',{sql,params});
  assert.ok(Array.isArray(result)&&result[0]?.success!==false,'D1 query invalid');
  return result[0];
}
function wr(args){
  const result=spawnSync('pnpm',['exec','wrangler',...args],{
    cwd:dir,timeout:90000,encoding:'utf8',maxBuffer:1024*1024,
    env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},
  });
  if(result.status!==0)throw Error('Wrangler '+args[0]+' failed exit '+String(result.status));
}
function cloudD1Adapter(){
  return {
    prepare(sql){return {
      bind(...params){return {
        async run(){
          const result=await d1(sql,params);
          return {meta:{changes:result.meta?.changes??0}};
        },
      };},
    };}
  };
}
async function actualOidc(aud){
  const u=new URL(get('ACTIONS_ID_TOKEN_REQUEST_URL'));
  u.searchParams.set('audience',aud);
  const result=await fetch(u,{
    headers:{authorization:'Bearer '+get('ACTIONS_ID_TOKEN_REQUEST_TOKEN')},
    signal:AbortSignal.timeout(15000),
  });
  if(!result.ok)throw Error('GitHub hosted OIDC issuance failed HTTP '+result.status);
  const doc=await result.json();
  assert.ok(doc?.value?.length>150,'Missing GitHub-issued JWT');
  return doc.value;
}
async function invoke(path,jwt,body,expected){
  const response=await fetch(url+path,{
    method:'POST',headers:{authorization:'Bearer '+jwt,'content-type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(30000),
  });
  assert.equal(response.status,expected,path+' returned unexpected HTTP '+response.status);
  return response;
}
async function run(){
  assert.match(name,/^workflow-github-oidc-[a-f0-9]{10}$/);
  const created=await api('POST',root+'/d1/database',{name});
  databaseId=created.uuid;
  assert.match(databaseId,/^[a-f0-9-]{36}$/i);
  console.log('GITHUB_DISPOSABLE_D1_CREATED',name);
  const config={
    name,main:'tests/fixtures/github-oidc-worker.ts',
    compatibility_date:'2026-09-10',workers_dev:true,preview_urls:false,
    keep_vars:false,
    vars:{
      EXPECTED_REPO:repo,EXPECTED_REPOSITORY_ID:repositoryId,
      EXPECTED_WORKFLOW_REF:workflowRef,EXPECTED_REF:ref,
      EXPECTED_AUDIENCE:audience,
    },
    d1_databases:[{binding:'DB',database_name:name,
      database_id:databaseId,migrations_dir:'migrations'}],
    workflows:[{binding:'WORKFLOW',name,class_name:'S3ReceiptWaiter'}],
  };
  writeFileSync(new URL('../'+file,import.meta.url),JSON.stringify(config));
  wr(['d1','migrations','apply',name,'--remote','--config',file]);
  deployAttempted=true;
  wr(['deploy','--config',file]);
  console.log('GITHUB_DISPOSABLE_WORKER_DEPLOYED',name);
  // Coordinator seeds a confirmed candidate tied to its current GitHub run
  // before asking GitHub to mint the OIDC token. This is an isolated test
  // harness; production must persist a real REST dispatch acknowledgement.
  const t=Date.now();
  await d1('INSERT INTO workflows (id,name,draft,created_at,updated_at) VALUES (?,?,?,?,?)',
    [workflowId,'GitHub isolated OIDC proof','{}',t,t]);
  await d1('INSERT INTO workflow_versions (id,workflow_id,digest,plan,created_at) VALUES (?,?,?,?,?)',
    [versionId,workflowId,'test','{}',t]);
  await d1(`INSERT INTO runs(id,workflow_id,version_id,instance_id,
    request_digest,inputs,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
    [runId,workflowId,versionId,'instance-'+suffix,'test','{}',t,t]);
  const db=cloudD1Adapter();
  await registerGithubAttempt(db,{
    repository:repo,repositoryId,workflowRef,ref,audience,
    attemptId,dispatchId,runId,stepId:'heavy',
    capabilityId:'github.workflow.check',
  });
  if(independent){
    const githubToken=get('GITHUB_TOKEN');
    const candidate=await dispatchGithubAttempt({
      repository:repo,workflow:'ci.yml',ref,
      workerName:name,dispatchToken:githubToken,
    },{attemptId,dispatchId,capabilityId:'github.workflow.check'});
    const saved=await recordGithubDispatchResult(db,attemptId,candidate);
    assert.equal(saved,true,'Dispatch result not saved');
    assert.equal(candidate.status,'confirmed','Independent GitHub dispatch did not confirm a Run ID');
    assert.notEqual(candidate.runId,githubRunId,'Executor must be a separate GitHub run');
    console.log('GITHUB_INDEPENDENT_GITHUB_REST_DISPATCH_CONFIRMED');
    let finished=null;
    for(let i=0;i<150;i++){
      const row=(await d1('SELECT outcome,result FROM runs WHERE id=?',[runId])).results?.[0];
      if(row?.outcome==='succeeded'){finished=row;break;}
      if(row?.outcome==='failed')throw Error('Independent executor native Workflow failed');
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    assert.ok(finished,'Independent executor did not complete');
    assert.equal(JSON.parse(finished.result).source,'separate-github-workflow-dispatch');
    const claimed=(await d1('SELECT state,owner_run_id,owner_run_attempt FROM step_attempts WHERE attempt_id=?',[attemptId])).results?.[0];
    assert.equal(claimed.state,'claimed');
    assert.equal(claimed.owner_run_id,candidate.runId);
    assert.equal(claimed.owner_run_attempt,1);
    const receipt=(await d1('SELECT notification_delivered,result_json FROM callback_receipts WHERE attempt_id=?',[attemptId])).results?.[0];
    assert.equal(receipt.notification_delivered,1);
    assert.equal(JSON.parse(receipt.result_json).source,'separate-github-workflow-dispatch');
    console.log('GITHUB_INDEPENDENT_DISPATCH_TO_NATIVE_WORKFLOW_RESULT_PASS');
    return;
  }
  assert.equal(await recordGithubDispatchResult(db,attemptId,{
    status:'confirmed',runId:githubRunId,runAttempt:1,
  }),true);
  console.log('GITHUB_CONFIRMED_TEST_CANDIDATE',name);
  const valid=await actualOidc(audience);
  const wrong=await actualOidc('workflow-github-claim:wrong');
  const claim={attemptId};
  // Wait for Cloudflare route propagation; invalid identity must stay denied.
  let accessible=false;
  for(let i=0;i<15;i++){
    try{
      const r=await fetch(url+'/claim',{method:'POST',
        headers:{'content-type':'application/json'},body:'{}',
        signal:AbortSignal.timeout(7000)});
      if(r.status===401){accessible=true;break;}
    }catch{}
    await new Promise(r=>setTimeout(r,2000));
  }
  assert.equal(accessible,true,'GitHub fixture route never became available');
  await invoke('/claim',wrong,claim,403);
  await invoke('/claim',valid,claim,200);
  await invoke('/claim',valid,claim,403);
  console.log('GITHUB_EXECUTOR_OIDC_AND_ATOMIC_CLAIM_PASS');
  await invoke('/start',wrong,claim,403);
  await invoke('/start',valid,claim,202);
  const fact={attemptId,callbackId,outcome:'succeeded',result:{echo:'ok',source:'github-oidc'}};
  await invoke('/callback',wrong,fact,403);
  await invoke('/callback',valid,fact,200);
  await invoke('/callback',valid,fact,200);
  await invoke('/callback',valid,{...fact,result:{echo:'tampered'}},403);
  const rows=(await d1(`SELECT callback_id,outcome,result_json,
    notification_delivered FROM callback_receipts WHERE attempt_id=?`,[attemptId])).results;
  assert.equal(rows?.length,1);
  assert.equal(rows[0].callback_id,callbackId);
  assert.equal(rows[0].outcome,'succeeded');
  assert.equal(JSON.parse(rows[0].result_json).echo,'ok');
  assert.equal(rows[0].notification_delivered,1,'Wake notification must be confirmed');
  const attempts=(await d1(`SELECT owner_run_id,owner_run_attempt,state
    FROM step_attempts WHERE attempt_id=?`,[attemptId])).results;
  assert.equal(attempts?.[0].state,'claimed');
  assert.equal(attempts[0].owner_run_id,githubRunId);
  assert.equal(attempts[0].owner_run_attempt,1);
  console.log('GITHUB_EXECUTOR_SIGNED_CALLBACK_AND_D1_RECEIPT_PASS');
  // The Workflow consumes the event only as a hint. Its own step reads the
  // durable D1 callback and then commits the authoritative Run outcome.
  let finished;
  for(let i=0;i<45;i++){
    const row=(await d1('SELECT outcome,result FROM runs WHERE id=?',[runId])).results?.[0];
    if(row?.outcome==='succeeded'){finished=row;break;}
    if(row?.outcome==='failed')throw Error('Native Workflow returned business failure');
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.equal(finished?.outcome,'succeeded','Native Workflow did not finish');
  assert.equal(JSON.parse(finished.result).echo,'ok');
  console.log('GITHUB_NATIVE_WORKFLOW_RECEIPT_WAKE_AND_RESULT_PASS');
}
async function present(path){
  const response=await fetch('https://api.cloudflare.com/client/v4'+path,{
    headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(18000),
  });
  const value=await response.json().catch(()=>null);
  if(response.status===404||value?.errors?.some(e=>e.code===10007))return false;
  if(!response.ok||value?.success!==true)
    throw Error('Cleanup verification failed HTTP '+response.status);
  return true;
}
async function cleanup(){
  const problems=[];
  if(deployAttempted){
    const path=root+'/workers/scripts/'+name;
    try{
      if(await present(path+'/script-settings'))
        await api('DELETE',path+'?force=true');
      if(await present(path+'/script-settings'))throw Error('worker remains');
    }catch{problems.push('worker');}
  }
  if(deployAttempted){
    const path=root+'/workflows/'+name;
    try{
      if(await present(path))await api('DELETE',path);
      if(await present(path))throw Error('workflow remains');
    }catch{problems.push('workflow');}
  }
  if(databaseId){
    const path=root+'/d1/database/'+databaseId;
    try{
      if(await present(path))await api('DELETE',path);
      if(await present(path))throw Error('database remains');
    }catch{problems.push('d1');}
  }
  try{unlinkSync(new URL('../'+file,import.meta.url));}catch{}
  if(problems.length)throw Error('GITHUB_DISPOSABLE_CLEANUP_FAILED '+name+' '+problems.join(','));
  console.log('GITHUB_DISPOSABLE_CLEANUP_OK',name);
}
let failed=false;
try{await run();}
catch(e){failed=true;console.error('GITHUB_REAL_OIDC_ACCEPTANCE_FAILED',cleanError(e));}
finally{
  try{await cleanup();}
  catch(e){failed=true;console.error(cleanError(e));}
}
process.exit(failed?1:0);
