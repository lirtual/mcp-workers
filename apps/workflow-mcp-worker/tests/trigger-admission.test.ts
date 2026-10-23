import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Env } from '../src/store.ts';

const hook=registerHooks({resolve(specifier,context,next){
  if(specifier==='cloudflare:workers')return {
    url:'data:text/javascript,export class WorkflowEntrypoint { constructor(ctx,env){this.env=env;} }',
    shortCircuit:true,
  };
  return next(specifier,context);
}});
const {default:ownerWorker}=await import('../src/index.ts');
hook.deregister();

const TOKEN='disposable-portal-token-trigger-t08';
const ORIGIN='https://owner.example.org/mcp';
const SOURCE='approved-webhook';
const WEBHOOK_SECRET='test-webhook-secret-value';
const GITHUB_SECRET='test-github-webhook-secret';
const REPO='lirtual/mcp-workers';

async function sign(secret:string, body:string):Promise<string>{
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const mac=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return 'sha256='+[...new Uint8Array(mac)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
function webhookDefinition(name='Hooked'){
  return {version:1,name,triggers:[{id:'hook',type:'webhook',source:SOURCE,event:'submitted'}],
    steps:[{id:'emit',uses:'result.emit',with:{data:{ref:'inputs.event'}}}]};
}
function githubDefinition(){
  return {version:1,name:'On push',triggers:[{id:'gh',type:'github_event',repository:REPO,events:['push']}],
    steps:[{id:'emit',uses:'result.emit',with:{data:{ref:'inputs.event'}}}]};
}

function setup(t:test.TestContext){
  const sqlite=new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  for(const file of ['0001_s1.sql','0002_native_complete_seen.sql','0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql','0005_github_workflow_check.sql','0006_github_registered_action.sql','0007_run_cancel.sql','0008_grant_revocation.sql','0009_runtime_approval.sql','0010_child_run.sql','0011_cron_due.sql','0012_cron_due_bounds.sql'])
    sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  function prepare(sql:string){
    let args:any[]=[];
    return {
      bind(...values:any[]){args=values;return this;},
      async first(){return sqlite.prepare(sql).get(...args)??null;},
      async all(){return {results:sqlite.prepare(sql).all(...args)};},
      async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};},
    };
  }
  const creates:string[]=[];
  const env={
    MCP_ACCESS_TOKEN:TOKEN,
    WEBHOOK_TRIGGER_SOURCE:SOURCE,
    WEBHOOK_TRIGGER_SECRET:WEBHOOK_SECRET,
    GITHUB_WEBHOOK_SECRET:GITHUB_SECRET,
    GITHUB_EXECUTOR_REPOSITORY:REPO,
    DB:{prepare,async batch(items:{run:()=>Promise<unknown>}[]){return Promise.all(items.map(item=>item.run()));}},
    WORKFLOW:{async create(options:{id:string}){creates.push(options.id);},async get(){return {async status(){return {status:'running'};}};}},
  } as unknown as Env;
  return {env,creates};
}

async function connect(t:test.TestContext, env:Env){
  const client=new Client({name:'trigger-admission-test',version:'0.1.0'});
  const transport=new StreamableHTTPClientTransport(new URL(ORIGIN),{
    requestInit:{headers:{authorization:'Bearer '+TOKEN}},
    fetch:(async(input:RequestInfo|URL,init?:RequestInit)=>ownerWorker.fetch(new Request(input,init),env)) as typeof fetch,
  });
  await client.connect(transport);
  t.after(()=>client.close());
  async function call(name:string,args:Record<string,unknown>,error?:string):Promise<any>{
    const output=await client.callTool({name,arguments:args});
    const first=output.content[0];
    if(!first||first.type!=='text')throw Error('unexpected_tool_content');
    const value=JSON.parse(first.text);
    if(error){
      assert.equal(output.isError,true);
      assert.equal(value.error,error);
    }else assert.notEqual(output.isError,true,first.text);
    assert.equal(first.text.includes(WEBHOOK_SECRET),false);
    assert.equal(first.text.includes(GITHUB_SECRET),false);
    return value;
  }
  return call;
}

async function post(env:Env, path:string, secret:string, body:unknown, headers:Record<string,string>, signature?:string|null){
  const text=JSON.stringify(body);
  const requestHeaders=new Headers({'content-type':'application/json',...headers});
  if(signature!==null)requestHeaders.set(
    path.includes('/github/')?'x-hub-signature-256':'x-workflow-signature-256',
    signature??await sign(secret,text),
  );
  return ownerWorker.fetch(new Request('https://workflow.example.org'+path,{method:'POST',headers:requestHeaders,body:text}),env);
}
async function read(response:Response):Promise<any>{
  const text=await response.text();
  assert.equal(text.includes(WEBHOOK_SECRET),false,text);
  assert.equal(text.includes(GITHUB_SECRET),false,text);
  return {status:response.status,text,body:JSON.parse(text)};
}

