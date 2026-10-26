import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {
  RUN_CAPACITY_LIMIT,ACTIVE_CAPACITY_UNITS_SQL,
  capacityAdmissionPredicate,transferAwaitedChildCapacity,startReservedAwaitedChild,awaitedChildRunId,
} from '../src/child-capacity.ts';

function fixture(t:test.TestContext){
  const sqlite=new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(readFileSync(new URL('../migrations/0001_s1.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0010_awaited_child_capacity.sql',import.meta.url),'utf8'));
  function prepare(sql:string){
    let bindings:(string|number|null)[]=[];
    return {
      bind(...args:(string|number|null)[]){bindings=args;return this;},
      async first<T>(){return (sqlite.prepare(sql).get(...bindings)??null) as T|null;},
      async all<T>(){return {results:sqlite.prepare(sql).all(...bindings) as T[]};},
      async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...bindings).changes)}};},
    };
  }
  const db={
    prepare,
    async batch(stmts:ReturnType<typeof prepare>[]){
      sqlite.exec('BEGIN IMMEDIATE');
      try{
        const results=[];
        for(const stmt of stmts)results.push(await stmt.run());
        sqlite.exec('COMMIT');
        return results;
      }catch(e){sqlite.exec('ROLLBACK');throw e;}
    },
  };
  function makeWorkflow(id:string,state:'active'|'paused'='active'){
    const time=1000;
    sqlite.prepare('INSERT INTO workflows(id,name,draft,draft_revision,active_version_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id,id,'{}',1,'v-'+id,state,time,time);
    sqlite.prepare('INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES(?,?,?,?,?)')
      .run('v-'+id,id,'digest','{}',time);
  }
  function makeParent(id:string,workflowId:string,weight=2){
    sqlite.prepare(`INSERT INTO runs
      (id,workflow_id,version_id,instance_id,admission_key,request_digest,inputs,
       start_state,outcome,created_at,updated_at,capacity_weight)
      VALUES (?,?,?,?,NULL,'digest','{}','started','running',1000,1000,?)`)
      .run(id,workflowId,'v-'+workflowId,id,weight);
  }
  const count=()=>Number((sqlite.prepare(
    `SELECT COALESCE(SUM(capacity_weight),0) AS n FROM runs WHERE outcome IN ('queued','running')`
  ).get() as {n:number}).n);
  return {sqlite,db,makeWorkflow,makeParent,count};
}

function request(parentRunId='p1',childRunId='c1',parentStepId='call'){
  return {parentRunId,parentStepId,childRunId,childWorkflowId:'child',
    childVersionId:'v-child',admissionKey:'child-'+parentRunId+'-'+parentStepId,
    requestDigest:'frozen-digest',inputJson:'{"value":"frozen"}',timestamp:2000};
}

test('existing 8 ordinary slots and 2-unit awaited parent reserve share one D1 budget',t=>{
  const {sqlite,makeWorkflow,makeParent,count}=fixture(t);
  makeWorkflow('parent');
  for(let i=0;i<8;i++)makeParent('p'+i,'parent',1);
  assert.equal(count(),RUN_CAPACITY_LIMIT);
  assert.equal(capacityAdmissionPredicate(1),ACTIVE_CAPACITY_UNITS_SQL+' <= 7');
  assert.equal(capacityAdmissionPredicate(2),ACTIVE_CAPACITY_UNITS_SQL+' <= 6');
  assert.equal(Number((sqlite.prepare('SELECT '+capacityAdmissionPredicate(1)+' AS ok').get() as {ok:number}).ok),0);
  sqlite.prepare("UPDATE runs SET outcome='succeeded' WHERE id='p7'").run();
  assert.equal(Number((sqlite.prepare('SELECT '+capacityAdmissionPredicate(1)+' AS ok').get() as {ok:number}).ok),1);
  assert.equal(Number((sqlite.prepare('SELECT '+capacityAdmissionPredicate(2)+' AS ok').get() as {ok:number}).ok),0);
});

test('four fully reserved parents atomically transfer child slots at limit 8',async t=>{
  const {sqlite,db,makeWorkflow,makeParent,count}=fixture(t);
  makeWorkflow('parent');makeWorkflow('child');
  for(let i=0;i<4;i++)makeParent('p'+i,'parent');
  assert.equal(count(),8);
  for(let i=0;i<4;i++){
    const result=await transferAwaitedChildCapacity(db as unknown as D1Database,request('p'+i,'c'+i));
    assert.deepEqual(result,{childRunId:'c'+i,alreadyReserved:false});
    assert.equal(count(),8);
  }
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id IS NOT NULL')
    .get() as {n:number}).n,4);
  assert.equal((sqlite.prepare('PRAGMA foreign_key_check').all()).length,0);
  assert.deepEqual(await transferAwaitedChildCapacity(
    db as unknown as D1Database,request('p1','c1')),
    {childRunId:'c1',alreadyReserved:true});
  assert.equal(count(),8);
});

