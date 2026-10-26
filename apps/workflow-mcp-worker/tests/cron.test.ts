import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {cronMatchesUtc,parseUtcCron} from '../src/cron.ts';
import {admitScheduledCron} from '../src/scheduled.ts';
import {WorkflowService, StateError, type Env} from '../src/store.ts';
import {compilePlan,PlanError} from '../src/plan.ts';

const emission=(name:string, schedule?:string)=>({
  version:1,name,...(schedule?{triggers:[{type:'cron',schedule}]}:{}),
  steps:[{id:'out',uses:'result.emit',with:{data:'ok'}}],
});

function setup(t:test.TestContext){
  const db=new DatabaseSync(':memory:');
  t.after(()=>db.close());
  for(const file of ['0001_s1.sql','0002_native_complete_seen.sql','0011_awaited_child_capacity.sql'])
    db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  let dispatches=0;
  const env={
    DB:{
      prepare(sql:string){
        let args:any[]=[];
        return {
          bind(...values:any[]){args=values;return this;},
          async first(){return db.prepare(sql).get(...args)??null;},
          async all(){return {results:db.prepare(sql).all(...args)};},
          async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};},
        };
      },
      async batch(items:{run:()=>Promise<unknown>}[]){
        return Promise.all(items.map(x=>x.run()));
      },
    },
    WORKFLOW:{
      async create(){dispatches++;},
      async get(){return {async status(){return {status:'running'};}};},
    },
  } as unknown as Env;
  return {db,env,service:new WorkflowService(env),get dispatches(){return dispatches;}};
}

test('five-field UTC Cron matches normal ranges, weekend, and Sunday 7 without timezone ambiguity',()=>{
  const sunday=Date.UTC(2026,9,25,9,0);
  assert.equal(new Date(sunday).getUTCDay(),0);
  assert.equal(cronMatchesUtc('0 9 * * 0',sunday),true);
  assert.equal(cronMatchesUtc('0 9 * * 7',sunday),true);
  assert.equal(cronMatchesUtc('0 9 * * 1-5',sunday),false);
  assert.equal(cronMatchesUtc('*/15 9 * 10 *',sunday),true);
  assert.equal(cronMatchesUtc('1-59/15 9 * * *',sunday),false);
  assert.equal(cronMatchesUtc('0 9 1 * 0',sunday),true,'restricted DOM/DOW uses OR');
  assert.equal(cronMatchesUtc('0 9 1 * 1',sunday),false);
  for(const bad of ['@hourly','* * * *','* * * * * *','*/0 * * * *',
    '70 * * * *','* * * * MON','* * * * ?','* * * * 9','0 0 * * L',
    '1-2-3 * * * *','1,,2 * * * *','* * * * * '])
    assert.throws(()=>parseUtcCron(bad),{message:'invalid_cron_schedule'});
});

test('compiler pins only one supported UTC Cron, rejects unapproved syntax with a safe field path',async()=>{
  const {plan,digest}=await compilePlan(emission('Timed','0 9 * * 1-5'));
  assert.deepEqual(plan.triggers?.[0],{type:'cron',schedule:'0 9 * * 1-5'});
  assert.equal((await compilePlan(emission('Timed','0 9 * * 1-5'))).digest,digest);
  const manual=await compilePlan(emission('Timed'));
  assert.equal(manual.plan.triggers,undefined);
  assert.notEqual(manual.digest,digest);
  for(const bad of [
    {...emission('No'),triggers:[]},
    {...emission('No'),triggers:[{type:'cron',schedule:'@daily'}]},
    {...emission('No'),triggers:[{type:'cron',schedule:'* * * * *',timezone:'Asia/Shanghai'}]},
    {...emission('No'),triggers:[{type:'cron',schedule:'* * * * *'},{type:'cron',schedule:'0 * * * *'}]},
  ]) await assert.rejects(()=>compilePlan(bad),PlanError);
  await assert.rejects(()=>compilePlan(emission('Invalid','@daily')),
    (e:unknown)=>e instanceof PlanError && e.path==='/triggers/0/schedule');
});

