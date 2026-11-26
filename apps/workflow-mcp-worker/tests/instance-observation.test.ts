import test from 'node:test';
import assert from 'node:assert/strict';
import { observeInstance, shouldExpireUnconfirmedOutcome, unresolvedNativeTerminalError } from '../src/instance-observation.ts';

test('unexpected terminal Workflow status retains business uncertainty without inventing failure', () => {
 assert.equal(unresolvedNativeTerminalError('errored','running'),'orchestration_errored');
 assert.equal(unresolvedNativeTerminalError('terminated','queued'),'orchestration_terminated');
 assert.equal(unresolvedNativeTerminalError('complete','queued'),null);
 assert.equal(unresolvedNativeTerminalError('running','running'),null);
 assert.equal(unresolvedNativeTerminalError('errored','succeeded'),null);
});

test('existing Workflow instance observation confirms its actual state', async () => {
 const observed=await observeInstance({get:async()=>({status:async()=>({status:'running'})})},'run-id');
 assert.deepEqual(observed,{kind:'found',status:'running'});
});
test('only explicit not-found permits same-id creation; transient errors do not', async () => {
 const unavailable=await observeInstance({get:async()=>{throw Error('Cloudflare service unavailable')}},'run-id');
 assert.deepEqual(unavailable,{kind:'unavailable'});
 const timedOut=await observeInstance({get:async()=>({status:async()=>{throw Error('network timeout')}})},'run-id');
 assert.deepEqual(timedOut,{kind:'unavailable'});
 const missing=await observeInstance({get:async()=>{throw Error('instance.not_found')}},'run-id');
 assert.deepEqual(missing,{kind:'missing'});
 const edgeMissing=await observeInstance({get:async()=>{throw Error('(instance.not_found) Instance not found')}},'run-id');
 assert.deepEqual(edgeMissing,{kind:'missing'});
 const unknown=await observeInstance({get:async()=>{throw Error('unexpected instance not found for an unrelated request')}},'run-id');
 assert.deepEqual(unknown,{kind:'unavailable'});
});
test('stalled native complete is only expired after a bounded settling window', () => {
 const now=1_000_000,window=10*60_000;
 assert.equal(shouldExpireUnconfirmedOutcome('complete','queued',now-window+100,now),false);
 assert.equal(shouldExpireUnconfirmedOutcome('complete','running',now-window-1,now),true);
 assert.equal(shouldExpireUnconfirmedOutcome('running','running',now-window-1,now),false);
 assert.equal(shouldExpireUnconfirmedOutcome('unknown','queued',now-window-1,now),false);
 assert.equal(shouldExpireUnconfirmedOutcome('complete','succeeded',now-window-1,now),false);
});

