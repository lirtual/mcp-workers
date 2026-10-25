import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {generateKeyPair,SignJWT} from 'jose';
import {handleGithubEvent,verifyGithubPushEvent} from '../src/github-event.ts';
import {WorkflowService,StateError,type Env} from '../src/store.ts';
import {compilePlan,PlanError} from '../src/plan.ts';
import {workflowCapabilities} from '../src/capabilities.ts';
import {admitScheduledCron} from '../src/scheduled.ts';

const id='lirtual/mcp-workers',repoId=1414936394;
const aud='workflow-github-event-tests';
const relay='.github/workflows/forward.yml';
const ref='refs/heads/main';
const base='https://workflow.example.org/triggers/github/';
const wf=(overrides:Record<string,unknown>={})=>({
  version:1,name:'GitHub push fixture',inputs:{github:null},
  triggers:[{type:'github_event',repository:id,repository_id:repoId,event:'push',
    ref,workflow_path:relay,...overrides}],
  steps:[{id:'emit',uses:'result.emit',with:{data:{ref:'inputs.github'}}}],
});

function setup(t:test.TestContext){
  const db=new DatabaseSync(':memory:');
  t.after(()=>db.close());
  for(const file of ['0001_s1.sql','0002_native_complete_seen.sql'])
    db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  let dispatches=0;
  const env={GITHUB_ACTION_OIDC_AUDIENCE:aud,
    DB:{prepare(sql:string){
      let args:any[]=[];
      return {
        bind(...values:any[]){args=values;return this;},
        async first(){return db.prepare(sql).get(...args)??null;},
        async all(){return {results:db.prepare(sql).all(...args)};},
        async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};},
      };
    },async batch(items:{run:()=>Promise<unknown>}[]){return Promise.all(items.map(x=>x.run()));}},
    WORKFLOW:{async create(){dispatches++;},
      async get(){return {async status(){return {status:'running'};}};}},
  } as unknown as Env;
  return {db,env,service:new WorkflowService(env),get dispatches(){return dispatches;}};
}
const claims={
  repository:id,repository_id:String(repoId),event_name:'push',
  ref,workflow_ref:id+'/'+relay+'@'+ref,
  sha:'a'.repeat(40),run_id:'40196774962',run_attempt:'1',
};
async function sign(privateKey:Awaited<ReturnType<typeof generateKeyPair>>['privateKey'],
  changes:Record<string,unknown>={},audience=aud){
  return new SignJWT({...claims,...changes})
    .setProtectedHeader({alg:'RS256'}).setIssuer('https://token.actions.githubusercontent.com')
    .setAudience(audience).setIssuedAt().setExpirationTime('3m').sign(privateKey);
}
const request=(workflowId:string,token:string,body?:string)=>
  new Request(base+workflowId,{method:'POST',headers:{authorization:'Bearer '+token},
    ...(body===undefined?{}:{body})});

test('GitHub event compiler enforces one exact repository, branch, relay and declared normalized input',async()=>{
  const valid=await compilePlan(wf());
  assert.equal(valid.plan.triggers?.[0].type,'github_event');
  for(const change of [
    {repository:'../../forged'}, {repository_id:0},{event:'pull_request'},
    {ref:'refs/heads/../main'}, {ref:'refs/tags/latest'},
    {workflow_path:'.github/workflows/../bad.yml'},
    {workflow_path:'../other.yml'},
    {secret:'should-not-be-in-plan'},
  ])await assert.rejects(()=>compilePlan(wf(change)),PlanError);
  await assert.rejects(()=>compilePlan({...wf(),inputs:{other:null}}),PlanError);
  const capability=await workflowCapabilities({
    GITHUB_ACTION_OIDC_AUDIENCE:aud,
    MCP_PORTAL_ENDPOINT:undefined,MCP_PORTAL_CLIENT_ID:undefined,
    MCP_PORTAL_CLIENT_SECRET:undefined,GITHUB_ACTION_APPROVED_REPOSITORIES:undefined,
    WORKFLOW_GITHUB_DISPATCH_TOKEN:undefined,
  },'trigger.github_event');
  assert.equal(capability.availability,'supported_with_relay');
  const example=capability.example as {definition:unknown;digest:string};
  assert.equal((await compilePlan(example.definition)).digest,example.digest);
});

