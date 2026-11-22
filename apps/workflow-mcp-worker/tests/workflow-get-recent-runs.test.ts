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
  const migrations=['0001_s1','0002_native_complete_seen','0003_s3_attempt_claim',
    '0004_s3_callback_receipts','0005_github_workflow_check',
    '0006_action_attempt_capabilities','0007_session_executions',
    '0008_session_locator','0009_fixed_sessions','0010_session_runtime_data',
    '0011_awaited_child_capacity','0012_event_wait_receipts',
    '0013_cloudflare_action_invocations','0014_workflow_deletion'];
  for(const name of migrations)
    db.exec(readFileSync(new URL('../migrations/'+name+'.sql',import.meta.url),'utf8'));
  const reads:{sql:string;args:unknown[]}[]=[],writes:string[]=[];
  const env={
    DB:{
      prepare(sql:string){let args:any[]=[];return {
        bind(...values:any[]){args=values;return this;},
        async first(){reads.push({sql,args:[...args]});return db.prepare(sql).get(...args)??null;},
        async all(){reads.push({sql,args:[...args]});return {results:db.prepare(sql).all(...args)};},
        async run(){writes.push(sql);return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};},
      };},
      async batch(statements:{run:()=>Promise<unknown>}[]){
        return Promise.all(statements.map(statement=>statement.run()));
      },
    },
    WORKFLOW:{async create(){},async get(){return {async status(){return {status:'complete'};}};}},
  } as unknown as Env;
  return {db,reads,writes,service:new WorkflowService(env)};
}

async function createPublished(service:WorkflowService,name:string){
  const workflow=await service.create(definition(name));
  await service.publish(workflow.workflow_id,1);
  return workflow.workflow_id;
}

function addRun(db:DatabaseSync,workflow_id:string,version_id:string,id:string,created_at:number,error_code:string|null=null){
  db.prepare(`INSERT INTO runs
    (id,workflow_id,version_id,instance_id,request_digest,inputs,start_state,outcome,
      error_code,created_at,updated_at)
    VALUES (?,?,?,?,?,'{"sensitive":"must not be returned"}','started','succeeded',
      NULL,?,?)`)
    .run(id,workflow_id,version_id,'instance-'+id,'digest-'+id,error_code,created_at,created_at+1);
}

test('workflow_get without recent_runs_limit preserves the old shape and skips Run history',async t=>{
  const {db,reads,writes,service}=setup(t);
  const workflow_id=await createPublished(service,'no history read');
  const version_id=db.prepare('SELECT active_version_id FROM workflows WHERE id=?')
    .get(workflow_id)?.active_version_id as string;
  addRun(db,workflow_id,version_id,'00000000-0000-4000-8000-000000000001',1);
  reads.length=0;writes.length=0;

  const response=await service.get(workflow_id);

  assert.equal(Object.hasOwn(response,'recent_runs'),false);
  assert.equal(reads.filter(query=>/FROM runs/i.test(query.sql)).length,0);
  assert.equal(writes.length,0);
});

test('workflow_get returns only the bounded, deterministic, safe D1 Run snapshots',async t=>{
  const {db,reads,writes,service}=setup(t);
  const workflow_id=await createPublished(service,'history target');
  const other_id=await createPublished(service,'other workflow');
  const version_id=db.prepare('SELECT active_version_id FROM workflows WHERE id=?')
    .get(workflow_id)?.active_version_id as string;
  const other_version_id=db.prepare('SELECT active_version_id FROM workflows WHERE id=?')
    .get(other_id)?.active_version_id as string;
  const older='00000000-0000-4000-8000-000000000001';
  const newerTieA='00000000-0000-4000-8000-000000000002';
  const newerTieB='00000000-0000-4000-8000-000000000003';
  addRun(db,workflow_id,version_id,older,10);
  addRun(db,workflow_id,version_id,newerTieA,20,'timeout');
  addRun(db,workflow_id,version_id,newerTieB,20);
  addRun(db,other_id,other_version_id,'ffffffff-ffff-4fff-8fff-ffffffffffff',30);
  reads.length=0;writes.length=0;

  const response=await service.get(workflow_id,2);
  const historyReads=reads.filter(query=>/FROM runs/i.test(query.sql));
  assert.equal(historyReads.length,1);
  assert.match(historyReads[0].sql,/WHERE workflow_id=\? ORDER BY created_at DESC,id DESC LIMIT \?/);
  assert.deepEqual(historyReads[0].args,[workflow_id,2]);
  assert.deepEqual(response.recent_runs,[
    {run_id:newerTieB,published_version_id:version_id,created_at:20,updated_at:21,
      start_state:'started',recorded_outcome:'succeeded',error_code:null},
    {run_id:newerTieA,published_version_id:version_id,created_at:20,updated_at:21,
      start_state:'started',recorded_outcome:'succeeded',error_code:'timeout'},
  ]);
  assert.equal(JSON.stringify(response).includes('sensitive'),false);
  assert.equal((await service.get(workflow_id,1)).recent_runs!.length,1);
  assert.equal((await service.get(workflow_id,20)).recent_runs!.length,3);
  assert.equal(writes.length,0);
});

test('workflow_get validates limits and supports Draft, Paused, and deleted workflows',async t=>{
  const {db,service}=setup(t);
  const draft=await service.create(definition('draft'));
  const historicalVersion=crypto.randomUUID();
  db.prepare('INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES (?,?,?,?,0)')
    .run(historicalVersion,draft.workflow_id,'draft-history',JSON.stringify({version:1,steps:[]}));
  const draftRun='00000000-0000-4000-8000-000000000004';
  addRun(db,draft.workflow_id,historicalVersion,draftRun,4);
  assert.equal((await service.get(draft.workflow_id,5)).recent_runs?.[0].run_id,draftRun);

  const paused=await createPublished(service,'paused');
  const pausedVersion=db.prepare('SELECT active_version_id FROM workflows WHERE id=?')
    .get(paused)?.active_version_id as string;
  const pausedRun='00000000-0000-4000-8000-000000000005';
  addRun(db,paused,pausedVersion,pausedRun,5);
  await service.pause(paused);
  const pausedResponse=await service.get(paused,5);
  assert.equal(pausedResponse.state,'paused');
  assert.equal(pausedResponse.recent_runs?.[0].run_id,pausedRun);

  const active=await createPublished(service,'active');
  const activeVersion=db.prepare('SELECT active_version_id FROM workflows WHERE id=?')
    .get(active)?.active_version_id as string;
  const activeRun='00000000-0000-4000-8000-000000000006';
  addRun(db,active,activeVersion,activeRun,6);
  const activeResponse=await service.get(active,5);
  assert.equal(activeResponse.state,'active');
  assert.equal(activeResponse.recent_runs?.[0].run_id,activeRun);

  for(const invalid of [0,21,1.5,'5',null]){
    await fails(()=>service.get(draft.workflow_id,invalid as number),'invalid_recent_runs_limit');
  }

  await service.delete(draft.workflow_id,1);
  await fails(()=>service.get(draft.workflow_id,5),'workflow_not_found');
});
