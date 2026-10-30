/**
 * Isolated Action Task result acceptance: a real GitHub-hosted OIDC JWT and
 * a disposable Cloudflare D1, exercising the actual ingress implementation.
 * This runner-side invocation intentionally does NOT prove production routing
 * or WAF. No production Worker or D1 is touched.
 */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {writeFileSync,unlinkSync} from 'node:fs';
import {registerHooks} from 'node:module';

const required=name=>{const value=process.env[name];assert.ok(value,'Missing '+name);return value;};
const apiToken=required('CLOUDFLARE_API_TOKEN');
const account=required('CLOUDFLARE_ACCOUNT_ID');
const repository=required('GITHUB_REPOSITORY');
const repositoryId=Number(required('GITHUB_REPOSITORY_ID'));
const ref=required('GITHUB_REF');
const workflowRef=required('GITHUB_WORKFLOW_REF');
const sha=required('GITHUB_SHA');
const runNumber=Number(required('GITHUB_RUN_ID'));
const runAttempt=Number(required('GITHUB_RUN_ATTEMPT'));
assert.equal(repository,'lirtual/mcp-workers');
assert.equal(ref,'refs/heads/main');
assert.equal(workflowRef,repository+'/.github/workflows/acceptance.yml@'+ref);
assert.equal(runAttempt,1,'reruns require a fresh signed identity');
assert.match(sha,/^[0-9a-f]{40}$/i);
assert.ok(Number.isSafeInteger(runNumber)&&runNumber>0&&Number.isSafeInteger(repositoryId));
const audience='workflow-github-action:isolated';
const suffix=randomBytes(5).toString('hex');
const name='workflow-action-result-'+suffix;
const config='wrangler.action-result-'+suffix+'.json';
const root='/accounts/'+account;
const directory=new URL('..',import.meta.url);
let databaseId=null;
const attemptId=randomUUID(),dispatchId=randomUUID();
const workflowId=randomUUID(),versionId=randomUUID(),runId=randomUUID();
function show(error) {
  return String(error instanceof Error?error.message:'unknown').replaceAll(apiToken,'[redacted]');
}
async function api(method,path,body) {
  const response=await fetch('https://api.cloudflare.com/client/v4'+path,{
    method,headers:{authorization:'Bearer '+apiToken,'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
    signal:AbortSignal.timeout(30000),
  });
  const value=await response.json().catch(()=>null);
  if(!response.ok||value?.success!==true)throw Error('Cloudflare '+method+' HTTP '+response.status);
  return value.result;
}
async function query(sql,params=[]) {
  const results=await api('POST',root+'/d1/database/'+databaseId+'/query',{sql,params});
  assert.equal(results[0]?.success,true,'D1 query failed');
  return results[0];
}
function adapter(){
  return {prepare(sql){
    let params=[];
    return {
      bind(...values){params=values;return this;},
      async first(){return (await query(sql,params)).results?.[0]??null;},
      async run(){const result=await query(sql,params);return {meta:{changes:result.meta?.changes??0}};},
    };
  }};
}
async function githubOidc(customAudience){
  const endpoint=new URL(required('ACTIONS_ID_TOKEN_REQUEST_URL'));
  endpoint.searchParams.set('audience',customAudience);
  const response=await fetch(endpoint,{headers:{
    authorization:'Bearer '+required('ACTIONS_ID_TOKEN_REQUEST_TOKEN')},
    signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('GitHub OIDC issuance HTTP '+response.status);
  const payload=await response.json();
  assert.ok(typeof payload.value==='string'&&payload.value.length>150);
  return payload.value;
}
async function request(ingress,path,jwt,body,expected){
  const response=await ingress(new Request('https://isolated.invalid'+path,{
    method:'POST',headers:{authorization:'Bearer '+jwt,'content-type':'application/json'},
    body:JSON.stringify(body),
  }),{DB:adapter(),GITHUB_ACTION_OIDC_AUDIENCE:audience});
  assert.equal(response.status,expected.status,'HTTP '+path);
  const value=await response.json();
  assert.equal(value.result,expected.code,'result '+path);
}
async function run(){
  const created=await api('POST',root+'/d1/database',{name});
  databaseId=created.uuid;
  assert.match(databaseId,/^[0-9a-f-]{36}$/i);
  const cfg={name,main:'src/index.ts',compatibility_date:'2026-09-10',
    d1_databases:[{binding:'DB',database_name:name,database_id:databaseId,
      migrations_dir:'migrations'}]};
  writeFileSync(new URL('../'+config,import.meta.url),JSON.stringify(cfg));
  const migrated=spawnSync('pnpm',['exec','wrangler','d1','migrations','apply',
    name,'--remote','--config',config],{
    cwd:directory.pathname,encoding:'utf8',timeout:120000,
    env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},
  });
  if(migrated.status!==0)throw Error('Disposable D1 migrations failed '+migrated.status);
  const reviewed={repository,repositoryId,workflowId:1,
    workflowPath:'.github/workflows/acceptance.yml',commitSha:sha,
    type:'task',contractDigest:'b'.repeat(64)};
  const plan={version:1,name:'Isolated Task callback',github_execution_approved:true,
    github_action_approvals:[reviewed],steps:[{id:'verify',uses:'github.run',
      needs:[],with:{capability:'github.action',
        action:{...reviewed,ref,inputs:{}}}}]};
  const now=Date.now();
  await query('INSERT INTO workflows (id,name,draft,draft_revision,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    [workflowId,'isolated Task callback','{}',1,'active',now,now]);
  await query('INSERT INTO workflow_versions (id,workflow_id,digest,plan,created_at) VALUES (?,?,?,?,?)',
    [versionId,workflowId,'isolated',JSON.stringify(plan),now]);
  await query("INSERT INTO runs (id,workflow_id,version_id,instance_id,request_digest,inputs,outcome,created_at,updated_at) VALUES (?,?,?,?,?,?,'running',?,?)",
    [runId,workflowId,versionId,'instance-'+suffix,'isolated','{}',now,now]);
  await query("INSERT INTO step_attempts (attempt_id,run_id,step_id,capability_id,dispatch_id,state,repository,repository_id,workflow_ref,ref,candidate_run_id,candidate_run_attempt,created_at,updated_at) VALUES (?,?,'verify','github.action',?,'confirmed',?,?,?,?,?,?,?,?)",
    [attemptId,runId,dispatchId,repository,String(repositoryId),workflowRef,ref,
      runNumber,runAttempt,now,now]);
  // Source is the production handler. No custom verifier and no test-only
  // signing keys: jwtVerify retrieves GitHub's published OIDC JWKS.
  const {handleGithubActionClaimRequest}=await import('../src/github-action-ingress.ts');
  const ingress=handleGithubActionClaimRequest;
  const valid=await githubOidc(audience);
  const wrong=await githubOidc('workflow-github-action:wrong');
  await request(ingress,'/github/action/claim',wrong,{attemptId},{status:403,code:'claim_denied'});
  await request(ingress,'/github/action/claim',valid,{attemptId},{status:200,code:'claimed'});
  const result={verification:'passed',count:2};
  const body={attemptId,result};
  await request(ingress,'/github/action/result',wrong,body,{status:403,code:'result_denied'});
  await request(ingress,'/github/action/result',valid,body,{status:200,code:'recorded'});
  const original=(await query('SELECT callback_id,outcome,result_json FROM callback_receipts WHERE attempt_id=?',[attemptId])).results?.[0];
  assert.ok(original?.callback_id);
  assert.equal(original.outcome,'succeeded');
  assert.deepEqual(JSON.parse(original.result_json),result);
  await request(ingress,'/github/action/result',valid,body,{status:200,code:'already_recorded'});
  await request(ingress,'/github/action/result',valid,{
    attemptId,result:{verification:'forged'}
  },{status:403,code:'result_denied'});
  await request(ingress,'/github/action/result',valid,{
    attemptId,result:{data:'x'.repeat(4097)}
  },{status:400,code:'invalid_result'});
  const receipt=(await query('SELECT callback_id,outcome,result_json FROM callback_receipts WHERE attempt_id=?',[attemptId])).results;
  assert.equal(receipt.length,1);
  assert.deepEqual(receipt[0],original);
  const attempt=(await query('SELECT state,owner_run_id,owner_run_attempt FROM step_attempts WHERE attempt_id=?',[attemptId])).results[0];
  assert.equal(attempt.state,'claimed','A business callback cannot finalize the physical job');
  assert.equal(attempt.owner_run_id,runNumber);
  assert.equal(attempt.owner_run_attempt,runAttempt);
  const parent=(await query('SELECT outcome FROM runs WHERE id=?',[runId])).results[0];
  assert.equal(parent.outcome,'running');
  await verifyApprovalFenceOnIsolatedD1();
  console.log('GITHUB_ACTION_REAL_OIDC_CLOUD_D1_TASK_RESULT_PASS');
  console.log('GITHUB_ACTION_RECORDED_REPLAY_CONFLICT_AND_PHYSICAL_FENCE_PASS');
}

/**
 * Spec #176: exercise the exact durable Run/Attempt predicates against remote,
 * disposable Cloudflare D1. The GitHub HTTP callback is ALWAYS mocked: this
 * never sends a physical Task, touches production D1, or retries an unknown
 * external effect. This is NOT a full native production approval/cancel E2E.
 */
async function verifyApprovalFenceOnIsolatedD1(){
  const {registerAndDispatchGitHubAction}=await import('../src/github-action-orchestration.ts');
  const reviewed={
    repository:'lirtual/session-actions',repositoryId:1430925009,
    workflowId:394689660,workflowPath:'.github/workflows/verify-action.yml',
    commitSha:'5ae1862afd94c01493dae0ec5ecf5568f664b849',
    type:'task',contractDigest:'592d41734af48fb4e37b44708eba0b68593cbed011915829edd8ed7c9b890845',
  };
  const tag='refs/tags/v0.1.42-rc.1';
  const inputs={outcome:'success'};
  const reviewedStep={id:'verify',uses:'github.run',needs:[],
    approval:{required:true},
    with:{capability:'github.action',action:{...reviewed,ref:tag,inputs}}};
  const plan={version:1,name:'Isolated D1 cancellation fence',
    github_execution_approved:true,github_action_approvals:[reviewed],steps:[reviewedStep]};
  const workflowId=randomUUID(),versionId=randomUUID(),created=Date.now();
  await query('INSERT INTO workflows (id,name,draft,draft_revision,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    [workflowId,'isolated approval fence','{}',1,'active',created,created]);
  await query('INSERT INTO workflow_versions (id,workflow_id,digest,plan,created_at) VALUES (?,?,?,?,?)',
    [versionId,workflowId,'isolated-approval-fence',JSON.stringify(plan),created]);

  async function createApprovedRun(){
    const id=randomUUID(),at=Date.now();
    await query("INSERT INTO runs (id,workflow_id,version_id,instance_id,request_digest,inputs,start_state,outcome,created_at,updated_at) VALUES (?,?,?,?,?,?,'started','running',?,?)",
      [id,workflowId,versionId,id,'isolated-fence','{}',at,at]);
    await query("INSERT INTO run_steps (run_id,step_id,status,updated_at) VALUES (?,'verify','running',?)",[id,at]);
    await query("INSERT INTO runtime_approval_gates (run_id,step_id,version_id,deadline_at) VALUES (?,'verify',?,?)",
      [id,versionId,at+600000]);
    await query("INSERT INTO runtime_approvals (run_id,step_id,version_id,decision,created_at,consumed_at) VALUES (?,'verify',?,'approved',?,?)",
      [id,versionId,at,at]);
    return id;
  }
  // Match the production store.ts approval-cancellation durable Run CAS.
  // This isolated proof tests the Run and Attempt fence; native wake/physical
  // GitHub cancellation are covered separately and are not claimed here.
  async function cancelBeforeAttempt(id){
    const updated=await query(`
      UPDATE runs SET outcome='cancelled',error_code='approval_cancel_requested',updated_at=?
      WHERE id=? AND outcome='running'
      AND EXISTS(SELECT 1 FROM run_steps s WHERE s.run_id=runs.id
        AND s.step_id='verify' AND s.status IN ('waiting_approval','running'))
      AND NOT EXISTS(SELECT 1 FROM step_attempts a WHERE a.run_id=runs.id
        AND a.step_id='verify')
      AND NOT EXISTS(SELECT 1 FROM run_steps s WHERE s.run_id=runs.id
        AND s.step_id<>'verify' AND s.status IN ('running','waiting','waiting_approval'))`,
      [Date.now(),id]);
    const changed=updated.meta?.changes??0;
    assert.ok(changed===0||changed===1,'Unexpected approval-cancel CAS count');
    if(changed===1){
      const step=await query("UPDATE run_steps SET status='cancelled',error_code='approval_cancel_requested',updated_at=? WHERE run_id=? AND step_id='verify' AND status IN ('waiting_approval','running') AND EXISTS(SELECT 1 FROM runs WHERE id=? AND outcome='cancelled' AND error_code='approval_cancel_requested')",
        [Date.now(),id,id]);
      assert.equal(step.meta?.changes,1,'Cancelled Step must be durably recorded');
    }
    return changed;
  }
  async function dispatchMock(id){
    const outbound=[];
    const attemptId=randomUUID(),dispatchId=randomUUID();
    try{
      const result=await registerAndDispatchGitHubAction(adapter(),{
        runId:id,stepId:'verify',attemptId,dispatchId,
        action:reviewed,ref:tag,token:'isolated-mock-only',inputs,
      },async request=>{
        assert.equal(new URL(request.url).hostname,'api.github.com',
          'No outbound request may reach another origin');
        outbound.push(request.method);
        if(request.method==='GET')return new Response(JSON.stringify({
          ref:tag,object:{type:'commit',sha:reviewed.commitSha},
        }),{status:200});
        assert.equal(request.method,'POST','Only a single GitHub POST is allowed');
        return new Response(JSON.stringify({workflow_run_id:9876}),{status:200});
      });
      return {result,outbound};
    }catch(error){return {error:String(error),outbound};}
  }
  async function readFence(id){
    const state=(await query('SELECT outcome FROM runs WHERE id=?',[id])).results?.[0];
    const attempts=(await query('SELECT state FROM step_attempts WHERE run_id=?',[id])).results;
    return {outcome:state?.outcome,attempts};
  }
  async function assertSingleWinner(id,changed,dispatch){
    const state=await readFence(id);
    if(changed===1){
      assert.equal(state.outcome,'cancelled','Cancel-won Run must be terminal');
      assert.equal(state.attempts.length,0,'No Attempt may follow cancellation');
      assert.equal(dispatch.result,undefined,'Cancel-won case cannot dispatch');
      assert.match(dispatch.error,/github_action_publication_missing|github_action_attempt_not_registered/);
      assert.deepEqual(dispatch.outbound,[],'Cancel-won case must not call GitHub even through a mock');
    }else{
      assert.equal(state.outcome,'running','Registered Attempt cannot be pre-dispatch cancelled');
      assert.equal(state.attempts.length,1,'Exactly one durable Attempt required');
      assert.equal(state.attempts[0].state,'confirmed');
      assert.equal(dispatch.result?.status,'confirmed','Mocked dispatch should confirm');
      assert.deepEqual(dispatch.outbound,['GET','POST'],'Exactly one mocked dispatch expected');
    }
  }
  const cancelFirst=await createApprovedRun();
  const cancelled=await cancelBeforeAttempt(cancelFirst);
  assert.equal(cancelled,1,'Cancellation must win when no Attempt exists');
  await assertSingleWinner(cancelFirst,cancelled,await dispatchMock(cancelFirst));

  const attemptFirst=await createApprovedRun();
  const dispatched=await dispatchMock(attemptFirst);
  const unchanged=await cancelBeforeAttempt(attemptFirst);
  assert.equal(unchanged,0,'Cancellation cannot overwrite an existing Attempt');
  await assertSingleWinner(attemptFirst,unchanged,dispatched);

  const races=6;
  let cancellations=0,attempts=0;
  for(let i=0;i<races;i++){
    const id=await createApprovedRun();
    // Independent live D1 API requests race for one Run row.
    const [changed,dispatch]=await Promise.all([
      cancelBeforeAttempt(id),dispatchMock(id),
    ]);
    await assertSingleWinner(id,changed,dispatch);
    if(changed===1)cancellations++;else attempts++;
  }
  assert.equal(cancellations+attempts,races);
  console.log('APPROVAL_CANCEL_DISPOSABLE_D1_FENCE_PASS: cancel-first, attempt-first, '+races+
    ' concurrent CAS attempts; all GitHub GET/POST mocked; no production writes');
}

async function cleanup(){
  if(databaseId){
    await api('DELETE',root+'/d1/database/'+databaseId);
    try{
      await api('GET',root+'/d1/database/'+databaseId);
      throw Error('Disposable D1 still present');
    }catch(e){
      if(String(e.message)==='Disposable D1 still present')throw e;
      if(!String(e.message).includes('HTTP 404'))throw e;
    }
    console.log('GITHUB_ACTION_DISPOSABLE_D1_CLEANUP_OK');
  }
  try{unlinkSync(new URL('../'+config,import.meta.url));}catch{}
}
let failed=false;
try{await run();}catch(e){failed=true;console.error('GITHUB_ACTION_CLOUD_ACCEPTANCE_FAILED',show(e));}
finally{try{await cleanup();}catch(e){failed=true;console.error('GITHUB_ACTION_D1_CLEANUP_FAILED',show(e));}}
process.exit(failed?1:0);
