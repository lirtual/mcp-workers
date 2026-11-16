import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createCipheriv,publicEncrypt,randomBytes,constants,generateKeyPairSync} from 'node:crypto';
import {generateKeyPair,SignJWT} from 'jose';
import {runPublishedGitHubActionTask,recordSignedGitHubActionTaskResult} from '../src/github-action-task.ts';
import {registerAndDispatchGitHubAction} from '../src/github-action-orchestration.ts';
import {WorkflowService} from '../src/store.ts';
import {verifyAndClaimPinnedGitHubAction} from '../src/github-action-oidc-claim.ts';
import {publishedGitHubActionStep,type Plan} from '../src/plan.ts';
import type {Env} from '../src/store.ts';
import type {WorkflowStep} from 'cloudflare:workers';

const runId='11111111-1111-4111-8111-111111111111';
const repo='lirtual/github-actions',ref='refs/tags/task-v1',sha='a'.repeat(40);
const audience='workflow-github-action';
const action={repository:repo,repositoryId:123,workflowId:456,
 workflowPath:'.github/workflows/task.yml',commitSha:sha,type:'task' as const,
 contractDigest:'b'.repeat(64)};
const plan:Plan={version:1,name:'Approved Task',
 github_execution_approved:true,github_action_approvals:[action],
 steps:[{id:'build',uses:'github.run',needs:[],
  with:{capability:'github.action',action:{...action,ref,inputs:{target:'test'}}}}]};