test('#1046 stores only an exact terminal observation; never changes business result or overwrites conflicting evidence',async t=>{
 const {DatabaseSync}=await import('node:sqlite');
 const {readFileSync}=await import('node:fs');
 const {recordNativeTerminalObservation}=await import('../src/instance-observation.ts');
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 for(const name of ['0001_s1.sql','0002_native_complete_seen.sql','0023_execution_terminal_proof.sql'])
  db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 db.prepare("INSERT INTO workflows(id,name,draft,created_at,updated_at) VALUES('wf','test','{}',1,1)").run();
 db.prepare("INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES('v','wf','d','{}',1)").run();
 db.prepare("INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,start_state,outcome,error_code,created_at,updated_at,native_complete_seen_at) VALUES('r','wf','v','i','d','{}','started','indeterminate','outcome_unconfirmed',1,2,3)").run();
 const d1={prepare(sql:string){
  let args:any[]=[];
  return {bind(...v:any[]){args=v;return this;},async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};},
   async first(){return db.prepare(sql).get(...args)??null;}};
 }} as unknown as D1Database;
 const row=()=>db.prepare("SELECT outcome,error_code,updated_at,native_complete_seen_at,execution_terminal_proof FROM runs WHERE id='r'").get()!;
 const unchanged={outcome:'indeterminate',error_code:'outcome_unconfirmed',updated_at:2,native_complete_seen_at:3,execution_terminal_proof:null};
 assert.deepEqual({...row()},unchanged);
 const id={id:'r',instance_id:'i',version_id:'v'};
 for(const observation of [{kind:'missing'},{kind:'unavailable'},{kind:'found',status:'running'}] as const)
  assert.equal(await recordNativeTerminalObservation(d1,id,observation,100),'not_terminal');
 assert.equal(await recordNativeTerminalObservation(d1,{...id,instance_id:'wrong'},{kind:'found',status:'complete'},100),'conflict');
 assert.equal(await recordNativeTerminalObservation(d1,{...id,version_id:'wrong'},{kind:'found',status:'complete'},100),'conflict');
 assert.deepEqual({...row()},unchanged);
 assert.equal(await recordNativeTerminalObservation(d1,id,{kind:'found',status:'complete'},100),'recorded');
 const proof=JSON.stringify({instance_id:'i',status:'complete',observed_at:100});
 assert.deepEqual({...row()},{...unchanged,execution_terminal_proof:proof});
 assert.equal(await recordNativeTerminalObservation(d1,id,{kind:'found',status:'complete'},200),'already_recorded');
 assert.equal(await recordNativeTerminalObservation(d1,id,{kind:'found',status:'errored'},300),'conflict');
 assert.deepEqual({...row()},{...unchanged,execution_terminal_proof:proof});
 db.prepare("UPDATE runs SET execution_terminal_proof=NULL,start_state='reserved' WHERE id='r'").run();
 assert.equal(await recordNativeTerminalObservation(d1,id,{kind:'found',status:'complete'},400),'conflict');
 assert.equal(row().execution_terminal_proof,null);
 db.prepare("UPDATE runs SET start_state='started' WHERE id='r'").run();
 const raced=await Promise.all([
  recordNativeTerminalObservation(d1,id,{kind:'found',status:'complete'},401),
  recordNativeTerminalObservation(d1,id,{kind:'found',status:'errored'},402),
 ]);
 assert.deepEqual(raced.sort(),['conflict','recorded']);
 const saved=JSON.parse(String(row().execution_terminal_proof));
 assert.equal(saved.instance_id,'i');
 assert.ok(['complete','errored'].includes(saved.status));
 assert.throws(()=>db.prepare("UPDATE runs SET execution_terminal_proof=? WHERE id='r'").run('not-json'),/CHECK constraint/);
 assert.throws(()=>db.prepare("UPDATE runs SET execution_terminal_proof=? WHERE id='r'").run(JSON.stringify({data:'x'.repeat(4096)})),/CHECK constraint/);
});