test('publish rejects an unauthorized trigger source and illegal trigger input',async t=>{
  const {env}=setup(t);
  const call=await connect(t,env);
  const leaked={...webhookDefinition(),triggers:[{id:'hook',type:'webhook',source:SOURCE,event:'submitted',secret:WEBHOOK_SECRET}]};
  const invalid=await call('workflow_validate',{definition:JSON.stringify(leaked)});
  assert.equal(invalid.valid,false);
  assert.equal(invalid.issues[0].code,'unsupported_field');
  assert.equal(invalid.issues[0].path,'/triggers/0/secret');
  assert.equal(JSON.stringify(invalid).includes(WEBHOOK_SECRET),false);
  const native=await call('workflow_validate',{definition:JSON.stringify({
    version:1,name:'Native',triggers:[{id:'gh',type:'github_event',repository:REPO,events:['workflow_run']}],
    steps:[{id:'emit',uses:'result.emit',with:{data:'ok'}}],
  })});
  assert.equal(native.issues[0].code,'unsupported_github_event');
  assert.equal(native.issues[0].path,'/triggers/0/events/0');
  const cron=await call('workflow_validate',{definition:JSON.stringify({version:1,name:'Cron',cron:'* * * * *',steps:[{id:'emit',uses:'result.emit',with:{data:'ok'}}]})});
  assert.equal(cron.issues[0].code,'unsupported_field');
  assert.equal(cron.issues[0].path,'/cron');

  const other=await call('workflow_create',{definition:JSON.stringify({...webhookDefinition('Other'),triggers:[{id:'hook',type:'webhook',source:'other-source',event:'submitted'}]})});
  await call('workflow_publish',{workflow_id:other.workflow_id,expected_revision:1},'webhook_source_not_authorized');
  assert.equal((await call('workflow_get',{workflow_id:other.workflow_id})).published_version_id,null);

  const unconfigured=await call('workflow_create',{definition:JSON.stringify(githubDefinition())});
  const savedSecret=env.GITHUB_WEBHOOK_SECRET;
  env.GITHUB_WEBHOOK_SECRET=undefined;
  await call('workflow_publish',{workflow_id:unconfigured.workflow_id,expected_revision:1},'github_event_source_not_configured');
  env.GITHUB_WEBHOOK_SECRET=savedSecret;
  env.GITHUB_EXECUTOR_REPOSITORY='other/repo';
  await call('workflow_publish',{workflow_id:unconfigured.workflow_id,expected_revision:1},'github_event_source_not_authorized');
  env.GITHUB_EXECUTOR_REPOSITORY=REPO;
  assert.equal((await call('workflow_get',{workflow_id:unconfigured.workflow_id})).published_version_id,null);
  const published=await call('workflow_publish',{workflow_id:unconfigured.workflow_id,expected_revision:1});
  assert.match(published.published_version_id,/^[0-9a-f-]{36}$/i);
});

test('a stable webhook id admits one Run; a missing id does not claim exactly-once',async t=>{
  const {env,creates}=setup(t);
  const call=await connect(t,env);
  const created=await call('workflow_create',{definition:JSON.stringify(webhookDefinition())});
  const published=await call('workflow_publish',{workflow_id:created.workflow_id,expected_revision:1});
  const path='/triggers/webhook/'+created.workflow_id;
  const first=await read(await post(env,path,WEBHOOK_SECRET,{n:1,label:'a'},{'x-workflow-event':'submitted','x-workflow-event-id':'delivery-1'}));
  assert.equal(first.status,200);
  assert.equal(first.body.exactly_once,false);
  assert.equal(first.body.dedupe,'stable_event_id');
  assert.equal(first.body.published_version_id,published.published_version_id);
  assert.equal(creates.length,1);
  const replay=await read(await post(env,path,WEBHOOK_SECRET,{label:'a',n:1},{'x-workflow-event':'submitted','x-workflow-event-id':'delivery-1'}));
  assert.equal(replay.status,200);
  assert.equal(replay.body.run_id,first.body.run_id);
  assert.equal(replay.body.idempotent_replay,true);
  assert.equal(replay.body.exactly_once,false);
  assert.equal(replay.body.published_version_id,published.published_version_id);
  assert.equal(creates.length,1);
  const conflict=await read(await post(env,path,WEBHOOK_SECRET,{n:2},{'x-workflow-event':'submitted','x-workflow-event-id':'delivery-1'}));
  assert.equal(conflict.status,409);
  assert.equal(conflict.body.error,'idempotency_conflict');
  assert.equal(creates.length,1);
  const missingA=await read(await post(env,path,WEBHOOK_SECRET,{n:1},{'x-workflow-event':'submitted'}));
  const missingB=await read(await post(env,path,WEBHOOK_SECRET,{n:1},{'x-workflow-event':'submitted'}));
  assert.equal(missingA.body.dedupe,'not_claimed');
  assert.equal(missingB.body.dedupe,'not_claimed');
  assert.equal(missingA.body.exactly_once,false);
  assert.equal(missingB.body.exactly_once,false);
  assert.notEqual(missingA.body.run_id,missingB.body.run_id);
  assert.equal(missingA.text.includes('"exactly_once":true'),false);
  assert.equal(creates.length,3);
  const manual=await call('workflow_run',{workflow_id:created.workflow_id,inputs:{event:'manual'}});
  assert.notEqual(manual.run_id,first.body.run_id);
  assert.equal(manual.exactly_once,undefined);
  assert.equal(creates.length,4);
});

