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
const {default:worker}=await import('../src/index.ts');
hook.deregister();

const TOKEN='disposable-portal-token-cron-t09';
const ORIGIN='https://owner.example.org/mcp';
type Tick=Record<string, unknown> & {admissions: Array<Record<string, unknown>>; exactly_once: boolean};

function cronDefinition(expression:string, name='Scheduled'){
  return {version:1,name,triggers:[{id:'schedule',type:'cron',expression}],
    steps:[{id:'emit',uses:'result.emit',with:{data:{ref:'inputs.event'}}}]};
}
function setup(t:test.TestContext){
  const sqlite=new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  for(const file of ['0001_s1.sql','0002_native_complete_seen.sql','0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql','0005_github_workflow_check.sql','0006_github_registered_action.sql','0007_run_cancel.sql','0008_grant_revocation.sql','0009_runtime_approval.sql','0010_child_run.sql'])
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
    DB:{prepare,async batch(items:{run:()=>Promise<unknown>}[]){return Promise.all(items.map(item=>item.run()));}},
    WORKFLOW:{async create(options:{id:string}){creates.push(options.id);},async get(){return {async status(){return {status:'running'};}};}},
  } as unknown as Env;
  return {env,creates};
}
async function connect(t:test.TestContext, env:Env){
  const client=new Client({name:'cron-schedule-test',version:'0.1.0'});
  const transport=new StreamableHTTPClientTransport(new URL(ORIGIN),{
    requestInit:{headers:{authorization:'Bearer '+TOKEN}},
    fetch:(async(input:RequestInfo|URL,init?:RequestInit)=>worker.fetch(new Request(input,init),env)) as typeof fetch,
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
    return value;
  }
  return call;
}
async function tick(env:Env, scheduledTime:number, cron='* * * * *'):Promise<Tick>{
  const result=await worker.scheduled({cron,scheduledTime,noRetry(){}},env,{waitUntil(){}});
  assert.equal(result.exactly_once,false);
  assert.equal(result.gap,'missed_platform_tick_not_backfilled');
  assert.equal(result.timezone,'UTC');
  assert.equal(result.dst,'not_applicable');
  assert.equal(result.minimum_interval_seconds,60);
  return result as Tick;
}
function forWorkflow(result:Tick, workflowId:string){
  return result.admissions.filter(item=>item.workflow_id===workflowId);
}

test('catalog, schema, and publish state the cron contract and reject a bad expression',async t=>{
  const {env,creates}=setup(t);
  const call=await connect(t,env);
  const overview=await call('workflow_capabilities',{});
  assert.equal(overview.definition.cron.timezone,'UTC');
  assert.equal(overview.definition.cron.dst,'not_applicable');
  assert.equal(overview.definition.cron.minimum_interval_seconds,60);
  assert.equal(overview.definition.cron.permission,'authenticated_publish_only');
  assert.equal(overview.definition.cron.exactly_once,false);
  assert.equal(overview.definition.cron.gap,'missed_platform_tick_not_backfilled');
  assert.equal(overview.definition.schema.properties.triggers.maxItems,3);
  const detail=await call('workflow_capabilities',{id:'trigger.cron'});
  assert.equal(detail.status,'supported');
  assert.equal(detail.schema.additionalProperties,false);
  assert.match(detail.schema.properties.expression.description,/0 and 7 are Sunday/);
  assert.match(detail.permissions,/authenticated workflow_publish/);
  assert.match(detail.completion,/does not promise exactly-once/);
  assert.equal((await call('workflow_validate',{definition:JSON.stringify(detail.example)})).valid,true);
  const badExpressions=['* * * * * *','*/0 * * * *','60 * * * *','@hourly','0 9 * * MON','0 9 * * * Asia/Shanghai','0 0 31 2 *','0 0 L * *','0 0 * * 1#1'];
  for(const expression of badExpressions){
    const rejected=await call('workflow_validate',{definition:JSON.stringify(cronDefinition(expression))});
    assert.equal(rejected.valid,false,expression);
    assert.equal(rejected.issues[0].code,'invalid_cron',expression);
    assert.equal(rejected.issues[0].path,'/triggers/0/expression');
  }
  const leap=await call('workflow_validate',{definition:JSON.stringify(cronDefinition('0 0 29 2 *'))});
  assert.equal(leap.valid,true);
  const zone=await call('workflow_validate',{definition:JSON.stringify({...cronDefinition('15 * * * *'),triggers:[{id:'schedule',type:'cron',expression:'15 * * * *',timezone:'Asia/Shanghai'}]})});
  assert.equal(zone.issues[0].code,'unsupported_field');
  assert.equal(zone.issues[0].path,'/triggers/0/timezone');
  const topLevel=await call('workflow_validate',{definition:JSON.stringify({version:1,name:'Cron',cron:'* * * * *',steps:[{id:'emit',uses:'result.emit',with:{data:'ok'}}]})});
  assert.equal(topLevel.issues[0].code,'unsupported_field');
  assert.equal(topLevel.issues[0].path,'/cron');
  const route=await worker.fetch(new Request('https://workflow.example.org/triggers/cron/00000000-0000-4000-8000-000000000000',{
    method:'POST',headers:{'content-type':'application/json'},body:'{}',
  }),env);
  assert.equal(route.status,404);
  const created=await call('workflow_create',{definition:JSON.stringify(cronDefinition('15 * * * *'))});
  const quiet=await tick(env,Date.UTC(2026,9,23,12,15));
  assert.deepEqual(forWorkflow(quiet,created.workflow_id),[]);
  assert.equal(creates.length,0);
  const published=await call('workflow_publish',{workflow_id:created.workflow_id,expected_revision:1});
  assert.equal(published.cron.expression,'15 * * * *');
  assert.equal(published.cron.timezone,'UTC');
  assert.equal(published.cron.dst,'not_applicable');
  assert.equal(published.cron.minimum_interval_seconds,60);
  assert.equal(published.cron.permission,'authenticated_publish_only');
  assert.equal(published.cron.dedupe,'utc_scheduled_minute');
  assert.equal(published.cron.exactly_once,false);
  assert.equal(published.cron.platform_cron,'* * * * *');
  const again=await call('workflow_publish',{workflow_id:created.workflow_id,expected_revision:1});
  assert.equal(again.published_version_id,published.published_version_id);
  assert.equal(again.cron.expression,'15 * * * *');
  const matched=await tick(env,Date.UTC(2026,9,23,12,15));
  assert.equal(forWorkflow(matched,created.workflow_id)[0]?.published_version_id,published.published_version_id);
  const skippedMinute=await tick(env,Date.UTC(2026,9,23,12,16));
  assert.deepEqual(forWorkflow(skippedMinute,created.workflow_id),[]);
  assert.equal(creates.length,1);
});

test('a duplicate or late scheduled wake admits one logical run and a missed minute is not backfilled',async t=>{
  const {env,creates}=setup(t);
  const call=await connect(t,env);
  const first=await call('workflow_create',{definition:JSON.stringify(cronDefinition('* 12 23 10 *','Every minute'))});
  const second=await call('workflow_create',{definition:JSON.stringify(cronDefinition('* 12 23 10 *','Also every minute'))});
  await call('workflow_publish',{workflow_id:first.workflow_id,expected_revision:1});
  await call('workflow_publish',{workflow_id:second.workflow_id,expected_revision:1});
  const minute=Date.UTC(2026,9,23,12,0);
  let ignored=false;
  const wrong=await worker.scheduled({cron:'*/5 * * * *',scheduledTime:minute,noRetry(){ignored=true;}},env,{waitUntil(){}});
  assert.equal(ignored,true);
  assert.equal('ignored' in wrong?wrong.ignored:undefined,'unsupported_platform_cron');
  assert.equal(wrong.exactly_once,false);
  assert.equal(creates.length,0);
  const opened=await tick(env,minute+10_000);
  assert.equal(opened.admissions.length,2);
  assert.equal(opened.admissions.every(item=>item.exactly_once===false&&item.dedupe==='stable_event_id'),true);
  const late=await tick(env,minute+40_000);
  assert.equal(late.admissions.length,2);
  assert.deepEqual(late.admissions.map(item=>item.run_id).sort(),opened.admissions.map(item=>item.run_id).sort());
  assert.equal(late.admissions.every(item=>item.idempotent_replay===true),true);
  assert.equal(creates.length,2);
  const skipped=minute+120_000;
  const jumped=await tick(env,skipped);
  assert.equal(jumped.admissions.length,2);
  assert.equal(jumped.admissions.every(item=>item.idempotent_replay===undefined),true);
  const filled=await tick(env,minute+60_000);
  assert.equal(filled.admissions.every(item=>item.idempotent_replay===undefined),true);
  assert.equal(creates.length,6);
});

test('Sunday is 0 or 7, and a restricted day-of-month or day-of-week can match',async t=>{
  const {env,creates}=setup(t);
  const call=await connect(t,env);
  const sunday=await call('workflow_create',{definition:JSON.stringify(cronDefinition('0 0 * * 7','Sundays'))});
  const sundayVersion=await call('workflow_publish',{workflow_id:sunday.workflow_id,expected_revision:1});
  const either=await call('workflow_create',{definition:JSON.stringify(cronDefinition('0 0 1 * 1','First or Monday'))});
  await call('workflow_publish',{workflow_id:either.workflow_id,expected_revision:1});
  const onSunday=await tick(env,Date.UTC(2026,9,4,0,0,20));
  const sundayRun=forWorkflow(onSunday,sunday.workflow_id);
  assert.equal(sundayRun.length,1);
  assert.equal(sundayRun[0]?.published_version_id,sundayVersion.published_version_id);
  assert.deepEqual(forWorkflow(onSunday,either.workflow_id),[]);
  const onMonday=await tick(env,Date.UTC(2026,9,5,0,0));
  assert.deepEqual(forWorkflow(onMonday,sunday.workflow_id),[]);
  assert.equal(forWorkflow(onMonday,either.workflow_id).length,1);
  const firstOfMonth=await tick(env,Date.UTC(2026,9,1,0,0));
  const friday=await tick(env,Date.UTC(2026,9,2,0,0));
  assert.equal(forWorkflow(firstOfMonth,either.workflow_id).length,1);
  assert.deepEqual(forWorkflow(friday,either.workflow_id),[]);
  assert.deepEqual(forWorkflow(friday,sunday.workflow_id),[]);
  assert.notEqual(forWorkflow(firstOfMonth,either.workflow_id)[0]?.run_id,forWorkflow(onMonday,either.workflow_id)[0]?.run_id);
  assert.equal(creates.length,3);
});

test('pause suppresses a new cron admission and an in-flight run stays on its published version',async t=>{
  const {env,creates}=setup(t);
  const call=await connect(t,env);
  const created=await call('workflow_create',{definition:JSON.stringify(cronDefinition('0 * * * *','Hourly'))});
  const firstVersion=await call('workflow_publish',{workflow_id:created.workflow_id,expected_revision:1});
  const atNoon=await tick(env,Date.UTC(2026,9,23,12,0,5));
  const admitted=forWorkflow(atNoon,created.workflow_id)[0];
  assert.equal(admitted?.published_version_id,firstVersion.published_version_id);
  assert.equal(creates.length,1);
  const movedEarly=await call('workflow_update',{
    workflow_id:created.workflow_id,expected_revision:1,definition:JSON.stringify(cronDefinition('30 * * * *','Hourly')),
  });
  const draftOnly=await tick(env,Date.UTC(2026,9,23,12,30));
  assert.deepEqual(forWorkflow(draftOnly,created.workflow_id),[]);
  const stillOld=await tick(env,Date.UTC(2026,9,23,13,0));
  assert.equal(forWorkflow(stillOld,created.workflow_id)[0]?.published_version_id,firstVersion.published_version_id);
  const renamed=await call('workflow_update',{
    workflow_id:created.workflow_id,expected_revision:movedEarly.draft_revision,definition:JSON.stringify(cronDefinition('0 * * * *','Hourly renamed')),
  });
  const secondVersion=await call('workflow_publish',{workflow_id:created.workflow_id,expected_revision:renamed.draft_revision});
  assert.notEqual(secondVersion.published_version_id,firstVersion.published_version_id);
  assert.equal(secondVersion.cron.expression,'0 * * * *');
  const replay=await tick(env,Date.UTC(2026,9,23,12,0,50));
  assert.equal(forWorkflow(replay,created.workflow_id)[0]?.run_id,admitted?.run_id);
  assert.equal(forWorkflow(replay,created.workflow_id)[0]?.published_version_id,firstVersion.published_version_id);
  assert.equal(forWorkflow(replay,created.workflow_id)[0]?.idempotent_replay,true);
  const pinned=await call('workflow_status',{run_id:admitted?.run_id});
  assert.equal(pinned.published_version_id,firstVersion.published_version_id);
  const nextHour=await tick(env,Date.UTC(2026,9,23,14,0));
  assert.equal(forWorkflow(nextHour,created.workflow_id)[0]?.published_version_id,secondVersion.published_version_id);
  const moved=await call('workflow_update',{
    workflow_id:created.workflow_id,expected_revision:renamed.draft_revision,definition:JSON.stringify(cronDefinition('30 * * * *','Hourly renamed')),
  });
  const thirdVersion=await call('workflow_publish',{workflow_id:created.workflow_id,expected_revision:moved.draft_revision});
  assert.equal(thirdVersion.cron.expression,'30 * * * *');
  const half=await tick(env,Date.UTC(2026,9,23,14,30));
  assert.equal(forWorkflow(half,created.workflow_id)[0]?.published_version_id,thirdVersion.published_version_id);
  const oldMinute=await tick(env,Date.UTC(2026,9,23,15,0));
  assert.deepEqual(forWorkflow(oldMinute,created.workflow_id),[]);
  const pinnedAfterMove=await call('workflow_status',{run_id:admitted?.run_id});
  assert.equal(pinnedAfterMove.published_version_id,firstVersion.published_version_id);
  await call('workflow_pause',{workflow_id:created.workflow_id});
  const whilePaused=await tick(env,Date.UTC(2026,9,23,15,30));
  assert.equal(forWorkflow(whilePaused,created.workflow_id)[0]?.error,'workflow_not_active');
  assert.equal(creates.length,4);
  const replayPaused=await tick(env,Date.UTC(2026,9,23,14,30,20));
  assert.equal(forWorkflow(replayPaused,created.workflow_id)[0]?.run_id,forWorkflow(half,created.workflow_id)[0]?.run_id);
  assert.equal(forWorkflow(replayPaused,created.workflow_id)[0]?.idempotent_replay,true);
  assert.equal(creates.length,4);
  await call('workflow_resume',{workflow_id:created.workflow_id});
  const afterResume=await tick(env,Date.UTC(2026,9,23,16,30));
  assert.equal(forWorkflow(afterResume,created.workflow_id)[0]?.published_version_id,thirdVersion.published_version_id);
  assert.equal(creates.length,5);
  const removed=await call('workflow_update',{
    workflow_id:created.workflow_id,expected_revision:moved.draft_revision,
    definition:JSON.stringify({version:1,name:'Hourly off',steps:[{id:'emit',uses:'result.emit',with:{data:'ok'}}]}),
  });
  const disabled=await call('workflow_publish',{workflow_id:created.workflow_id,expected_revision:removed.draft_revision});
  assert.equal(disabled.cron,undefined);
  const afterDisable=await tick(env,Date.UTC(2026,9,23,17,30));
  assert.deepEqual(forWorkflow(afterDisable,created.workflow_id),[]);
  assert.equal(creates.length,5);
  const manual=await call('workflow_run',{workflow_id:created.workflow_id,inputs:{event:'manual'}});
  assert.notEqual(manual.run_id,admitted?.run_id);
  assert.equal(manual.published_version_id,disabled.published_version_id);
  assert.equal(creates.length,6);
});
