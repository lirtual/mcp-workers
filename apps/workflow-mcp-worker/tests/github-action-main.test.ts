import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {generateKeyPair,SignJWT} from 'jose';
import {parseGitHubAction} from '../src/github-action-contract.ts';
import {reviewedGitHubAction} from '../src/github-action-review.ts';
import {isDynamicMainAction,actionForAttempt,DYNAMIC_MAIN_REF} from '../src/github-action-main.ts';
import {resolveApprovedMainAction} from '../src/github-action-main-preflight.ts';
import {registerAndDispatchGitHubAction} from '../src/github-action-orchestration.ts';
import {verifyAndClaimPinnedGitHubAction} from '../src/github-action-oidc-claim.ts';
import {inspectPersistedGitHubActionAttempt} from '../src/github-action-attempt-inspection.ts';
import {reconcileGitHubPhysicalRun} from '../src/github-action-run-state.ts';
import {compilePlan} from '../src/plan.ts';

const REPO='lirtual/github-actions',REPO_ID=1430925009;
const PATH='.github/workflows/ubuntu.yml',WF_ID=395929968;
const BASE='a'.repeat(40),HEAD='c'.repeat(40);
const RID='33333333-3333-4333-8333-333333333333';
const AID='11111111-1111-4111-8111-111111111111';
const DID='22222222-2222-4222-8222-222222222222';
const YAML=['name: ubuntu','on:','  workflow_dispatch:','    inputs:',
 '      attempt_id: {type: string, required: true}',
 '      dispatch_id: {type: string, required: true}',
 '      capability_id: {type: string, required: true}',
 '      duration_minutes: {type: number, default: 5}',
 'env:','  WORKFLOW_ACTION_TYPE: session','jobs:','  session:',
 '    runs-on: ubuntu-latest','    timeout-minutes: 360','    steps:',
 '      - run: echo synthetic',''].join('\n');
const approved=await reviewedGitHubAction({repository:REPO,repositoryId:REPO_ID,
 workflowId:WF_ID,workflowPath:PATH,commitSha:BASE,contract:parseGitHubAction(YAML)});
const source={...approved,ref:DYNAMIC_MAIN_REF,inputs:{duration_minutes:5}};
const plan={version:1,name:'ubuntu',github_execution_approved:true,
 github_action_approvals:[approved],steps:[{id:'ubuntu',uses:'github.run',
 with:{capability:'github.action',action:source}}]};
const dispatch={runId:RID,stepId:'ubuntu',attemptId:AID,dispatchId:DID,
 action:approved,ref:DYNAMIC_MAIN_REF,token:'test-token',inputs:{duration_minutes:'5'}};

function fake(o:{ci?:'success'|'failure'|'absent';changed?:boolean;
 moved?:boolean;throwPost?:boolean;onPost?:()=>void}={}){
 let posts=0;
 const http=async(req:Request):Promise<Response>=>{
  const u=new URL(req.url);
  assert.equal(req.redirect,'manual');
  assert.equal(u.host,'api.github.com');
  if(req.method==='POST'){
   posts++;o.onPost?.();
   if(o.throwPost)throw Error('lost POST ACK');
   const body=await req.json() as {ref:string};
   assert.equal(body.ref,'main');
   return Response.json({workflow_run_id:88});
  }
  if(u.pathname==='/repos/'+REPO)
   return Response.json({id:REPO_ID,full_name:REPO,default_branch:'main'});
  if(u.pathname==='/repos/'+REPO+'/commits/main')
   return Response.json({sha:HEAD});
  if(u.pathname==='/repos/'+REPO+'/actions/workflows')
   return Response.json({workflows:[{id:WF_ID,path:PATH,state:'active'}]});
  if(u.pathname==='/repos/'+REPO+'/contents/'+PATH)
   return Response.json({path:PATH,encoding:'base64',
    content:btoa(o.changed?YAML.replace('default: 5','default: 6'):YAML)});
  if(u.pathname==='/repos/'+REPO+'/actions/workflows/ci.yml/runs')
   return Response.json({total_count:o.ci==='absent'?0:1,
    workflow_runs:o.ci==='absent'?[]:[{id:1234,workflow_id:394262523,
     event:'push',head_branch:'main',head_sha:HEAD,status:'completed',
     conclusion:o.ci??'success',path:'.github/workflows/ci.yml',
     repository:{id:REPO_ID},head_repository:{id:REPO_ID}}]});
  if(u.pathname==='/repos/'+REPO+'/git/ref/heads/main')
   return Response.json({ref:DYNAMIC_MAIN_REF,object:{type:'commit',
    sha:o.moved?'d'.repeat(40):HEAD}});
  throw Error('unexpected endpoint: '+u.pathname);
 };
 return {http,posts:()=>posts};
}