test('concurrent/different child identity cannot double-spend one parent Step',async t=>{
  const {sqlite,db,makeWorkflow,makeParent,count}=fixture(t);
  makeWorkflow('parent');makeWorkflow('child');
  makeParent('p1','parent');
  await transferAwaitedChildCapacity(db as unknown as D1Database,request());
  await assert.rejects(()=>transferAwaitedChildCapacity(
    db as unknown as D1Database,request('p1','different')),
    /child_capacity_transfer_rejected/);
  assert.equal(count(),2);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id=? AND parent_step_id=?')
    .get('p1','call') as {n:number}).n,1);
  await assert.rejects(()=>transferAwaitedChildCapacity(db as unknown as D1Database,
    {...request(),requestDigest:'different'}),/child_capacity_transfer_rejected/);
  assert.equal(count(),2);
});

test('paused target, self-invocation and wrong version all fail closed without slot changes',async t=>{
  const {sqlite,db,makeWorkflow,makeParent,count}=fixture(t);
  makeWorkflow('parent');makeWorkflow('child','paused');
  makeParent('p1','parent');
  await assert.rejects(()=>transferAwaitedChildCapacity(db as unknown as D1Database,request()),
    /child_capacity_transfer_rejected/);
  assert.equal(count(),2);
  sqlite.prepare("UPDATE workflows SET state='active' WHERE id='child'").run();
  await assert.rejects(()=>transferAwaitedChildCapacity(db as unknown as D1Database,
    {...request(),childVersionId:'v-parent'}),/child_capacity_transfer_rejected/);
  await assert.rejects(()=>transferAwaitedChildCapacity(db as unknown as D1Database,
    {...request(),childWorkflowId:'parent',childVersionId:'v-parent'}),/child_capacity_transfer_rejected/);
  assert.equal(count(),2);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id IS NOT NULL')
    .get() as {n:number}).n,0);
});

test('a child Run cannot reserve another child (depth-one capacity boundary)',async t=>{
  const {db,makeWorkflow,makeParent,count}=fixture(t);
  makeWorkflow('parent');makeWorkflow('child');
  makeParent('p1','parent');
  await transferAwaitedChildCapacity(db as unknown as D1Database,request());
  await assert.rejects(()=>transferAwaitedChildCapacity(db as unknown as D1Database,
    {...request('c1','grandchild'),childWorkflowId:'parent',
      childVersionId:'v-parent',admissionKey:'grandchild'}),
  /child_capacity_transfer_rejected/);
  assert.equal(count(),2);
});

test('terminal parent cannot authorize replay of an already reserved child',async t=>{
  const {sqlite,db,makeWorkflow,makeParent,count}=fixture(t);
  makeWorkflow('parent');makeWorkflow('child');
  makeParent('p1','parent');
  await transferAwaitedChildCapacity(db as unknown as D1Database,request());
  sqlite.prepare("UPDATE runs SET outcome='failed' WHERE id='p1'").run();
  await assert.rejects(()=>transferAwaitedChildCapacity(
    db as unknown as D1Database,request()),/child_capacity_transfer_rejected/);
  assert.equal(count(),1);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM runs WHERE id='c1'")
    .get() as {n:number}).n,1);
});

test('a D1 batch failure rolls back child insert and parent weight transfer together',async t=>{
  const {sqlite,db,makeWorkflow,makeParent,count}=fixture(t);
  makeWorkflow('parent');makeWorkflow('child');
  makeParent('p1','parent');
  sqlite.exec(`CREATE TRIGGER reject_child_transfer BEFORE UPDATE OF capacity_weight ON runs
    BEGIN SELECT RAISE(ABORT,'forced-transfer-error'); END`);
  await assert.rejects(()=>transferAwaitedChildCapacity(
    db as unknown as D1Database,request()),/forced-transfer-error/);
  assert.equal(count(),2);
  assert.equal((sqlite.prepare('SELECT capacity_weight FROM runs WHERE id=?')
    .get('p1') as {capacity_weight:number}).capacity_weight,2);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id IS NOT NULL')
    .get() as {n:number}).n,0);
});

function childStartFixture(t:test.TestContext){
  const f=fixture(t);
  f.makeWorkflow('parent');f.makeWorkflow('child');f.makeParent('p1','parent');
  return f;
}
const startArgs=(timestamp=2000)=>({
  parentRunId:'p1',parentStepId:'call',childRunId:'c1',timestamp,
});

test('an acknowledged child create replays without a second native dispatch',async t=>{
  const f=childStartFixture(t);
  await transferAwaitedChildCapacity(f.db as unknown as D1Database,request());
  const created:string[]=[];
  const env={DB:f.db,WORKFLOW:{
    async create(o:{id:string}){created.push(o.id);},
    async get(){return {async status(){return {status:'running'};}};},
  }};
  const first=await startReservedAwaitedChild(env as never,startArgs());
  const replay=await startReservedAwaitedChild(env as never,startArgs(3000));
  assert.deepEqual(first,{childRunId:'c1',start_state:'started'});
  assert.deepEqual(replay,first);
  assert.deepEqual(created,['c1']);
});

