import {reviewedGitHubAction} from '../src/github-action-review.ts';
import {frozenTaskInputDigest} from '../src/github-action-foreach-inputs.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {registerAndDispatchGitHubAction} from '../src/github-action-orchestration.ts';
import type {ReviewedGitHubAction} from '../src/github-action-review.ts';

const aid='11111111-1111-4111-8111-111111111111';
const did='22222222-2222-4222-8222-222222222222';
const rid='33333333-3333-4333-8333-333333333333';
const action:ReviewedGitHubAction={repository:'lirtual/session-actions',repositoryId:12,
 workflowId:34,workflowPath:'.github/workflows/linux.yml',
 commitSha:'a'.repeat(40),type:'session',contractDigest:'b'.repeat(64)};
const data={runId:rid,stepId:'linux',attemptId:aid,dispatchId:did,
 action,ref:'refs/tags/test-v1',token:'token',inputs:{duration_minutes:'5'}};
const publishedPlan={github_execution_approved:true,github_action_approvals:[action],
 steps:[{id:'linux',uses:'github.run',with:{capability:'github.action',action:{...action,ref:'refs/tags/test-v1',inputs:{duration_minutes:5}}}}]};
function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec('PRAGMA foreign_keys=ON');
 for(const name of ['0001_s1.sql','0014_workflow_deletion.sql','0002_native_complete_seen.sql','0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql']){
  db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 }
 db.exec(readFileSync(new URL('../migrations/0005_github_workflow_check.sql',import.meta.url),'utf8'));
 db.exec('BEGIN');
 db.exec(readFileSync(new URL('../migrations/0006_action_attempt_capabilities.sql',import.meta.url),'utf8'));
 db.exec('COMMIT');
 db.exec(`INSERT INTO workflows(id,name,draft,draft_revision,state,created_at,updated_at)
 VALUES('wf','wf','{}',1,'active',1,1);
 INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES('v','wf','x','{}',1);
 INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,outcome,created_at,updated_at)
 VALUES('${rid}','wf','v','inst','x','{}','running',1,1)`);
 db.prepare('UPDATE workflow_versions SET plan=? WHERE id=?').run(JSON.stringify(publishedPlan),'v');
 const adapter={prepare:(sql:string)=>({bind:(...args:unknown[])=>({
  run:async()=>({meta:{changes:db.prepare(sql).run(...args as []).changes}}),
  first:async()=>db.prepare(sql).get(...args as []),
 })})} as any;
 return {db,adapter};
}
const gitRef=()=>Response.json({ref:'refs/tags/test-v1',object:{type:'commit',sha:action.commitSha}});
test('persist before POST, then ACK stores physical run in D1',async()=>{
 const {db,adapter}=setup();
 try{
  let posts=0;
  const result=await registerAndDispatchGitHubAction(adapter,data,async req=>{
   const stored=db.prepare('SELECT state FROM step_attempts WHERE attempt_id=?').get(aid);
   assert.equal(stored?.state,'created');
   if(req.method==='GET')return gitRef();
   posts++;return Response.json({workflow_run_id:88});
  });
  assert.deepEqual(result,{status:'confirmed',runId:88,runAttempt:1});
  assert.equal(db.prepare('SELECT state FROM step_attempts').get()?.state,'confirmed');
  assert.equal(posts,1);
  await assert.rejects(registerAndDispatchGitHubAction(adapter,data,async()=>{throw Error('duplicate dispatched');}),/not_registered/);
 }finally{db.close();}
});
test('ambiguous network result is durable and must not replay',async()=>{
 const {db,adapter}=setup();
 try{
  const result=await registerAndDispatchGitHubAction(adapter,data,async req=>{
   if(req.method==='GET')return gitRef();
   throw Error('connection lost');
  });
  assert.deepEqual(result,{status:'dispatch_unknown'});
  assert.equal(db.prepare('SELECT state FROM step_attempts').get()?.state,'dispatch_unknown');
  await assert.rejects(registerAndDispatchGitHubAction(adapter,data),/not_registered/);
 }finally{db.close();}
});
test('terminal parent run never registers or dispatches',async()=>{
 const {db,adapter}=setup();
 try{
  db.exec("UPDATE runs SET outcome='cancelled'");
  await assert.rejects(registerAndDispatchGitHubAction(adapter,data,async()=>{throw Error('must not call GitHub');}),/publication_missing/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM step_attempts').get()?.n,0);
 }finally{db.close();}
});

test('an unapproved Action or mismatched Step cannot dispatch or reserve an Attempt',async()=>{
 const {db,adapter}=setup();
 try{
  db.prepare('UPDATE workflow_versions SET plan=? WHERE id=?')
   .run(JSON.stringify({...publishedPlan,github_action_approvals:[]}), 'v');
  let network=0;
  await assert.rejects(registerAndDispatchGitHubAction(adapter,data,async()=>{network++;throw Error('unexpected');}),
   /publication_missing/);
  assert.equal(network,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM step_attempts').get()?.n,0);
  db.prepare('UPDATE workflow_versions SET plan=? WHERE id=?')
   .run(JSON.stringify(publishedPlan),'v');
  await assert.rejects(registerAndDispatchGitHubAction(adapter,{
   ...data,action:{...action,workflowId:999},
  },async()=>{network++;throw Error('unexpected');}),/publication_missing/);
  assert.equal(network,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM step_attempts').get()?.n,0);
 }finally{db.close();}
});

test('moved immutable tag is a definite rejection and never issues a POST',async()=>{
 const {db,adapter}=setup();
 try{
  let posts=0;
  const result=await registerAndDispatchGitHubAction(adapter,data,async req=>{
   if(req.method==='POST'){posts++;throw Error('must not dispatch');}
   return Response.json({ref:data.ref,object:{type:'commit',sha:'c'.repeat(40)}});
  });
  assert.equal(result.status,'rejected');
  assert.equal(posts,0);
  assert.equal(db.prepare('SELECT state FROM step_attempts').get()?.state,'rejected');
 }finally{db.close();}
});

test('dynamic Task Attempt dispatch is one-shot and rejects forged child identities',async()=>{
 const {db,adapter}=setup();
 try{
  const taskAction={...action,type:'task' as const};
  const dynamic={...publishedPlan,github_action_approvals:[taskAction],steps:[
   {id:'each',uses:'flow.foreach',needs:[],with:{
     items:{ref:'inputs.items'},max_items:2,
     template:{id:'verify',uses:'github.run',with:{
       capability:'github.action',action:{...taskAction,ref:data.ref,inputs:{outcome:'success'}},
     }},
   }},
  ]};
  db.prepare('UPDATE workflow_versions SET plan=? WHERE id=?')
    .run(JSON.stringify(dynamic),'v');
  let posts=0;
  const child={...data,stepId:'each_0_verify',action:taskAction,inputs:{outcome:'success'}};
  const http=async (req:Request)=>{
   if(req.method==='GET')return gitRef();
   posts++;return Response.json({workflow_run_id:88});
  };
  for(const badId of ['each_2_verify','each_01_verify','each_0_wrong','linux','each_0_verify_x']){
   await assert.rejects(()=>registerAndDispatchGitHubAction(adapter,
     {...child,stepId:badId},http),/publication_missing/);
  }
  await assert.rejects(()=>registerAndDispatchGitHubAction(adapter,{
    ...child,inputs:{outcome:'failure'},
  },http),/publication_missing/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM step_attempts').get()?.n,0);
  assert.equal(posts,0);
  const response=await registerAndDispatchGitHubAction(adapter,child,http);
  assert.equal(response.status,'confirmed');
  assert.equal(posts,1);
  assert.equal(db.prepare('SELECT step_id,state FROM step_attempts').get()?.step_id,'each_0_verify');
  await assert.rejects(()=>registerAndDispatchGitHubAction(adapter,
    {...child,attemptId:'44444444-4444-4444-8444-444444444444',
      dispatchId:'55555555-5555-4555-8555-555555555555'},http),/not_registered/);
  assert.equal(posts,1,'no replay can dispatch a second GitHub Task for the same item');
 }finally{db.close();}
});

test('dynamic Task D1 input hash blocks altered arguments before registering an Attempt',async()=>{
 const {db,adapter}=setup();
 try{
  const contract={name:'Pinned Verify Action',type:'task' as const,inputs:{
   outcome:{type:'choice' as const,required:true,options:['success','failure'],default:'success'},
  }};
  const pinned=await reviewedGitHubAction({
   repository:'lirtual/session-actions',repositoryId:12,workflowId:34,
   workflowPath:'.github/workflows/linux.yml',commitSha:'a'.repeat(40),contract,
  });
  const plan={version:1,name:'Pinned dynamic Task',
   github_execution_approved:true,github_action_approvals:[pinned],
   github_dynamic_input_contracts:{each:contract},steps:[
    {id:'each',uses:'flow.foreach',needs:[],with:{
     items:{ref:'inputs.items'},max_items:2,template:{id:'task',uses:'github.run',
      with:{capability:'github.action',action:{...pinned,ref:'refs/tags/test-v1',
       inputs:{outcome:{ref:'item.value'}}}}},
    }},
   ]};
  db.prepare('UPDATE workflow_versions SET plan=? WHERE id=?')
   .run(JSON.stringify(plan),'v');
  const childId='each_0_task';
  const marker=JSON.stringify({input_sha256:await frozenTaskInputDigest({outcome:'success'})});
  db.prepare("INSERT INTO run_steps(run_id,step_id,status,output,updated_at) VALUES(?,?,'running',?,1)")
   .run(rid,childId,marker);
  const chosen={...data,stepId:childId,action:pinned,inputs:{outcome:'success'}};
  let posts=0;
  await assert.rejects(
   registerAndDispatchGitHubAction(adapter,{...chosen,inputs:{outcome:'failure'}},
    async()=>{posts++;return gitRef();}),/input_snapshot_mismatch/);
  assert.equal(posts,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM step_attempts').get()?.n,0);
  const sent=await registerAndDispatchGitHubAction(adapter,chosen,async request=>{
   if(request.method==='GET')return gitRef();
   posts++;return Response.json({workflow_run_id:9001});
  });
  assert.equal(sent.status,'confirmed');
  assert.equal(posts,1);
  await assert.rejects(
   registerAndDispatchGitHubAction(adapter,chosen,async()=>{posts++;throw Error('duplicate');}),
   /not_registered/);
  assert.equal(posts,1);
 }finally{db.close();}
});


test('Session POST uses the immutable Run duration, defaults to 300 and rejects forged inputs',async()=>{
 for(const [supplied,expected] of [[{},'300'],[{duration_minutes:10},'10']] as const){
  const {db,adapter}=setup();
  try{
   const bound={...publishedPlan,inputs:{duration_minutes:300},steps:[{
    ...publishedPlan.steps[0],with:{...publishedPlan.steps[0].with,
     action:{...action,ref:'refs/tags/test-v1',inputs:{
      duration_minutes:{ref:'inputs.duration_minutes'},duration_mode:'explicit'}}},
   }]};
   db.prepare('UPDATE workflow_versions SET plan=? WHERE id=?').run(JSON.stringify(bound),'v');
   db.prepare('UPDATE runs SET inputs=? WHERE id=?').run(JSON.stringify(supplied),rid);
   const request={...data,inputs:{duration_minutes:expected,duration_mode:'explicit'}};
   let posts=0;
   const http=async (req:Request)=>{
    if(req.method==='GET')return gitRef();
    posts++;
    const body=JSON.parse(await req.text()) as {inputs:Record<string,string>};
    assert.equal(body.inputs.duration_minutes,expected);
    assert.equal(body.inputs.duration_mode,'explicit');
    return Response.json({workflow_run_id:99});
   };
   // The persisted run, not a caller's transient dispatch map, grants variation.
   await assert.rejects(()=>registerAndDispatchGitHubAction(adapter,{
    ...request,inputs:{...request.inputs,duration_minutes:expected==='10'?'300':'10'}},
    http),/publication_missing/);
   assert.equal(posts,0);
   assert.equal(db.prepare('SELECT count(*) AS n FROM step_attempts').get()?.n,0);
   assert.equal((await registerAndDispatchGitHubAction(adapter,request,http)).status,'confirmed');
   assert.equal(posts,1);
  }finally{db.close();}
 }
});

test('invalid persisted Session duration cannot register or dispatch an Attempt',async()=>{
 const {db,adapter}=setup();
 try{
  const bound={...publishedPlan,inputs:{duration_minutes:300},steps:[{
   ...publishedPlan.steps[0],with:{...publishedPlan.steps[0].with,
    action:{...action,ref:'refs/tags/test-v1',inputs:{
     duration_minutes:{ref:'inputs.duration_minutes'},duration_mode:'explicit'}}},
  }]};
  db.prepare('UPDATE workflow_versions SET plan=? WHERE id=?').run(JSON.stringify(bound),'v');
  for(const invalid of [301,0,'10',10.5]){
   db.prepare('UPDATE runs SET inputs=? WHERE id=?').run(JSON.stringify({duration_minutes:invalid}),rid);
   await assert.rejects(()=>registerAndDispatchGitHubAction(adapter,{
    ...data,inputs:{duration_minutes:String(invalid),duration_mode:'explicit'}},
    async()=>{throw Error('unexpected network');}),/invalid_duration/);
   assert.equal(db.prepare('SELECT count(*) AS n FROM step_attempts').get()?.n,0);
  }
 }finally{db.close();}
});