function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec('PRAGMA foreign_keys=ON');
 for(const file of ['0001_s1.sql','0014_workflow_deletion.sql',
  '0002_native_complete_seen.sql','0003_s3_attempt_claim.sql',
  '0004_s3_callback_receipts.sql','0005_github_workflow_check.sql'])
  db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 db.exec('BEGIN');
 db.exec(readFileSync(new URL('../migrations/0006_action_attempt_capabilities.sql',import.meta.url),'utf8'));
 db.exec('COMMIT');
 db.exec(readFileSync(new URL('../migrations/0007_session_executions.sql',import.meta.url),'utf8'));
 db.exec(readFileSync(new URL('../migrations/0020_github_action_main_sha.sql',import.meta.url),'utf8'));
 db.exec("INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at) VALUES('wf','ubuntu','{}',1,'active',1,1)");
 db.exec("INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES('v','wf','x','{}',1)");
 db.prepare('INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,outcome,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,1)')
   .run(RID,'wf','v','inst','x','{}','running');
 db.prepare('UPDATE workflow_versions SET plan=? WHERE id=?').run(JSON.stringify(plan),'v');
 const adapter={prepare:(sql:string)=>({bind:(...args:unknown[])=>({
  run:async()=>({meta:{changes:db.prepare(sql).run(...args as []).changes}}),
  first:async()=>db.prepare(sql).get(...args as []),
 })})} as any;
 return {db,adapter};
}

test('moving main is restricted to the five exact owner Workflow IDs',async()=>{
 for(const [path,id,type] of [
  ['windows.yml',394689662,'session'],['ubuntu.yml',395929968,'session'],
  ['chrome.yml',394689653,'session'],['code-server.yml',394689654,'session'],
  ['download.yml',401335372,'task'],
 ] as const){
  const action={...approved,workflowPath:'.github/workflows/'+path,workflowId:id,type};
  assert.equal(isDynamicMainAction(action,DYNAMIC_MAIN_REF,path.slice(0,-4)),true);
  assert.equal(isDynamicMainAction(action,DYNAMIC_MAIN_REF,'other'),false);
  assert.equal(isDynamicMainAction({...action,workflowId:999},DYNAMIC_MAIN_REF),false);
  assert.equal(isDynamicMainAction({...action,repository:'other/repo'},DYNAMIC_MAIN_REF),false);
  assert.equal(isDynamicMainAction(action,'refs/heads/dev'),false);
 }
 assert.equal(isDynamicMainAction({...approved,workflowPath:'.github/workflows/openlist.yml'},DYNAMIC_MAIN_REF),false);
 assert.equal((await compilePlan({version:1,name:'ubuntu',steps:plan.steps})).plan.steps.length,1);
});

test('main preflight requires complete successful CI, matching contract and branch SHA',async()=>{
 assert.equal((await resolveApprovedMainAction(approved,'token',fake().http)).commitSha,HEAD);
 for(const invalid of [{ci:'failure' as const},{ci:'absent' as const},
  {changed:true},{moved:true}]){
  const api=fake(invalid);
  await assert.rejects(()=>resolveApprovedMainAction(approved,'token',api.http));
  assert.equal(api.posts(),0);
 }
});