test('scheduled admission is version-pinned, minute-idempotent, and uses the existing Run quota',async t=>{
  const s=setup(t);
  const wf=await s.service.create(JSON.stringify(emission('Timed','* * * * *')));
  const pub=await s.service.publish(wf.workflow_id,1);
  const minute=Date.UTC(2026,9,25,12,30);
  await assert.rejects(()=>s.service.start(wf.workflow_id,{},'cron-manual'),
    (error:unknown)=>error instanceof StateError&&error.code==='reserved_idempotency_key');
  const first=await admitScheduledCron(s.env,minute);
  assert.deepEqual({due:first.due,started:first.started,replayed:first.replayed},{due:1,started:1,replayed:0});
  assert.equal(s.dispatches,1);
  const prior=await admitScheduledCron(s.env,minute);
  assert.equal(prior.replayed,1);
  assert.equal(s.dispatches,1,'duplicate controller delivery must not redispatch');
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM runs').get()?.n,1);
  const key=s.db.prepare('SELECT admission_key AS k, version_id AS v FROM runs LIMIT 1').get() as {k:string;v:string};
  assert.match(key.k,/^cron-[a-z0-9]+$/);
  assert.equal(key.v,pub.published_version_id);

  await s.service.pause(wf.workflow_id);
  const paused=await admitScheduledCron(s.env,minute+60000);
  assert.equal(paused.due,0);
  await s.service.resume(wf.workflow_id);
  const resumed=await admitScheduledCron(s.env,minute+60000);
  assert.equal(resumed.started,1);
  assert.equal(s.dispatches,2);

  await s.service.update(wf.workflow_id,1,JSON.stringify(emission('New UTC timer','0 9 * * *')));
  const publishedNew=await s.service.publish(wf.workflow_id,2);
  assert.notEqual(publishedNew.published_version_id,pub.published_version_id);
  await assert.rejects(
    ()=>s.service.start(wf.workflow_id,{},'cron-stale-version',pub.published_version_id),
    (error:unknown)=>error instanceof StateError&&error.code==='published_version_changed');
  assert.equal((await admitScheduledCron(s.env,minute+120000)).due,0);
  assert.equal(s.dispatches,2);

  // Existing manual admission consumes the same eight slots; no hidden queue.
  const manual=await s.service.create(JSON.stringify(emission('Manual')));
  await s.service.publish(manual.workflow_id,1);
  for(let i=0;i<6;i++)await s.service.start(manual.workflow_id,{},'fill-'+i);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM runs WHERE outcome IN ('queued','running')").get()?.n,8);
  const full=await admitScheduledCron(s.env,Date.UTC(2026,9,26,9,0));
  assert.equal(full.capacity_skipped,1);
  assert.equal(s.dispatches,8);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM runs').get()?.n,8);
});

test('published-only scanning visits beyond the first 100 workflow IDs',async t=>{
  const s=setup(t);
  const time=Date.UTC(2026,9,25,10,0);
  for(let i=0;i<102;i++){
    const id='wf-'+String(i).padStart(4,'0');
    const version='version-'+String(i).padStart(4,'0');
    const plan=JSON.stringify({version:1,name:'Untimed',steps:[]});
    s.db.prepare("INSERT INTO workflows(id,name,draft,draft_revision,active_version_id,state,created_at,updated_at) VALUES(?,?,?,1,?,'active',0,0)")
      .run(id,'Untimed','{}',version);
    s.db.prepare('INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES(?,?,?,?,0)')
      .run(version,id,'test',plan);
  }
  const due=await s.service.create(JSON.stringify(emission('Due','* * * * *')));
  await s.service.publish(due.workflow_id,1);
  const run=await admitScheduledCron(s.env,time);
  assert.equal(run.checked,103);
  assert.equal(run.due,1);
  assert.equal(run.started,1);
});
