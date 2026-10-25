import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleWorkflowWebhook} from '../src/webhook.ts';
import {WorkflowService,StateError,type Env} from '../src/store.ts';
import {compilePlan,PlanError} from '../src/plan.ts';
import {admitScheduledCron} from '../src/scheduled.ts';

const TOKEN=Buffer.alloc(32,0x42).toString('base64url');
const ROTATED=Buffer.alloc(32,0x43).toString('base64url');
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
const host='https://workflow.example.org';
const definition=(token=TOKEN)=>({
  version:1,name:'Webhook fixture',inputs:{payload:null},
  triggers:[{type:'webhook',token_sha256:digest(token)}],
  steps:[{id:'emit',uses:'result.emit',with:{data:{ref:'inputs.payload'}}}],
});
function setup(t:test.TestContext){
  const db=new DatabaseSync(':memory:');
  t.after(()=>db.close());
  for(const name of ['0001_s1.sql','0002_native_complete_seen.sql'])
    db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  let dispatches=0;
  const env={DB:{
    prepare(sql:string){
      let args:any[]=[];
      return {
        bind(...values:any[]){args=values;return this;},
        async first(){return db.prepare(sql).get(...args)??null;},
        async all(){return {results:db.prepare(sql).all(...args)};},
        async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};},
      };
    },
    async batch(items:{run:()=>Promise<unknown>}[]){return Promise.all(items.map(x=>x.run()));},
  },WORKFLOW:{
    async create(){dispatches++;},
    async get(){return {async status(){return {status:'running'};}};},
  }} as unknown as Env;
  return {env,db,service:new WorkflowService(env),get dispatches(){return dispatches;}};
}
function request(id:string,token:string,inputs:unknown={payload:'ok'},eventId?:string,headers:Record<string,string>={}){
  return new Request(host+'/triggers/webhook/'+id,{
    method:'POST',
    headers:{authorization:'Bearer '+token,'content-type':'application/json',
      ...(eventId?{'X-Workflow-Event-Id':eventId}:{}),...headers},
    body:JSON.stringify(inputs),
  });
}

test('compiler accepts one digest-only Webhook and rejects secret/schedule leaks and invalid schemas',async()=>{
  const compiled=await compilePlan(definition());
  assert.deepEqual(compiled.plan.triggers,[{type:'webhook',token_sha256:digest(TOKEN)}]);
  for(const bad of [
    {...definition(),triggers:[{type:'webhook',token_sha256:TOKEN}]},
    {...definition(),triggers:[{type:'webhook',token_sha256:digest(TOKEN),secret:TOKEN}]},
    {...definition(),triggers:[{type:'webhook',schedule:'* * * * *'}]},
    {...definition(),triggers:[{type:'webhook',token_sha256:digest(TOKEN)},{type:'webhook',token_sha256:digest(ROTATED)}]},
  ])await assert.rejects(()=>compilePlan(bad),PlanError);
  await assert.rejects(
    ()=>compilePlan({...definition(),triggers:[{type:'webhook',token_sha256:'incorrect'}]}),
    (error:unknown)=>error instanceof PlanError&&error.path==='/triggers/0/token_sha256');
});

test('Webhook authenticates independently and rejects invalid payloads before admission',async t=>{
  const s=setup(t);
  const wf=await s.service.create(JSON.stringify(definition()));
  await s.service.publish(wf.workflow_id,1);
  const id=wf.workflow_id;
  const invoke=(token:string,input:unknown={payload:'ok'},eventId?:string,h:Record<string,string>={})=>
    handleWorkflowWebhook(request(id,token,input,eventId,h),s.env);
  assert.equal((await invoke(ROTATED)).status,401);
  assert.equal((await handleWorkflowWebhook(new Request(host+'/triggers/webhook/'+id,{method:'GET'}),s.env)).status,405);
  assert.equal((await handleWorkflowWebhook(new Request(host+'/triggers/webhook/invalid',{method:'POST'}),s.env)).status,404);
  assert.equal((await invoke(TOKEN,{unknown:'ok'})).status,422);
  assert.equal((await invoke(TOKEN,{payload:'ok'},'spaces not allowed')).status,400);
  assert.equal((await invoke(TOKEN,{payload:'ok'},'event-a',{'content-type':'text/plain'})).status,415);
  assert.equal((await invoke(TOKEN,{payload:'x'.repeat(9000)})).status,413);
  assert.equal((await invoke(TOKEN,['array'])).status,400);
  const poisoned=new Request(host+'/triggers/webhook/'+id,{
    method:'POST',headers:{authorization:'Bearer '+TOKEN,'content-type':'application/json'},
    body:'{"__proto__":"bad","payload":"ok"}',
  });
  assert.equal((await handleWorkflowWebhook(poisoned,s.env)).status,400);
  assert.equal(s.dispatches,0,'invalid credentials and payloads never create Runs');
  assert.equal((await invoke(TOKEN,{payload:'ok'})).status,202);
  assert.equal(s.dispatches,1);
});