test('signed GitHub identity is verified against every immutable trigger binding',async()=>{
  const pair=await generateKeyPair('RS256');
  const plan=(await compilePlan(wf())).plan;
  const trigger=plan.triggers![0];
  if(trigger.type!=='github_event')throw Error('invalid_test_plan');
  assert.ok(await verifyGithubPushEvent(await sign(pair.privateKey),aud,trigger,pair.publicKey));
  for(const changed of [
    {repository:'other/repo'},{repository_id:'123'},{event_name:'workflow_dispatch'},
    {ref:'refs/heads/feature'},{workflow_ref:'other/repo/'+relay+'@'+ref},
    {sha:'bad'},{run_id:'not-a-number'},{run_attempt:'0'},
  ]) assert.equal(await verifyGithubPushEvent(
    await sign(pair.privateKey,changed),aud,trigger,pair.publicKey),null);
  assert.equal(await verifyGithubPushEvent(await sign(pair.privateKey,{},'wrong-audience'),
    aud,trigger,pair.publicKey),null);
  const forged=await generateKeyPair('RS256');
  assert.equal(await verifyGithubPushEvent(await sign(forged.privateKey),aud,
    trigger,pair.publicKey),null);
  const expired=await new SignJWT({...claims})
    .setProtectedHeader({alg:'RS256'}).setIssuer('https://token.actions.githubusercontent.com')
    .setAudience(aud).setIssuedAt(Math.floor(Date.now()/1000)-3600)
    .setExpirationTime(Math.floor(Date.now()/1000)-3540).sign(pair.privateKey);
  assert.equal(await verifyGithubPushEvent(expired,aud,trigger,pair.publicKey),null);
  const notGithub=await new SignJWT({...claims})
    .setProtectedHeader({alg:'RS256'}).setIssuer('https://attacker.example.invalid')
    .setAudience(aud).setIssuedAt().setExpirationTime('3m').sign(pair.privateKey);
  assert.equal(await verifyGithubPushEvent(notGithub,aud,trigger,pair.publicKey),null);
});

test('GitHub OIDC ingress admits one Run per verified Actions run; rerun replays even if attempt changed',async t=>{
  const s=setup(t),pair=await generateKeyPair('RS256');
  const created=await s.service.create(JSON.stringify(wf()));
  const published=await s.service.publish(created.workflow_id,1);
  const token=await sign(pair.privateKey);
  const invoke=(jwt:string,body?:string)=>
    handleGithubEvent(request(created.workflow_id,jwt,body),s.env,pair.publicKey);
  assert.equal((await invoke('invalid')).status,401);
  assert.equal((await invoke(token,'{"forged":"field"}')).status,400);
  assert.equal(s.dispatches,0);
  assert.equal((await invoke(token,'')).status,202,
    'zero-byte POST stream must behave like a bodyless signed event');
  assert.equal(s.dispatches,1);
  await assert.rejects(()=>s.service.start(created.workflow_id,{},'github-event-forged'),
    (e:unknown)=>e instanceof StateError&&e.code==='reserved_idempotency_key');
  const first=await invoke(token);
  assert.equal(first.status,200);
  const data=await first.json() as {run_id:string;published_version_id:string};
  assert.equal(data.published_version_id,published.published_version_id);
  assert.equal((await invoke(token)).status,200);
  const rerun=await invoke(await sign(pair.privateKey,{run_attempt:'2'}));
  assert.equal(rerun.status,200,'rerun must not re-dispatch the same GitHub event');
  assert.equal((await rerun.json() as {run_id:string}).run_id,data.run_id);
  assert.equal(s.dispatches,1);
  const inserted=s.db.prepare('SELECT admission_key,inputs FROM runs LIMIT 1').get() as
    {admission_key:string;inputs:string};
  assert.equal(inserted.admission_key,'github-event-40196774962');
  assert.deepEqual(JSON.parse(inserted.inputs).github,{
    repository:id,repository_id:repoId,event:'push',ref,sha:'a'.repeat(40),run_id:'40196774962',
  });
  assert.equal((await invoke(await sign(pair.privateKey,{run_id:'40196774963'}))).status,202);
  assert.equal(s.dispatches,2);
  assert.equal((await admitScheduledCron(s.env,Date.UTC(2026,9,25,12,30))).failed,0);
  await s.service.pause(created.workflow_id);
  assert.equal((await invoke(await sign(pair.privateKey,{run_id:'40196774964'}))).status,409);
  await s.service.resume(created.workflow_id);
  await s.service.update(created.workflow_id,1,JSON.stringify(wf({ref:'refs/heads/release'})));
  await s.service.publish(created.workflow_id,2);
  assert.equal((await invoke(token)).status,401,'old ref is no longer an authorized source');
  await s.service.update(created.workflow_id,2,JSON.stringify({...wf(),name:'New published revision'}));
  await s.service.publish(created.workflow_id,3);
  assert.equal((await invoke(token)).status,409,
    'same signed identity must not reuse an old event Run under a new Published Version');
  assert.equal(s.dispatches,2);
});
