import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {generateKeyPair,SignJWT} from 'jose';
import {runPublishedGitHubActionTask} from '../src/github-action-task.ts';
import {verifyAndClaimPinnedGitHubAction} from '../src/github-action-oidc-claim.ts';
import type {Plan} from '../src/plan.ts';
import type {Env} from '../src/store.ts';
import type {WorkflowStep} from 'cloudflare:workers';

const runId='11111111-1111-4111-8111-111111111111';
const repo='lirtual/session-actions',ref='refs/tags/task-v1',sha='a'.repeat(40);
const audience='workflow-github-action:production';
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
 for(const migration of ['0001_s1.sql','0002_native_complete_seen.sql',
  '0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql'])
  db.exec(readFileSync(new URL('../migrations/'+migration,import.meta.url),'utf8'));
 db.exec('BEGIN');
 db.exec(readFileSync(new URL('../migrations/0005_action_attempt_capabilities.sql',import.meta.url),'utf8'));
 db.exec('COMMIT');
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
 const env={DB:adapter,WORKFLOW_EXECUTOR_GITHUB_TOKEN:'test-token',
  GITHUB_ACTION_OIDC_AUDIENCE:audience} as Env;
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
  }
  return Response.json({id:42,workflow_id:456,run_attempt:1,
   repository:{id:123,full_name:repo},path:action.workflowPath,
   head_sha:sha,event:'workflow_dispatch',status:'completed',conclusion:'success'});
 };
 try{
  const outcome=await runPublishedGitHubActionTask(fixture.env,plan,plan.steps[0],runId,fixture.step,http);
  assert.deepEqual(outcome,{status:'succeeded',output:null});
  assert.equal(fixture.post(),1);
  assert.equal(fixture.sleeps(),0);
  assert.equal(fixture.db.prepare('SELECT state FROM step_attempts').get()?.state,'succeeded');
  // Only the WorkflowRunner is permitted to settle the parent business Run.
  assert.equal(fixture.db.prepare('SELECT outcome FROM runs').get()?.outcome,'running');
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