const workflowRef=repo+'/'+action.workflowPath+'@'+ref;
function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec('PRAGMA foreign_keys=ON');
 for(const migration of ['0001_s1.sql','0014_workflow_deletion.sql','0002_native_complete_seen.sql',
  '0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql'])
  db.exec(readFileSync(new URL('../migrations/'+migration,import.meta.url),'utf8'));
 db.exec(readFileSync(new URL('../migrations/0005_github_workflow_check.sql',import.meta.url),'utf8'));
 db.exec('BEGIN');
 db.exec(readFileSync(new URL('../migrations/0006_action_attempt_capabilities.sql',import.meta.url),'utf8'));
 db.exec(readFileSync(new URL('../migrations/0020_github_action_main_sha.sql',import.meta.url),'utf8'));
 db.exec('COMMIT');
 db.exec(readFileSync(new URL('../migrations/0007_session_executions.sql',import.meta.url),'utf8'));
 db.exec(`INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at)
 VALUES('wf','Task','{}',1,'active',1,1);
 INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at)
 VALUES('v','wf','digest','{}',1);
 INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,outcome,created_at,updated_at)
 VALUES('${runId}','wf','v','instance','digest','{}','running',1,1);`);
 db.prepare('UPDATE workflow_versions SET plan=? WHERE id=?').run(JSON.stringify(plan),'v');
 const adapter={prepare:(sql:string)=>({bind:(...args:unknown[])=>({
  first:async()=>db.prepare(sql).get(...args as []),
  run:async()=>({meta:{changes:db.prepare(sql).run(...args as []).changes}}),
 })})} as unknown as D1Database;
 const env={DB:adapter,WORKFLOW_GITHUB_ACTION_IDENTITY:JSON.stringify({repository:action.repository,repositoryId:action.repositoryId,ciWorkflowId:999}),
 WORKFLOW_GITHUB_DISPATCH_TOKEN:'test-token',
  WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE:audience} as Env;
 let sleeps=0,postCount=0;
 const step={do:async(_name:string,_opts:unknown,callback:()=>Promise<unknown>)=>callback(),
  sleep:async()=>{sleeps++;}} as unknown as WorkflowStep;
 return {db,adapter,env,step,post:()=>postCount,recordPost:()=>{postCount++;},sleeps:()=>sleeps};
}
test('Task source-to-result: D1 reservation, dispatch ACK, signed OIDC claim and physical terminal',async()=>{
 const fixture=setup();
 const {privateKey,publicKey}=await generateKeyPair('RS256');
 const signed=await new SignJWT({repository:repo,repository_id:'123',
  workflow_ref:workflowRef,ref,sha,run_id:'42',run_attempt:'1',event_name:'workflow_dispatch'})
  .setProtectedHeader({alg:'RS256'}).setIssuer('https://token.actions.githubusercontent.com')
  .setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(privateKey);
 let claimed=false;
 const http=async(req:Request):Promise<Response>=>{
  const url=new URL(req.url);
  if(url.pathname.endsWith('/git/ref/tags/task-v1'))
   return Response.json({ref,object:{type:'commit',sha}});
  if(req.method==='POST'){
   fixture.recordPost();
   assert.equal(fixture.db.prepare('SELECT state FROM step_attempts').get()?.state,'created');
   const sent=await req.json() as {ref:string;inputs:Record<string,string>};
   assert.equal(sent.ref,'task-v1');
   assert.equal(sent.inputs.target,'test');
   return Response.json({workflow_run_id:42});
  }
  assert.ok(url.pathname.endsWith('/actions/runs/42'));
  const registered=fixture.db.prepare('SELECT attempt_id FROM step_attempts').get() as {attempt_id:string};
  if(!claimed){
   claimed=await verifyAndClaimPinnedGitHubAction(fixture.adapter,registered.attempt_id,
    signed,audience,publicKey);
   assert.equal(claimed,true);
   assert.equal(await recordSignedGitHubActionTaskResult(fixture.adapter,
    registered.attempt_id,signed,audience,{verification:'passed',count:2},publicKey),'recorded');
   assert.equal(await recordSignedGitHubActionTaskResult(fixture.adapter,
    registered.attempt_id,signed,audience,{verification:'passed',count:2},publicKey),'already_recorded');
   assert.equal(await recordSignedGitHubActionTaskResult(fixture.adapter,
    registered.attempt_id,signed,audience,{verification:'forged'},publicKey),'denied');
   assert.equal(await recordSignedGitHubActionTaskResult(fixture.adapter,
    registered.attempt_id,signed,audience,{oversize:'x'.repeat(5000)},publicKey),'denied');
  }
  return Response.json({id:42,workflow_id:456,run_attempt:1,
   repository:{id:123,full_name:repo},path:action.workflowPath,head_branch:'task-v1',
   head_sha:sha,event:'workflow_dispatch',status:'completed',conclusion:'success'});
 };
 try{
  const outcome=await runPublishedGitHubActionTask(fixture.env,plan,plan.steps[0],runId,fixture.step,http);
  assert.deepEqual(outcome,{status:'succeeded',output:{verification:'passed',count:2}});
  assert.equal(fixture.post(),1);
  assert.ok(fixture.sleeps()<=1,'one reconciliation delay is acceptable after a signed receipt');
  assert.equal(fixture.db.prepare('SELECT state FROM step_attempts').get()?.state,'succeeded');
  // Only the WorkflowRunner is permitted to settle the parent business Run.
  assert.equal(fixture.db.prepare('SELECT outcome FROM runs').get()?.outcome,'running');
 }finally{fixture.db.close();}
});
test('native Task sleep and resumed-check errors preserve one external dispatch',async t=>{
 for(const stage of ['sleep','check'] as const){
  await t.test(stage,async()=>{
   const f=setup();
   let checks=0,sleeps=0;
   const http=async(req:Request):Promise<Response>=>{
    if(req.url.includes('/git/ref/'))return Response.json({ref,object:{type:'commit',sha}});
    if(req.method==='POST'){f.recordPost();return Response.json({workflow_run_id:42});}
    checks++;
    return Response.json({id:42,workflow_id:456,run_attempt:1,
     repository:{id:123,full_name:repo},path:action.workflowPath,head_branch:'task-v1',
     head_sha:sha,event:'workflow_dispatch',status:'in_progress',conclusion:null});
   };
   const step={do:async(name:string,_opts:unknown,fn:()=>Promise<unknown>)=>{
     if(stage==='check'&&name==='github-action-check-build-1')
      throw Error('opaque native check failure');
     return fn();
    },sleep:async()=>{
     sleeps++;
     if(stage==='sleep')throw Error('opaque native sleep failure');
    }} as unknown as WorkflowStep;
   try{
    const outcome=await runPublishedGitHubActionTask(f.env,plan,plan.steps[0],runId,step,http);
    assert.deepEqual(outcome,{status:'indeterminate',error_code:stage==='sleep'
     ?'github_action_native_sleep_unconfirmed':'github_action_native_check_unconfirmed'});
    assert.equal(f.post(),1,'unknown native state must not redispatch');
    assert.equal(checks,1);
    assert.equal(sleeps,1);
    assert.equal(f.db.prepare('SELECT state FROM step_attempts').get()?.state,'confirmed');
    assert.equal(f.db.prepare('SELECT outcome FROM runs').get()?.outcome,'running');
   }finally{f.db.close();}
  });
 }
});