test('invalid webhook and GitHub signatures are rejected without leaking the secret or admitting a Run',async t=>{
  const {env,creates}=setup(t);
  const call=await connect(t,env);
  const created=await call('workflow_create',{definition:JSON.stringify(webhookDefinition())});
  await call('workflow_publish',{workflow_id:created.workflow_id,expected_revision:1});
  const path='/triggers/webhook/'+created.workflow_id;
  const bad=await read(await post(env,path,WEBHOOK_SECRET,{n:1},{'x-workflow-event':'submitted','x-workflow-event-id':'delivery-9'},'sha256='+'ab'.repeat(32)));
  assert.equal(bad.status,401);
  assert.equal(bad.body.error,'invalid_signature');
  assert.equal(bad.text.includes('ab'.repeat(32)),false);
  assert.equal(creates.length,0);
  const missing=await read(await post(env,path,WEBHOOK_SECRET,{n:1},{'x-workflow-event':'submitted'},null));
  assert.equal(missing.status,401);
  assert.equal(missing.body.error,'invalid_signature');
  const leaked=await read(await post(env,path,WEBHOOK_SECRET,{token:WEBHOOK_SECRET},{'x-workflow-event':'submitted','x-workflow-event-id':'delivery-9'}));
  assert.equal(leaked.status,400);
  assert.equal(leaked.body.error,'invalid_input');
  assert.equal(creates.length,0);
  const github=await call('workflow_create',{definition:JSON.stringify(githubDefinition())});
  await call('workflow_publish',{workflow_id:github.workflow_id,expected_revision:1});
  const githubPath='/triggers/github/'+github.workflow_id;
  const forged=await read(await post(env,githubPath,GITHUB_SECRET,{repository:{full_name:REPO}},{
    'x-github-event':'push','x-github-delivery':'delivery-gh-bad',
  },'sha256='+'cd'.repeat(32)));
  assert.equal(forged.status,401);
  assert.equal(forged.body.error,'invalid_signature');
  assert.equal(forged.text.includes('cd'.repeat(32)),false);
  assert.equal(creates.length,0);
  const callback=await ownerWorker.fetch(new Request('https://workflow.example.org/github/callback',{
    method:'POST',headers:{'content-type':'application/json','x-github-event':'push','x-hub-signature-256':await sign(GITHUB_SECRET,JSON.stringify({action:'completed'}))},
    body:JSON.stringify({action:'completed'}),
  }),env);
  assert.notEqual(callback.status,200);
  assert.equal((await callback.text()).includes(GITHUB_SECRET),false);
  assert.equal(creates.length,0);
});