test('stable event ID deduplicates, changed input conflicts, and absent ID is best effort',async t=>{
  const s=setup(t);
  const wf=await s.service.create(JSON.stringify(definition()));
  const pub=await s.service.publish(wf.workflow_id,1);
  const id=wf.workflow_id;
  await assert.rejects(()=>s.service.start(id,{payload:'ok'},'webhook-forged'),
    (e:unknown)=>e instanceof StateError&&e.code==='reserved_idempotency_key');
  const a=await handleWorkflowWebhook(request(id,TOKEN,{payload:'one'},'delivery-123'),s.env);
  assert.equal(a.status,202);
  const ar=await a.json() as {published_version_id:string;deduplication:string;run_id:string};
  assert.equal(ar.published_version_id,pub.published_version_id);
  assert.equal(ar.deduplication,'stable_event_id');
  const b=await handleWorkflowWebhook(request(id,TOKEN,{payload:'one'},'delivery-123'),s.env);
  assert.equal(b.status,200);
  assert.equal((await b.json() as {run_id:string}).run_id,ar.run_id);
  assert.equal(s.dispatches,1);
  assert.equal((await handleWorkflowWebhook(request(id,TOKEN,{payload:'different'},'delivery-123'),s.env)).status,409);
  const c=await handleWorkflowWebhook(request(id,TOKEN,{payload:'two'}),s.env);
  assert.equal(c.status,202);
  assert.equal((await c.json() as {deduplication:string}).deduplication,'none');
  assert.equal((await handleWorkflowWebhook(request(id,TOKEN,{payload:'two'}),s.env)).status,202);
  assert.equal(s.dispatches,3);
  const keys=s.db.prepare('SELECT admission_key FROM runs').all() as {admission_key:string}[];
  assert.equal(new Set(keys.map(x=>x.admission_key)).size,3);
  assert.ok(keys.every(x=>x.admission_key.startsWith('webhook-')));
});

test('pause and republish revoke old Webhook credentials and preserve version-bound admission',async t=>{
  const s=setup(t);
  const wf=await s.service.create(JSON.stringify(definition()));
  const first=await s.service.publish(wf.workflow_id,1);
  const id=wf.workflow_id;
  assert.equal((await handleWorkflowWebhook(request(id,TOKEN,{},'prior'),s.env)).status,202);
  await s.service.pause(id);
  assert.equal((await handleWorkflowWebhook(request(id,TOKEN,{},'while-paused'),s.env)).status,409);
  await s.service.update(id,1,JSON.stringify(definition(ROTATED)));
  const newer=await s.service.publish(id,2);
  assert.notEqual(newer.published_version_id,first.published_version_id);
  await s.service.resume(id);
  assert.equal((await handleWorkflowWebhook(request(id,TOKEN,{},'old'),s.env)).status,401);
  assert.equal((await handleWorkflowWebhook(request(id,ROTATED,{},'new'),s.env)).status,202);
  assert.equal((await handleWorkflowWebhook(request(id,ROTATED,{},'prior'),s.env)).status,409,
    'old event identity cannot be silently replayed under a newer version');
  assert.equal(s.dispatches,2);
});

test('Cloudflare Cron ingress silently skips valid Webhook-only plans',async t=>{
  const s=setup(t);
  const wf=await s.service.create(JSON.stringify(definition()));
  await s.service.publish(wf.workflow_id,1);
  const tick=await admitScheduledCron(s.env,Date.UTC(2026,9,25,12,30));
  assert.equal(tick.checked,1);
  assert.deepEqual({due:tick.due,started:tick.started,failed:tick.failed},{due:0,started:0,failed:0});
  assert.equal(s.dispatches,0);
});