test('signed Task result direct CAS distinguishes insert, identical replay and conflicting replay',async()=>{
 const fixture=setup();
 const {privateKey,publicKey}=await generateKeyPair('RS256');
 const signed=await new SignJWT({repository:repo,repository_id:'123',
  workflow_ref:workflowRef,ref,sha,run_id:'42',run_attempt:'1',event_name:'workflow_dispatch'})
  .setProtectedHeader({alg:'RS256'}).setIssuer('https://token.actions.githubusercontent.com')
  .setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const attempt='77777777-7777-4777-8777-777777777777';
 try{
  fixture.db.prepare(`INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,
   dispatch_id,state,repository,repository_id,workflow_ref,ref,
   candidate_run_id,candidate_run_attempt,created_at,updated_at)
   VALUES(?,?,'build','github.action',?,'confirmed',?,?,?,?,42,1,1,1)`)
   .run(attempt,runId,'88888888-8888-4888-8888-888888888888',repo,'123',workflowRef,ref);
  assert.equal(await verifyAndClaimPinnedGitHubAction(fixture.adapter,attempt,
   signed,audience,publicKey),true);
  const send=(value:Record<string,unknown>)=>recordSignedGitHubActionTaskResult(
   fixture.adapter,attempt,signed,audience,value,publicKey);
  // Assertions are deliberately outside any HTTP inspector/reconciliation seam:
  // an inspector can convert assertion failures into unknown and mask bugs.
  assert.equal(await send({verification:'passed',count:2}),'recorded');
  const original=fixture.db.prepare(`SELECT callback_id,outcome,result_json FROM
   callback_receipts WHERE attempt_id=?`).get(attempt) as {
    callback_id:string;outcome:string;result_json:string};
  assert.equal(original.outcome,'succeeded');
  assert.deepEqual(JSON.parse(original.result_json),{verification:'passed',count:2});
  assert.equal(await send({verification:'passed',count:2}),'already_recorded');
  assert.equal(await send({verification:'forged',count:2}),'denied');
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM callback_receipts').get()?.n,1);
  assert.deepEqual(fixture.db.prepare(`SELECT callback_id,outcome,result_json FROM
   callback_receipts WHERE attempt_id=?`).get(attempt),original);
  assert.equal(fixture.db.prepare('SELECT state FROM step_attempts WHERE attempt_id=?')
   .get(attempt)?.state,'claimed'); // A callback is not physical GitHub success.
 }finally{fixture.db.close();}
});

test('unsigned or misidentified Task results cannot be stored as terminal success',async()=>{
 const fixture=setup();
 const {publicKey,privateKey}=await generateKeyPair('RS256');
 const signed=await new SignJWT({repository:repo,repository_id:'123',
  workflow_ref:workflowRef,ref,sha,run_id:'42',run_attempt:'1',event_name:'workflow_dispatch'})
  .setProtectedHeader({alg:'RS256'}).setIssuer('https://token.actions.githubusercontent.com')
  .setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const attempt='55555555-5555-4555-8555-555555555555';
 try{
  fixture.db.prepare(`INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,
   dispatch_id,state,repository,repository_id,workflow_ref,ref,
   candidate_run_id,candidate_run_attempt,created_at,updated_at)
   VALUES(?,?,'build','github.action',?,'confirmed',?,?,?,?,42,1,1,1)`)
    .run(attempt,runId,'66666666-6666-4666-8666-666666666666',repo,'123',workflowRef,ref);
  assert.equal(await recordSignedGitHubActionTaskResult(fixture.adapter,attempt,signed,
    audience,{verification:'passed'},publicKey),'denied');
  assert.equal(await verifyAndClaimPinnedGitHubAction(fixture.adapter,attempt,signed,
    audience,publicKey),true);
  assert.equal(await recordSignedGitHubActionTaskResult(fixture.adapter,attempt,signed,
    'workflow-github-wrong:production',{verification:'passed'},publicKey),'denied');
  assert.equal(fixture.db.prepare('SELECT count(*) AS n FROM callback_receipts').get()?.n,0);
 }finally{fixture.db.close();}
});
test('Session is not accidentally accepted through the Task executor',async()=>{
 const fixture=setup();
 try{
  const session={...plan,steps:[{...plan.steps[0],
   with:{capability:'github.action',action:{...action,type:'session',ref,inputs:{}}}}]} as Plan;
  assert.deepEqual(await runPublishedGitHubActionTask(fixture.env,session,
   session.steps[0],runId,fixture.step),
   {status:'failed',error_code:'github_action_task_required'});
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM step_attempts').get()?.n,0);
 }finally{fixture.db.close();}
});