test('#1046 hourly fallback is bounded, prioritizes recent candidates, and does not change business states',async t=>{
 const {DatabaseSync}=await import('node:sqlite');
 const {readFileSync}=await import('node:fs');
 const {collectNativeTerminalProofs,NATIVE_PROOF_HOURLY_LIMIT}=await import('../src/instance-observation.ts');
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 for(const name of ['0001_s1.sql','0023_execution_terminal_proof.sql'])
  db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 db.prepare("INSERT INTO workflows(id,name,draft,created_at,updated_at) VALUES('wf','test','{}',1,1)").run();
 db.prepare("INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES('v','wf','d','{}',1)").run();
 const now=Date.UTC(2026,10,26,0);
 const insert=db.prepare("INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,start_state,outcome,created_at,updated_at) VALUES(?,'wf','v',?,'d','{}',?,'indeterminate',?,?)");
 for(let i=0;i<400;i++)insert.run('old-'+i,'old-'+i,'started',now-10*86400000,now-10*86400000);
 for(let i=0;i<NATIVE_PROOF_HOURLY_LIMIT+3;i++)insert.run('recent-'+i,'recent-'+i,'started',now-10000+i,now-10000+i);
 insert.run('reserved','reserved','reserved',now,now);
 insert.run('fresh','fresh','started',now,now);
 insert.run('fresh-failure','fresh-failure','started',now-1,now-1);
 const seen:string[]=[];
 let queries=0;
 const env={DB:{prepare(sql:string){
  queries++;let args:any[]=[];
  return {bind(...v:any[]){args=v;return this;},async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};},
   async first(){return db.prepare(sql).get(...args)??null;},async all(){return {results:db.prepare(sql).all(...args)};}};
 }},WORKFLOW:{async get(id:string){seen.push(id);if(id==='fresh-failure')throw Error('timeout');
   return {async status(){return {status:id==='fresh'?'complete':'running'};}};}}} as unknown as {DB:D1Database;WORKFLOW:Workflow};
 await collectNativeTerminalProofs(env,now+60000,now+60000);
 assert.equal(queries,0);assert.equal(seen.length,0);
 const result=await collectNativeTerminalProofs(env,now,now+500);
 assert.equal(seen.length,NATIVE_PROOF_HOURLY_LIMIT);
 assert.equal(seen[0],'fresh');assert.equal(seen[1],'fresh-failure');
 assert.equal(seen.some(id=>id.startsWith('old-')||id==='reserved'),false);
 assert.equal(result.recorded,1);
 assert.equal(db.prepare("SELECT count(*) AS n FROM runs WHERE outcome<>'indeterminate'").get()?.n,0);
 assert.equal(db.prepare("SELECT count(*) AS n FROM runs WHERE execution_terminal_proof IS NOT NULL").get()?.n,1);
 seen.length=0;
 db.prepare("UPDATE runs SET updated_at=? WHERE execution_terminal_proof IS NULL").run(now-10*86400000);
 await collectNativeTerminalProofs(env,now+3600000,now+3600000);
 assert.equal(seen.length,0,'no eligible candidate means no native lookup');
});