test('Attempt stores exact approved HEAD before single dispatch, rejects subsequent POST',async()=>{
 const {db,adapter}=setup();
 try{
  const api=fake({onPost:()=>{
   const row=db.prepare('SELECT state,resolved_sha FROM step_attempts' ).get() as {state:string;resolved_sha:string};
   assert.equal(row.state,'created');
   assert.equal(row.resolved_sha,HEAD);
  }});
  assert.deepEqual(await registerAndDispatchGitHubAction(adapter,dispatch,api.http),
   {status:'confirmed',runId:88,runAttempt:1});
  assert.equal(api.posts(),1);
  await assert.rejects(()=>registerAndDispatchGitHubAction(adapter,{
   ...dispatch,attemptId:'44444444-4444-4444-8444-444444444444',
   dispatchId:'55555555-5555-4555-8555-555555555555',
  },api.http),/not_registered/);
  assert.equal(api.posts(),1);
 }finally{db.close();}
});

test('invalid CI/contract/HEAD is a no-POST rejection and remains unowned',async()=>{
 for(const invalid of [{ci:'failure' as const},{changed:true},{moved:true}]){
  const {db,adapter}=setup();
  try{
   const api=fake(invalid);
   assert.equal((await registerAndDispatchGitHubAction(adapter,dispatch,api.http)).status,'rejected');
   assert.equal(api.posts(),0);
   const row=db.prepare('SELECT state,resolved_sha,candidate_run_id FROM step_attempts' ).get() as {state:string;resolved_sha:null;candidate_run_id:null};
   assert.equal(row.state,'rejected');
   assert.equal(row.resolved_sha,null);
   assert.equal(row.candidate_run_id,null);
  }finally{db.close();}
 }
});

test('Unknown POST never retries, signed Claim and physical Run require frozen HEAD',async()=>{
 const first=setup();
 try{
  const api=fake({throwPost:true});
  assert.equal((await registerAndDispatchGitHubAction(first.adapter,dispatch,api.http)).status,'dispatch_unknown');
  assert.equal(api.posts(),1);
  assert.equal((first.db.prepare('SELECT state FROM step_attempts').get() as {state:string}).state,'dispatch_unknown');
 }finally{first.db.close();}
 const {db,adapter}=setup();
 try{
  assert.equal((await registerAndDispatchGitHubAction(adapter,dispatch,fake().http)).status,'confirmed');
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const sign=(sha:string)=>new SignJWT({
   repository:REPO,repository_id:String(REPO_ID),
   workflow_ref:REPO+'/'+PATH+'@'+DYNAMIC_MAIN_REF,
   ref:DYNAMIC_MAIN_REF,sha,event_name:'workflow_dispatch',run_id:'88',run_attempt:'1',
  }).setProtectedHeader({alg:'RS256'}).setIssuer('https://token.actions.githubusercontent.com')
   .setAudience('workflow-github-action-claim').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  assert.equal(await verifyAndClaimPinnedGitHubAction(adapter,AID,await sign(BASE),
   'workflow-github-action-claim',publicKey),false);
  assert.equal(await verifyAndClaimPinnedGitHubAction(adapter,AID,await sign(HEAD),
   'workflow-github-action-claim',publicKey),true);
  const state=await inspectPersistedGitHubActionAttempt(adapter,AID,'token',
   async(action,run,attempt,_,ref)=>{
    assert.equal(action.commitSha,HEAD);
    return reconcileGitHubPhysicalRun(action,run,attempt,{
     id:88,workflow_id:WF_ID,run_attempt:1,
     repository:{id:REPO_ID,full_name:REPO},path:PATH,
     head_branch:'main',head_sha:HEAD,event:'workflow_dispatch',status:'in_progress',
    },ref);
   });
  assert.deepEqual(state,{state:'running'});
  assert.equal(actionForAttempt(approved,DYNAMIC_MAIN_REF,'ubuntu',null),null);
  assert.equal(reconcileGitHubPhysicalRun({...approved,commitSha:HEAD},88,1,{
    id:88,workflow_id:WF_ID,run_attempt:1,
    repository:{id:REPO_ID,full_name:REPO},path:PATH,
    head_branch:'main',head_sha:BASE,event:'workflow_dispatch',
   },DYNAMIC_MAIN_REF).state,'identity_mismatch');
 }finally{db.close();}
});