test('cancelled parent stops a dispatched Task without polling GitHub or rewriting history',async()=>{
 const f=setup();
 let inspections=0;
 const step={do:async(name:string,_opts:unknown,callback:()=>Promise<unknown>)=>{
  if(name==='github-action-check-build-0'){
   f.db.prepare("UPDATE runs SET outcome='cancelled',error_code='approval_cancel_requested' WHERE id=?").run(runId);
   f.db.prepare("UPDATE step_attempts SET state='failed' WHERE run_id=?").run(runId);
  }
  return callback();
 },sleep:async()=>{throw Error('unexpected extra poll sleep');}} as unknown as WorkflowStep;
 const http=async(req:Request):Promise<Response>=>{
  const path=new URL(req.url).pathname;
  if(path.endsWith('/git/ref/tags/task-v1'))
   return Response.json({ref,object:{type:'commit',sha}});
  if(req.method==='POST'){f.recordPost();return Response.json({workflow_run_id:42});}
  inspections++;
  return Response.json({status:'completed',conclusion:'failure'});
 };
 try{
  const result=await runPublishedGitHubActionTask(f.env,plan,plan.steps[0],runId,step,http);
  assert.deepEqual(result,{status:'indeterminate',error_code:'github_action_parent_not_active'});
  assert.equal(f.post(),1);
  assert.equal(inspections,0,'no GitHub inspection after parent cancellation');
  assert.equal(f.db.prepare('SELECT outcome FROM runs').get()?.outcome,'cancelled');
  assert.equal(f.db.prepare('SELECT state FROM step_attempts').get()?.state,'failed');
 }finally{f.db.close();}
});
test('cancelled parent without physical proof remains unknown after an interrupted native sleep',async()=>{
 const f=setup();
 let reads=0,sleeps=0;
 const stop=new Error('continue_bounded_poll');
 const step={do:async(name:string,_opts:unknown,callback:()=>Promise<unknown>)=>{
  if(name==='github-action-check-build-0')
   f.db.prepare("UPDATE runs SET outcome='cancelled',error_code='approval_cancel_requested' WHERE id=?").run(runId);
  return callback();
 },sleep:async()=>{sleeps++;throw stop;}} as unknown as WorkflowStep;
 const http=async(req:Request):Promise<Response>=>{
  const path=new URL(req.url).pathname;
  if(path.endsWith('/git/ref/tags/task-v1'))
   return Response.json({ref,object:{type:'commit',sha}});
  if(req.method==='POST'){f.recordPost();return Response.json({workflow_run_id:42});}
  reads++;
  return Response.json({status:'completed',conclusion:'failure'});
 };
 try{
  const result=await runPublishedGitHubActionTask(f.env,plan,plan.steps[0],runId,step,http);
  assert.deepEqual(result,{status:'indeterminate',error_code:'github_action_native_sleep_unconfirmed'});
  assert.equal(f.post(),1);
  assert.equal(sleeps,1,'bounded wait continues while physical Attempt lacks a terminal receipt');
  assert.equal(reads,0,'no untrusted GitHub terminal inference from a cancelled parent');
  assert.equal(f.db.prepare('SELECT state FROM step_attempts').get()?.state,'confirmed');
 }finally{f.db.close();}
});
test('GitHub job failing before OIDC claim reports failed without a false success',async()=>{
 const fixture=setup();
 const http=async(req:Request):Promise<Response>=>{
  const path=new URL(req.url).pathname;
  if(path.endsWith('/git/ref/tags/task-v1'))
   return Response.json({ref,object:{type:'commit',sha}});
  if(req.method==='POST'){fixture.recordPost();return Response.json({workflow_run_id:42});}
  assert.ok(path.endsWith('/actions/runs/42'));
  return Response.json({id:42,workflow_id:action.workflowId,run_attempt:1,
   repository:{id:123,full_name:repo},path:action.workflowPath,head_branch:'task-v1',
   head_sha:sha,event:'workflow_dispatch',status:'completed',conclusion:'failure'});
 };
 try{
  const outcome=await runPublishedGitHubActionTask(fixture.env,plan,plan.steps[0],runId,fixture.step,http);
  assert.deepEqual(outcome,{status:'failed',error_code:'github_action_failed'});
  assert.equal(fixture.post(),1);
  assert.equal(fixture.sleeps(),0);
  const settled=fixture.db.prepare('SELECT state,owner_run_id FROM step_attempts').get();
  assert.equal(settled?.state,'failed');
  assert.equal(settled?.owner_run_id,null);
 }finally{fixture.db.close();}
});

test('workflow_cancel requests a Task cancellation exactly once and preserves parent until physical termination',async()=>{
 const f=setup(),originalFetch=globalThis.fetch;
 const attempt='33333333-3333-4333-8333-333333333333';
 try{
  f.db.prepare(`INSERT INTO step_attempts(
   attempt_id,run_id,step_id,capability_id,dispatch_id,state,
   repository,repository_id,workflow_ref,ref,
   candidate_run_id,candidate_run_attempt,created_at,updated_at)
   VALUES(?,?,?,'github.action',?,'confirmed',?,?,?,?,42,1,1,1)`)
   .run(attempt,runId,'build','44444444-4444-4444-8444-444444444444',
    repo,String(action.repositoryId),workflowRef,ref);
  let cancels=0,physicalEnded=false;
  globalThis.fetch=async(input:RequestInfo|URL)=>{
   const request=input instanceof Request?input:new Request(input);
   const pathname=new URL(request.url).pathname;
   if(request.method==='POST'){
    assert.ok(pathname.endsWith('/actions/runs/42/cancel'));
    cancels++;
    return new Response(null,{status:202});
   }
   assert.ok(pathname.endsWith('/actions/runs/42'));
   return Response.json({id:42,workflow_id:action.workflowId,run_attempt:1,
    repository:{id:action.repositoryId,full_name:repo},
    path:action.workflowPath,head_branch:'task-v1',head_sha:sha,event:'workflow_dispatch',
    status:physicalEnded?'completed':'in_progress',
    conclusion:physicalEnded?'cancelled':null});
  };
  const service=new WorkflowService(f.env);
  assert.equal((await service.cancel(runId,'build')).cancellation,'cancel_requested');
  assert.equal((await service.cancel(runId,'build')).cancellation,'already_requested');
  assert.equal(cancels,1);
  assert.equal(f.db.prepare('SELECT outcome FROM runs').get()?.outcome,'running');
  physicalEnded=true;
  const settled=await service.cancel(runId,'build');
  assert.equal(settled.cancellation,'terminal_confirmed');
  assert.equal(settled.physical_terminated,true);
  assert.equal((await service.cancel(runId,'build')).cancellation,'terminal_confirmed');
  assert.equal(cancels,1);
  assert.equal(f.db.prepare('SELECT state FROM step_attempts').get()?.state,'cancelled');
  assert.equal(f.db.prepare('SELECT outcome FROM runs').get()?.outcome,'running');
 }finally{globalThis.fetch=originalFetch;f.db.close();}
});