test('version switch, pause, and replay keep the admitted Run pinned',async t=>{
  const {env,creates}=setup(t);
  const call=await connect(t,env);
  const created=await call('workflow_create',{definition:JSON.stringify(webhookDefinition('Versioned'))});
  const firstVersion=await call('workflow_publish',{workflow_id:created.workflow_id,expected_revision:1});
  const path='/triggers/webhook/'+created.workflow_id;
  const admitted=await read(await post(env,path,WEBHOOK_SECRET,{n:1},{'x-workflow-event':'submitted','x-workflow-event-id':'pinned-1'}));
  assert.equal(admitted.body.published_version_id,firstVersion.published_version_id);
  const updated=await call('workflow_update',{workflow_id:created.workflow_id,expected_revision:1,definition:JSON.stringify(webhookDefinition('Versioned again'))});
  const secondVersion=await call('workflow_publish',{workflow_id:created.workflow_id,expected_revision:updated.draft_revision});
  assert.notEqual(secondVersion.published_version_id,firstVersion.published_version_id);
  const replay=await read(await post(env,path,WEBHOOK_SECRET,{n:1},{'x-workflow-event':'submitted','x-workflow-event-id':'pinned-1'}));
  assert.equal(replay.body.run_id,admitted.body.run_id);
  assert.equal(replay.body.published_version_id,firstVersion.published_version_id);
  assert.equal(replay.body.idempotent_replay,true);
  const late=await read(await post(env,path,WEBHOOK_SECRET,{n:1},{'x-workflow-event':'submitted','x-workflow-event-id':'pinned-2'}));
  assert.equal(late.body.published_version_id,secondVersion.published_version_id);
  assert.notEqual(late.body.run_id,admitted.body.run_id);
  await call('workflow_pause',{workflow_id:created.workflow_id});
  const whilePaused=await read(await post(env,path,WEBHOOK_SECRET,{n:1},{'x-workflow-event':'submitted','x-workflow-event-id':'pinned-3'}));
  assert.equal(whilePaused.status,409);
  assert.equal(whilePaused.body.error,'workflow_not_active');
  const replayWhilePaused=await read(await post(env,path,WEBHOOK_SECRET,{n:1},{'x-workflow-event':'submitted','x-workflow-event-id':'pinned-1'}));
  assert.equal(replayWhilePaused.status,200);
  assert.equal(replayWhilePaused.body.run_id,admitted.body.run_id);
  assert.equal(creates.length,2);
  await call('workflow_resume',{workflow_id:created.workflow_id});
  const afterResume=await read(await post(env,path,WEBHOOK_SECRET,{n:1},{'x-workflow-event':'submitted','x-workflow-event-id':'pinned-3'}));
  assert.equal(afterResume.status,200);
  assert.equal(afterResume.body.published_version_id,secondVersion.published_version_id);
  assert.equal(creates.length,3);
});

test('GitHub delivery dedupes one Run and cannot enter through the executor callback',async t=>{
  const {env,creates}=setup(t);
  const call=await connect(t,env);
  const created=await call('workflow_create',{definition:JSON.stringify(githubDefinition())});
  await call('workflow_publish',{workflow_id:created.workflow_id,expected_revision:1});
  const path='/triggers/github/'+created.workflow_id;
  const body={repository:{full_name:REPO},ref:'refs/heads/main'};
  const headers={'x-github-event':'push','x-github-delivery':'delivery-gh-1'};
  const first=await read(await post(env,path,GITHUB_SECRET,body,headers));
  assert.equal(first.status,200);
  assert.equal(first.body.dedupe,'stable_event_id');
  assert.equal(first.body.exactly_once,false);
  const again=await read(await post(env,path,GITHUB_SECRET,body,headers));
  assert.equal(again.body.run_id,first.body.run_id);
  assert.equal(again.body.idempotent_replay,true);
  assert.equal(creates.length,1);
  const wrongRepo=await read(await post(env,path,GITHUB_SECRET,{repository:{full_name:'evil/other'}},{'x-github-event':'push','x-github-delivery':'delivery-gh-wrong'}));
  assert.equal(wrongRepo.status,403);
  assert.equal(wrongRepo.body.error,'unauthorized_source');
  const native=await read(await post(env,path,GITHUB_SECRET,body,{'x-github-event':'workflow_job','x-github-delivery':'delivery-gh-2'}));
  assert.equal(native.status,403);
  assert.equal(native.body.error,'unauthorized_event');
  assert.equal(creates.length,1);
  const unnamed=await read(await post(env,path,GITHUB_SECRET,body,{'x-github-event':'push'}));
  const unnamedAgain=await read(await post(env,path,GITHUB_SECRET,body,{'x-github-event':'push'}));
  assert.equal(unnamed.body.dedupe,'not_claimed');
  assert.equal(unnamed.body.exactly_once,false);
  assert.notEqual(unnamed.body.run_id,unnamedAgain.body.run_id);
  assert.equal(creates.length,3);
  const reserved=await call('workflow_run',{
    workflow_id:created.workflow_id,
    idempotency_key:'evt_'+'ab'.repeat(32),
  },'invalid_idempotency_key');
  assert.equal(reserved.error,'invalid_idempotency_key');
  assert.equal(creates.length,3);
});