test('#1046 current Task physical observations reuse the same bounded proof without changing durable execution',async t=>{
 const {DatabaseSync}=await import('node:sqlite');
 const {readFileSync,readdirSync}=await import('node:fs');
 const {collectNativeTerminalProofs}=await import('../src/instance-observation.ts');
 const {observeGitHubTaskTerminalFact}=await import('../src/github-action-attempt-inspection.ts');
 const {inspectGitHubActionRun}=await import('../src/github-action-run-inspection.ts');
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const dir=new URL('../migrations/',import.meta.url);
 for(const name of readdirSync(dir).filter(f=>/^\d{4}_.+\.sql$/.test(f)).sort())
  db.exec(readFileSync(new URL(name,dir),'utf8'));
 const now=Date.UTC(2026,10,26,0);
 const action={repository:'autoactions/github-actions',repositoryId:1452488311,workflowId:413147310,
  workflowPath:'.github/workflows/download.yml',commitSha:'a'.repeat(40),type:'task' as const,contractDigest:'b'.repeat(64)};
 const resolved='c'.repeat(40),ref='refs/heads/main';
 const plan={version:1,name:'Current task',github_execution_approved:true,github_action_approvals:[action],
  steps:['one','two','three'].map(id=>({id,uses:'github.run',needs:[],with:{capability:'github.action',action:{...action,ref,inputs:{}}}}))};
 db.exec("INSERT INTO workflows(id,name,draft,created_at,updated_at) VALUES('wf','test','{}',1,1)");
 db.prepare("INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES('v','wf','d',?,1)").run(JSON.stringify(plan));
 const native={instance_id:'r',status:'complete',observed_at:now-100};
 db.prepare("INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,start_state,outcome,error_code,created_at,updated_at,execution_terminal_proof) VALUES('r','wf','v','r','d','{}','started','indeterminate','github_action_native_check_unconfirmed',?,?,?)")
  .run(now-1000,now-500,JSON.stringify(native));
 const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
 for(const [i,step] of ['one','two','three'].entries()){
  db.prepare("INSERT INTO run_steps(run_id,step_id,status,error_code,updated_at) VALUES('r',?,'indeterminate','github_action_native_check_unconfirmed',?)").run(step,now-500);
  db.prepare("INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,state,repository,repository_id,workflow_ref,ref,resolved_sha,candidate_run_id,candidate_run_attempt,owner_run_id,owner_run_attempt,created_at,updated_at) VALUES(?,'r',?,'github.action',?,'claimed',?,?,?,?,?, ?,1,?,1,?,?)")
   .run(ids[i],step,'dispatch-'+i,action.repository,String(action.repositoryId),action.repository+'/'+action.workflowPath+'@'+ref,ref,resolved,42+i,42+i,now-1000,now-500);
 }
 const before=db.prepare("SELECT id,outcome,error_code,updated_at FROM runs").all();
 const stepsBefore=db.prepare("SELECT * FROM run_steps ORDER BY step_id").all();
 const attemptsBefore=db.prepare("SELECT * FROM step_attempts ORDER BY attempt_id").all();
 const seen:number[]=[];
 const d1={prepare(sql:string){let args:any[]=[];return {bind(...v:any[]){args=v;return this;},
  async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};},
  async first(){return db.prepare(sql).get(...args)??null;},async all(){return {results:db.prepare(sql).all(...args)};}}}};
 const env={DB:d1,WORKFLOW_GITHUB_DISPATCH_TOKEN:'test-only',WORKFLOW:{async get(){throw Error('native evidence is already persisted');}}} as unknown as Parameters<typeof collectNativeTerminalProofs>[0];
 const inspect:typeof observeGitHubTaskTerminalFact=(p,a,tok)=>observeGitHubTaskTerminalFact(p,a,tok,
  (reviewed,run,attempt,token,expectedRef)=>inspectGitHubActionRun(reviewed,run,attempt,token,expectedRef,async request=>{
   seen.push(run);
   assert.equal(new URL(request.url).pathname,'/repos/'+action.repository+'/actions/runs/'+run);
   return Response.json({id:run,workflow_id:action.workflowId,run_attempt:attempt,
    repository:{id:action.repositoryId,full_name:action.repository},path:action.workflowPath,
    head_branch:'main',head_sha:run===44?'d'.repeat(40):resolved,event:'workflow_dispatch',
    status:'completed',conclusion:run===43?'failure':'success'});
  }),now);
 const first=await collectNativeTerminalProofs(env,now,now,inspect);
 assert.equal(first.checked,3);assert.equal(first.recorded,2);assert.equal(first.unavailable,1);
 assert.deepEqual(seen,[42,43,44]);
 const saved=JSON.parse(String(db.prepare("SELECT execution_terminal_proof FROM runs WHERE id='r'").get()?.execution_terminal_proof));
 assert.deepEqual({...saved,github_attempts:undefined},{...native,github_attempts:undefined});
 assert.deepEqual(saved.github_attempts.map((f:any)=>[f.attempt_id,f.run_id,f.conclusion]),[[ids[0],42,'success'],[ids[1],43,'failure']]);
 assert.deepEqual(db.prepare("SELECT id,outcome,error_code,updated_at FROM runs").all(),before);
 assert.deepEqual(db.prepare("SELECT * FROM run_steps ORDER BY step_id").all(),stepsBefore);
 assert.deepEqual(db.prepare("SELECT * FROM step_attempts ORDER BY attempt_id").all(),attemptsBefore);
 seen.length=0;
 // A backlog of fresh unavailable native observations cannot consume
 // the whole shared budget before the unresolved Task is reached.
 for(let i=0;i<12;i++)
  db.prepare("INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,start_state,outcome,created_at,updated_at) VALUES(?,'wf','v',?,'d','{}','started','indeterminate',?,?)")
   .run('pending-'+i,'pending-'+i,now,now);
 const second=await collectNativeTerminalProofs(env,now+3600000,now+3600000,inspect);
 assert.equal(second.checked,12);
 assert.deepEqual(seen,[44],'verified facts are not reread; unresolved Task is not starved');
});