test('dynamic Task OIDC Claim and signed result bind to exact bounded child ID',async()=>{
 const f=setup();
 const dynamic:Plan={...plan,steps:[{id:'each',uses:'flow.foreach',needs:[],
  with:{items:{ref:'inputs.items'},max_items:2,
   template:{id:'verify',uses:'github.run',with:plan.steps[0].with}}}]};
 const child=publishedGitHubActionStep(dynamic,'each_0_verify');
 assert.ok(child);
 f.db.prepare('UPDATE workflow_versions SET plan=? WHERE id=?').run(JSON.stringify(dynamic),'v');
 const {privateKey,publicKey}=await generateKeyPair('RS256');
 const signed=await new SignJWT({repository:repo,repository_id:'123',
   workflow_ref:workflowRef,ref,sha,run_id:'42',run_attempt:'1',event_name:'workflow_dispatch'})
  .setProtectedHeader({alg:'RS256'}).setIssuer('https://token.actions.githubusercontent.com')
  .setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(privateKey);
 let claimed=false;
 const http=async(req:Request):Promise<Response>=>{
  const path=new URL(req.url).pathname;
  if(path.endsWith('/git/ref/tags/task-v1'))return Response.json({ref,object:{type:'commit',sha}});
  if(req.method==='POST'){f.recordPost();return Response.json({workflow_run_id:42});}
  const stored=f.db.prepare('SELECT attempt_id,step_id FROM step_attempts').get() as {
    attempt_id:string;step_id:string};
  assert.equal(stored.step_id,'each_0_verify');
  if(!claimed){
   claimed=await verifyAndClaimPinnedGitHubAction(f.adapter,stored.attempt_id,
     signed,audience,publicKey);
   assert.equal(claimed,true);
   assert.equal(await recordSignedGitHubActionTaskResult(f.adapter,stored.attempt_id,
    signed,audience,{checked:'dynamic'},publicKey),'recorded');
  }
  return Response.json({id:42,workflow_id:action.workflowId,run_attempt:1,
   repository:{id:123,full_name:repo},path:action.workflowPath,
   head_branch:'task-v1',head_sha:sha,event:'workflow_dispatch',
   status:'completed',conclusion:'success'});
 };
 try{
  const first=await runPublishedGitHubActionTask(f.env,dynamic,child,runId,f.step,http);
  assert.deepEqual(first,{status:'succeeded',output:{checked:'dynamic'}});
  assert.equal(f.post(),1);
  await assert.rejects(()=>runPublishedGitHubActionTask(f.env,dynamic,child,runId,f.step,http),
    /github_action_attempt_not_registered/);
  assert.equal(f.post(),1,'reentry after missing native checkpoint does not re-dispatch');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM step_attempts').get()?.n,1);
 }finally{f.db.close();}
});

test('Drop Task rejects missing encrypted Run admission before any GitHub request',async()=>{
 const fixture=setup();
 const dropAction={...action,workflowPath:'.github/workflows/drop.yml'};
 const dropPlan:Plan={version:1,name:'drop',github_execution_approved:true,
  github_action_approvals:[dropAction],
  steps:[{id:'build',uses:'github.run',needs:[],with:{capability:'github.action',
   action:{...dropAction,ref:'refs/heads/main',
    inputs:{drop_part_0:'',drop_part_1:'',drop_part_2:''}}}}]};
 const outcome=await runPublishedGitHubActionTask(fixture.env,dropPlan,dropPlan.steps[0],
  runId,fixture.step,async()=>{throw Error('external request must not happen');});
 assert.deepEqual(outcome,{status:'failed',error_code:'drop_envelope_invalid'});
 assert.equal(fixture.post(),0);
});

