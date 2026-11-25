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