test('ambiguous create followed by unavailable lookup never redispatches',async t=>{
  const f=childStartFixture(t);
  await transferAwaitedChildCapacity(f.db as unknown as D1Database,request());
  const attempts:string[]=[];
  const env={DB:f.db,WORKFLOW:{
    async create(o:{id:string}){attempts.push(o.id);throw Error('network_timeout');},
    async get(){throw Error('transient_cloudflare_503');},
  }};
  assert.deepEqual(await startReservedAwaitedChild(env as never,startArgs()),
    {childRunId:'c1',start_state:'start_unknown'});
  assert.deepEqual(await startReservedAwaitedChild(env as never,startArgs(3000)),
    {childRunId:'c1',start_state:'start_unknown'});
  assert.deepEqual(attempts,['c1']);
  assert.equal(f.count(),2);
});

test('a lost create ACK with confirmed native instance is repaired without duplicate',async t=>{
  const f=childStartFixture(t);
  await transferAwaitedChildCapacity(f.db as unknown as D1Database,request());
  const attempts:string[]=[];
  const env={DB:f.db,WORKFLOW:{
    async create(o:{id:string}){attempts.push(o.id);throw Error('ack_lost');},
    async get(id:string){
      assert.equal(id,'c1');
      return {async status(){return {status:'running'};}};
    },
  }};
  assert.deepEqual(await startReservedAwaitedChild(env as never,startArgs()),
    {childRunId:'c1',start_state:'started'});
  assert.deepEqual(attempts,['c1']);
});

test('confirmed missing child retries only its original native instance ID',async t=>{
  const f=childStartFixture(t);
  await transferAwaitedChildCapacity(f.db as unknown as D1Database,request());
  const attempts:string[]=[];
  let missing=true;
  const env={DB:f.db,WORKFLOW:{
    async create(o:{id:string}){
      attempts.push(o.id);
      if(attempts.length===1)throw Error('ack_lost');
      missing=false;
    },
    async get(){
      if(missing)throw Error('instance.not_found');
      return {async status(){return {status:'running'};}};
    },
  }};
  assert.deepEqual(await startReservedAwaitedChild(env as never,startArgs()),
    {childRunId:'c1',start_state:'start_unknown'});
  assert.deepEqual(await startReservedAwaitedChild(env as never,startArgs(3000)),
    {childRunId:'c1',start_state:'started'});
  assert.deepEqual(attempts,['c1','c1']);
});

test('stale unknown child terminates uncertainty without creating a new instance',async t=>{
  const f=childStartFixture(t);
  await transferAwaitedChildCapacity(f.db as unknown as D1Database,request());
  f.sqlite.prepare("UPDATE runs SET start_state='start_unknown' WHERE id='c1'").run();
  let calls=0;
  const env={DB:f.db,WORKFLOW:{
    async create(){calls++;},
    async get(){throw Error('instance.not_found');},
  }};
  assert.deepEqual(await startReservedAwaitedChild(env as never,
    startArgs(2000+10*60_000)),
    {childRunId:'c1',start_state:'indeterminate'});
  assert.equal(calls,0);
  assert.equal((f.sqlite.prepare("SELECT outcome FROM runs WHERE id='c1'").get() as {outcome:string}).outcome,'indeterminate');
});

test('terminated parent cannot first-start even a reserved child',async t=>{
  const f=childStartFixture(t);
  await transferAwaitedChildCapacity(f.db as unknown as D1Database,request());
  f.sqlite.prepare("UPDATE runs SET outcome='failed' WHERE id='p1'").run();
  let calls=0;
  await assert.rejects(()=>startReservedAwaitedChild({
    DB:f.db,WORKFLOW:{async create(){calls++;},async get(){throw Error('instance.not_found');}},
  } as never,startArgs()),/child_start_not_authorized/);
  assert.equal(calls,0);
});

test('child UUID is stable across retries and distinct for another parent or Step',async()=>{
  const parent='48ba36ae-97ba-4a39-a839-03a2f8879b60';
  const one=await awaitedChildRunId(parent,'launch_child');
  assert.match(one,/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(one,await awaitedChildRunId(parent,'launch_child'));
  assert.notEqual(one,await awaitedChildRunId(parent,'another'));
  assert.notEqual(one,await awaitedChildRunId('58ba36ae-97ba-4a39-a839-03a2f8879b60','launch_child'));
  await assert.rejects(()=>awaitedChildRunId('not-a-uuid','launch_child'),/invalid_child_identity/);
  await assert.rejects(()=>awaitedChildRunId(parent,'../../not-safe'),/invalid_child_identity/);
});