test('D1 Attempt binding blocks forged sealed Task inputs before any physical dispatch',async()=>{
 const fixture=setup();
 const dropAction={...action,workflowPath:'.github/workflows/drop.yml'};
 const dropPlan:Plan={version:1,name:'drop',github_execution_approved:true,
  github_action_approvals:[dropAction],
  steps:[{id:'build',uses:'github.run',needs:[],with:{capability:'github.action',
   action:{...dropAction,ref:'refs/heads/main',
    inputs:{drop_part_0:'',drop_part_1:'',drop_part_2:''}}}}]};
 const originalAttempt='22222222-2222-4222-8222-222222222222';
 const forgedAttempt='33333333-3333-4333-8333-333333333333';
 const original={drop_attempt_id:originalAttempt,drop_part_0:'sealed',
  drop_part_1:'',drop_part_2:''};
 fixture.db.prepare('UPDATE workflow_versions SET plan=?').run(JSON.stringify(dropPlan));
 fixture.db.prepare('UPDATE runs SET inputs=?').run(JSON.stringify(original));
 let requests=0;
 await assert.rejects(registerAndDispatchGitHubAction(fixture.adapter,{
  runId,stepId:'build',attemptId:forgedAttempt,
  dispatchId:'44444444-4444-4444-8444-444444444444',
  action:dropAction,ref:'refs/heads/main',token:'test-token',
  inputs:{drop_part_0:'sealed',drop_part_1:'',drop_part_2:''},
  executorIdentity:{repository:repo,repositoryId:123,ciWorkflowId:999},
 },async()=>{requests++;throw Error('unexpected network request');}),/drop_attempt_binding_invalid/);
 assert.equal(requests,0);
 assert.equal(fixture.db.prepare('SELECT count(*) AS n FROM step_attempts').get()?.n,0);
});

test('Spec87: signed Drop Task persists sealed claim once, normal callback only gets an opaque reference',async()=>{
 const fixture=setup();
 fixture.db.exec(readFileSync(new URL('../migrations/0022_drop_claim_receipts.sql',import.meta.url),'utf8'));
 const dropAction={...action,workflowPath:'.github/workflows/drop.yml'};
 const dropPlan:Plan={version:1,name:'drop',github_execution_approved:true,
  github_action_approvals:[dropAction],steps:[{id:'drop',uses:'github.run',needs:[],
    with:{capability:'github.action',action:{...dropAction,ref:'refs/heads/main',
      inputs:{drop_part_0:'',drop_part_1:'',drop_part_2:''}}}}]};
 fixture.db.prepare('UPDATE workflow_versions SET plan=? WHERE id=?')
  .run(JSON.stringify(dropPlan),'v');
 const attempt='99999999-9999-4999-8999-999999999999';
 const actionRef=repo+'/.github/workflows/drop.yml@refs/heads/main';
 const {privateKey,publicKey}=await generateKeyPair('RS256');
 const jwt=await new SignJWT({repository:repo,repository_id:'123',
  workflow_ref:actionRef,ref:'refs/heads/main',sha,run_id:'42',run_attempt:'1',
  event_name:'workflow_dispatch'})
  .setProtectedHeader({alg:'RS256'}).setIssuer('https://token.actions.githubusercontent.com')
  .setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const payload={drop_claim_v:1,preview_url:'https://temp-preview.workers.dev',
  expires_at:Date.now()+2700000,sealed_claim:'X'.repeat(500)};
 try{
  fixture.db.prepare(`INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,
   dispatch_id,state,repository,repository_id,workflow_ref,ref,
   candidate_run_id,candidate_run_attempt,created_at,updated_at)
   VALUES(?,?,'drop','github.action',?,'confirmed',?,?,?,?,42,1,1,1)`)
   .run(attempt,runId,'88888888-8888-4888-8888-888888888888',repo,'123',actionRef,
    'refs/heads/main');
  fixture.db.prepare('UPDATE step_attempts SET resolved_sha=? WHERE attempt_id=?')
   .run(sha,attempt);
  assert.equal(await verifyAndClaimPinnedGitHubAction(fixture.adapter,attempt,jwt,
   audience,publicKey),true);
  const send=(receipt:Record<string,unknown>)=>recordSignedGitHubActionTaskResult(
   fixture.adapter,attempt,jwt,audience,receipt,publicKey);
  assert.equal(await send(payload),'recorded');
  assert.equal(await send(payload),'already_recorded');
  assert.equal(await send({...payload,sealed_claim:'Y'.repeat(500)}),'denied');
  assert.equal(await send({claimUrl:'https://dash.cloudflare.com/claim-preview?claimToken=unsafe'}),'denied');
  const callback=fixture.db.prepare('SELECT result_json FROM callback_receipts WHERE attempt_id=?')
   .get(attempt) as {result_json:string};
  assert.deepEqual(JSON.parse(callback.result_json),{
   preview_url:payload.preview_url,expires_at:payload.expires_at,claim_receipt_ref:attempt});
  assert.ok(!callback.result_json.includes(payload.sealed_claim));
  assert.ok(!callback.result_json.includes('claim-preview'));
  const sealed=fixture.db.prepare('SELECT sealed_claim FROM drop_claim_receipts WHERE attempt_id=?')
   .get(attempt) as {sealed_claim:string};
  assert.equal(sealed.sealed_claim,payload.sealed_claim);
  assert.equal(fixture.db.prepare('SELECT count(*) n FROM callback_receipts').get()?.n,1);
  assert.equal(fixture.db.prepare('SELECT count(*) n FROM drop_claim_receipts').get()?.n,1);
 }finally{fixture.db.close();}
});

