import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {
  RUN_CAPACITY_LIMIT,ACTIVE_CAPACITY_UNITS_SQL,
  capacityAdmissionPredicate,transferAwaitedChildCapacity,
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
