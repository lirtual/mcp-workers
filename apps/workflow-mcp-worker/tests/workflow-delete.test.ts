import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {WorkflowService,StateError,type Env} from '../src/store.ts';

const definition=(name:string)=>JSON.stringify({version:1,name,steps:[
  {id:'emit',uses:'result.emit',with:{data:'done'}},
]});
const fails=async (fn:()=>Promise<unknown>,code:string)=>
  assert.rejects(fn,(error:unknown)=>error instanceof StateError&&error.code===code);

function setup(t:test.TestContext){
  const db=new DatabaseSync(':memory:');
  t.after(()=>db.close());
  for(let i=1;i<=14;i++){
    const names=['0001_s1','0002_native_complete_seen','0003_s3_attempt_claim',
      '0004_s3_callback_receipts','0005_github_workflow_check',
      '0006_action_attempt_capabilities','0007_session_executions',
      '0008_session_locator','0009_fixed_sessions','0010_session_runtime_data',
      '0011_awaited_child_capacity','0012_event_wait_receipts',
      '0013_cloudflare_action_invocations','0014_workflow_deletion'];
    db.exec(readFileSync(new URL('../migrations/'+names[i-1]+'.sql',import.meta.url),'utf8'));
  }
  const env={
    DB:{
      prepare(sql:string){let args:any[]=[];return {
        bind(...values:any[]){args=values;return this;},
        async first(){return db.prepare(sql).get(...args)??null;},
        async all(){return {results:db.prepare(sql).all(...args)};},
        async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};},
      };},
      async batch(statements:{run:()=>Promise<unknown>}[]){
        return Promise.all(statements.map(x=>x.run()));
      },
    },
    WORKFLOW:{
      async create(){},
      async get(){return {async status(){return {status:'complete'};}};},
    },
  } as unknown as Env;
  return {db,env,service:new WorkflowService(env)};
}

test('Draft deletion is revision-pinned, hidden, and repeat-safe',async t=>{
  const {db,service}=setup(t);
  const wf=await service.create(definition('unused draft'));
  await fails(()=>service.delete(wf.workflow_id,2),'revision_conflict');
  const result=await service.delete(wf.workflow_id,1);
  assert.deepEqual(result,{workflow_id:wf.workflow_id,state:'deleted',history_preserved:true});
  assert.equal((await service.list()).workflows.length,0);
  await fails(()=>service.get(wf.workflow_id),'workflow_not_found');
  await fails(()=>service.update(wf.workflow_id,1,definition('recreated')),'workflow_not_found');
  await fails(()=>service.start(wf.workflow_id),'workflow_not_found');
  assert.deepEqual(await service.delete(wf.workflow_id,1),
    {workflow_id:wf.workflow_id,state:'deleted',already_deleted:true,history_preserved:true});
  assert.equal(db.prepare('SELECT state FROM workflows WHERE id=?').get(wf.workflow_id)?.state,'paused');
  assert.equal(db.prepare('SELECT deleted_at IS NOT NULL AS deleted FROM workflows WHERE id=?')
    .get(wf.workflow_id)?.deleted,1);
});

test('Published Workflow must be paused and have no unsettled Runs; history is retained',async t=>{
  const {db,service}=setup(t);
  const wf=await service.create(definition('live workflow'));
  await service.publish(wf.workflow_id,1);
  await fails(()=>service.delete(wf.workflow_id,1),'workflow_not_paused');
  const run=await service.start(wf.workflow_id);
  await service.pause(wf.workflow_id);
  await fails(()=>service.delete(wf.workflow_id,1),'workflow_has_unsettled_runs');
  db.prepare("UPDATE runs SET outcome='succeeded' WHERE id=?").run(run.run_id);
  await service.delete(wf.workflow_id,1);
  assert.equal((await service.list()).workflows.length,0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs WHERE workflow_id=?')
    .get(wf.workflow_id)?.n,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workflow_versions WHERE workflow_id=?')
    .get(wf.workflow_id)?.n,1);
  const prior=await service.result(run.run_id);
  assert.equal(prior.workflow_id,wf.workflow_id);
  assert.equal(prior.status,'succeeded');
  await fails(()=>service.resume(wf.workflow_id),'not_paused');
});

test('Nonterminated physical Session prevents deletion even after parent Run succeeds',async t=>{
  const {db,service}=setup(t);
  const wf=await service.create(definition('session owner'));
  await service.publish(wf.workflow_id,1);
  const run=await service.start(wf.workflow_id);
  await service.pause(wf.workflow_id);
  db.prepare("UPDATE runs SET outcome='succeeded' WHERE id=?").run(run.run_id);
  db.prepare(`INSERT INTO session_executions
    (run_id,step_id,slot,state,created_at,updated_at) VALUES (?,'emit',1,'ready',0,0)`)
    .run(run.run_id);
  await fails(()=>service.delete(wf.workflow_id,1),'workflow_has_active_sessions');
  db.prepare("UPDATE session_executions SET state='terminated' WHERE run_id=?").run(run.run_id);
  await service.delete(wf.workflow_id,1);
});

test('Published active or paused parent references prevent child deletion',async t=>{
  const {db,service}=setup(t);
  const child=await service.create(definition('child'));
  const parent=await service.create(definition('parent'));
  const version=crypto.randomUUID();
  db.prepare('INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES (?,?,?,?,0)')
    .run(version,parent.workflow_id,'test-digest',JSON.stringify({version:1,steps:[],
      child_approvals:[{workflow_id:child.workflow_id,version_id:crypto.randomUUID(),digest:'test'}]}));
  db.prepare("UPDATE workflows SET state='active',active_version_id=? WHERE id=?")
    .run(version,parent.workflow_id);
  await fails(()=>service.delete(child.workflow_id,1),'workflow_referenced_by_parent');
  db.prepare("UPDATE workflows SET state='paused' WHERE id=?").run(parent.workflow_id);
  await fails(()=>service.delete(child.workflow_id,1),'workflow_referenced_by_parent');
  db.prepare("UPDATE workflows SET active_version_id=NULL,state='draft' WHERE id=?")
    .run(parent.workflow_id);
  await service.delete(child.workflow_id,1);
});