test('Spec87: Owner result decrypts an authenticated claim, never after expiry or without key',async()=>{
 const fixture=setup();
 const attempt='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const preview='https://test-owner.workers.dev';
 const claim='https://dash.cloudflare.com/claim-preview?claimToken='+('Q'.repeat(64));
 const expiry=Date.now()+2700000;
 const keys=generateKeyPairSync('rsa',{modulusLength:2048,
  publicKeyEncoding:{format:'pem',type:'spki'},
  privateKeyEncoding:{format:'pem',type:'pkcs8'}});
 const aes=randomBytes(32),nonce=randomBytes(12);
 const cipher=createCipheriv('aes-256-gcm',aes,nonce);
 cipher.setAAD(Buffer.from('drop-receipt-v1\n'+attempt+'\n'+preview+'\n'+expiry));
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify({
  attemptId:attempt,claimUrl:claim,previewUrl:preview,expiresAt:expiry}),'utf8'),
  cipher.final(),cipher.getAuthTag()]);
 const wrapped=publicEncrypt({key:keys.publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,
  oaepHash:'sha256'},aes);
 const sealed=Buffer.from(JSON.stringify({v:1,wrapped_key:Buffer.from(wrapped).toString('base64url'),
  nonce:Buffer.from(nonce).toString('base64url'),
  ciphertext:ciphertext.toString('base64url')})).toString('base64url');
 const dropAction={...action,workflowPath:'.github/workflows/drop.yml'};
 const dropPlan:Plan={version:1,name:'drop',github_execution_approved:true,
  github_action_approvals:[dropAction],steps:[{id:'drop',uses:'github.run',needs:[],
    with:{capability:'github.action',action:{...dropAction,ref:'refs/heads/main',
     inputs:{drop_part_0:'',drop_part_1:'',drop_part_2:''}}}}]};
 const result={preview_url:preview,expires_at:expiry,claim_receipt_ref:attempt};
 const adapter={prepare:(sql:string)=>({bind:(...args:unknown[])=>({
  first:async()=>fixture.db.prepare(sql).get(...args as []),
  all:async()=>({results:fixture.db.prepare(sql).all(...args as [])}),
  run:async()=>({meta:{changes:fixture.db.prepare(sql).run(...args as []).changes}}),
 })})} as unknown as D1Database;
 try{
  fixture.db.exec(readFileSync(new URL('../migrations/0022_drop_claim_receipts.sql',import.meta.url),'utf8'));
  fixture.db.prepare('UPDATE workflow_versions SET plan=?').run(JSON.stringify(dropPlan));
  fixture.db.prepare("UPDATE runs SET outcome='succeeded',result=?,start_state='started' WHERE id=?")
   .run(JSON.stringify(result),runId);
  fixture.db.prepare(`INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,
    state,repository,repository_id,workflow_ref,ref,created_at,updated_at)
    VALUES(?,?,'drop','github.action',?,'succeeded',?,?,?,?,1,1)`)
   .run(attempt,runId,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',repo,'123',
    repo+'/.github/workflows/drop.yml@refs/heads/main','refs/heads/main');
  fixture.db.prepare(`INSERT INTO drop_claim_receipts
   (attempt_id,sealed_claim,preview_url,expires_at,created_at) VALUES(?,?,?,?,?)`)
   .run(attempt,sealed,preview,expiry,Date.now());
  fixture.db.prepare(`INSERT INTO callback_receipts
   (callback_id,attempt_id,outcome,result_json,notification_delivered,created_at)
   VALUES(?,?,'succeeded',?,1,?)`)
   .run('cccccccc-cccc-4ccc-8ccc-cccccccccccc',attempt,JSON.stringify(result),Date.now());
  const env={...fixture.env,DB:adapter,WORKFLOW_GITHUB_DISPATCH_TOKEN:undefined,
   WORKFLOW_GITHUB_DROP_RECEIPT_PRIVATE_KEY:keys.privateKey};
  const output=await new WorkflowService(env).result(runId);
  assert.equal(output.claim_url,claim);
  assert.equal(output.claim_status,'available');
  assert.deepEqual(output.result,result);
  assert.ok(!JSON.stringify(output.result).includes('claimToken'));
  const missing=await new WorkflowService({...env,
   WORKFLOW_GITHUB_DROP_RECEIPT_PRIVATE_KEY:undefined}).result(runId);
  assert.equal(missing.claim_url,undefined);
  assert.equal(missing.claim_status,'unavailable');
  // The signed receipt remains recoverable when GitHub reconciliation is
  // Unknown: do not re-create a physical temporary account.
  fixture.db.prepare("UPDATE runs SET outcome='indeterminate',result=NULL WHERE id=?")
   .run(runId);
  fixture.db.prepare("UPDATE step_attempts SET state='claimed' WHERE attempt_id=?")
   .run(attempt);
  const unknown=await new WorkflowService(env).result(runId);
  assert.equal(unknown.status,'indeterminate');
  assert.equal(unknown.result,null);
  assert.equal(unknown.claim_url,claim);
  assert.equal(unknown.claim_status,'available');
  fixture.db.prepare('UPDATE drop_claim_receipts SET expires_at=? WHERE attempt_id=?')
   .run(Date.now()-1,attempt);
  const expired=await new WorkflowService(env).result(runId);
  assert.equal(expired.claim_url,undefined);
  assert.equal(expired.claim_status,'expired');
  fixture.db.prepare('UPDATE drop_claim_receipts SET expires_at=? WHERE attempt_id=?')
   .run(expiry,attempt);
  fixture.db.prepare('DELETE FROM callback_receipts WHERE attempt_id=?').run(attempt);
  const orphan=await new WorkflowService(env).result(runId);
  assert.equal(orphan.claim_url,undefined);
  assert.equal(orphan.claim_status,'unavailable');
 }finally{fixture.db.close();}
});

test('arbitrary reviewed file Task seals Owner Claim in the existing D1 receipt, never normal result',async()=>{
 const f=setup();
 f.db.exec(readFileSync(new URL('../migrations/0022_drop_claim_receipts.sql',import.meta.url),'utf8'));
 const generic={...action,workflowPath:'.github/workflows/new-preview.yml'};
 const policy={delivery:'github_encrypted_locator_v1' as const,
  extensions:['.html','.zip'],max_bytes:10485760,
  input_slots:['drop_part_0','drop_part_1','drop_part_2'] as ['drop_part_0','drop_part_1','drop_part_2'],
  consent:'cloudflare_terms_v1' as const,receipt:'owner_claim_v1' as const};
 const genericPlan:Plan={version:1,name:'not-drop',github_execution_approved:true,
  github_action_approvals:[generic],
  github_dynamic_input_contracts:{build:{name:'Generic',type:'task',
   inputs:{drop_part_0:{type:'string',required:true},
    drop_part_1:{type:'string',required:false,default:''},
    drop_part_2:{type:'string',required:false,default:''}},selectedFile:policy}},
  steps:[{id:'build',uses:'github.run',needs:[],with:{capability:'github.action',
   action:{...generic,ref:'refs/heads/main',
    inputs:{drop_part_0:'',drop_part_1:'',drop_part_2:''}}}}]};
 f.db.prepare('UPDATE workflow_versions SET plan=? WHERE id=?')
  .run(JSON.stringify(genericPlan),'v');
 const attempt='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const signedWorkflowRef=repo+'/'+generic.workflowPath+'@refs/heads/main';
 const {privateKey,publicKey}=await generateKeyPair('RS256');
 const jwt=await new SignJWT({repository:repo,repository_id:'123',
  workflow_ref:signedWorkflowRef,ref:'refs/heads/main',
  sha,run_id:'42',run_attempt:'1',event_name:'workflow_dispatch'})
  .setProtectedHeader({alg:'RS256'}).setIssuer('https://token.actions.githubusercontent.com')
  .setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(privateKey);
 f.db.prepare(`INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,
  dispatch_id,state,repository,repository_id,workflow_ref,ref,
  candidate_run_id,candidate_run_attempt,resolved_sha,created_at,updated_at)
  VALUES(?,?,'build','github.action',?,'confirmed',?,?,?,?,42,1,?,1,1)`)
  .run(attempt,runId,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',repo,'123',
   signedWorkflowRef,'refs/heads/main',sha);
 try{
  assert.equal(await verifyAndClaimPinnedGitHubAction(f.adapter,attempt,jwt,
   audience,publicKey),true);
  const payload={drop_claim_v:1,preview_url:'https://generic-preview.workers.dev',
   expires_at:Date.now()+2000000,sealed_claim:'S'.repeat(250)};
  const send=(v:Record<string,unknown>)=>recordSignedGitHubActionTaskResult(
   f.adapter,attempt,jwt,audience,v,publicKey);
  assert.equal(await send(payload),'recorded');
  assert.equal(await send(payload),'already_recorded');
  assert.equal(await send({...payload,sealed_claim:'H'.repeat(250)}),'denied');
  const receipt=f.db.prepare('SELECT result_json FROM callback_receipts WHERE attempt_id=?')
   .get(attempt) as {result_json:string};
  assert(!receipt.result_json.includes(payload.sealed_claim));
  assert.deepEqual(JSON.parse(receipt.result_json),{
   preview_url:payload.preview_url,expires_at:payload.expires_at,claim_receipt_ref:attempt});
  assert.equal(f.db.prepare('SELECT sealed_claim FROM drop_claim_receipts WHERE attempt_id=?')
   .get(attempt)?.sealed_claim,payload.sealed_claim);
 }finally{f.db.close();}
});
