/**
 * Real Cloudflare-native awaited-child acceptance for Draft PR #291.
 * Only disposable Worker + Workflow + D1; production routing/Portal is untouched.
 * The native Workflow binding is essential: wrangler dev --remote/Previews
 * cannot validate a separate native Workflow implementation.
 */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {writeFileSync,unlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

const branch='refs/heads/feat/176-child-capacity-foundation';
assert.equal(process.env.GITHUB_REPOSITORY,'lirtual/mcp-workers');
assert.equal(process.env.GITHUB_REF,branch,'No production or arbitrary branch execution');
const token=process.env.CLOUDFLARE_API_TOKEN;
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
assert.ok(token && /^[0-9a-f]{32}$/.test(account??''),'Isolated Cloudflare permission required');
const run=process.env.GITHUB_RUN_ID;
const attempt=process.env.GITHUB_RUN_ATTEMPT;
assert.match(run??'',/^[0-9]+$/);
assert.match(attempt??'',/^[0-9]+$/);
const suffix=run+'-'+attempt;
const resource='workflow-child-acc-'+suffix;
const dbName=resource;
const workerName=resource;
const workflowName=resource;
const root='/accounts/'+account;
const configName='.acceptance-child-'+suffix+'.json';
const configPath=new URL('../'+configName,import.meta.url);
const wrapperPath=new URL('../.acceptance-child-'+suffix+'.ts',import.meta.url);
const secretPath=new URL('../.acceptance-child-'+suffix+'.secrets.json',import.meta.url);
const workdir=fileURLToPath(new URL('..',import.meta.url));
const ownerToken=randomBytes(32).toString('hex');
let databaseId=null,workerCreated=false,workflowCreated=false,client=null,failed=false;
const errors=[];
function diagnostic(error){
  return String(error instanceof Error?error.message:'unknown')
    .replaceAll(token,'[redacted]').replaceAll(ownerToken,'[redacted]').slice(0,300);
}
async function api(method,path,body){
  const response=await fetch('https://api.cloudflare.com/client/v4'+path,{
    method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
    signal:AbortSignal.timeout(30000),
  });
  const value=await response.json().catch(()=>null);
  if(!response.ok || value?.success!==true)throw Error('Cloudflare '+method+' '+path.split('/').at(-1)+' HTTP '+response.status);
  return value.result;
}
async function query(sql,params=[]){
  const result=await api('POST',root+'/d1/database/'+databaseId+'/query',{sql,params});
  assert.equal(result[0]?.success,true,'D1 query failed');
  return result[0];
}
function wrangler(args,timeout=180000){
  const result=spawnSync('pnpm',['exec','wrangler',...args],{
    cwd:workdir,encoding:'utf8',timeout,
    env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},
    stdio:['ignore','pipe','pipe'],
  });
  if(result.status!==0)throw Error('Wrangler '+args[0]+' failed (exit '+result.status+')');
}
async function tool(name,args){
  const response=await client.callTool({name,arguments:args});
  const text=response.content?.find(c=>c.type==='text')?.text;
  assert.ok(text,name+' returned no text');
  const value=JSON.parse(text);
  assert.notEqual(response.isError,true,name+' failed: '+JSON.stringify(value).slice(0,240));
  return value;
}
async function settle(runId){
  for(let i=0;i<90;i++){
    const status=await tool('workflow_result',{run_id:runId});
    if(['succeeded','failed','cancelled','indeterminate'].includes(status.status))return status;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw Error('Native Workflow did not reach a D1 terminal state');
}
async function acceptance(){
  const existing=await api('GET',root+'/d1/database');
  assert.ok(!existing.some(x=>x.name===resource),'Refuse reusing an existing test resource');
  const created=await api('POST',root+'/d1/database',{name:dbName});
  databaseId=created.uuid;
  assert.match(databaseId,/^[0-9a-f-]{36}$/i);
  const config={
    name:workerName,main:'.acceptance-child-'+suffix+'.ts',compatibility_date:'2026-09-10',
    workers_dev:true,preview_urls:false,
    d1_databases:[{binding:'DB',database_name:dbName,database_id:databaseId,migrations_dir:'migrations'}],
    workflows:[{name:workflowName,binding:'WORKFLOW',class_name:'AcceptanceOrchestrator'}],
  };
  writeFileSync(wrapperPath,`import app,{WorkflowOrchestrator} from './src/index.ts';\nexport default app;\nexport class AcceptanceOrchestrator extends WorkflowOrchestrator {\n  async run(event,step){\n    const row=await this.env.DB.prepare('SELECT parent_run_id,inputs FROM runs WHERE id=?').bind(event.payload.run_id).first();\n    const proof=row?.parent_run_id?JSON.parse(row.inputs).proof:null;\n    if(proof==='cancel-test')\n      await step.sleep('acceptance-child-hold',30000);\n    if(proof==='cancel-entry')\n      await step.sleep('acceptance-child-before-entry',15000);\n    if(proof==='late-result'){\n      const wrapped={\n        do:async(...args)=>{\n          if(args[0]==='workflow-emit')\n            await step.sleep('acceptance-child-after-entry',15000);\n          return step.do(...args);\n        },\n        sleep:(...args)=>step.sleep(...args),\n      };\n      return super.run(event,wrapped);\n    }\n    return super.run(event,step);\n  }\n}\n`,{mode:0o600});
  writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
  writeFileSync(secretPath,JSON.stringify({MCP_ACCESS_TOKEN:ownerToken}),{mode:0o600});
  wrangler(['d1','migrations','apply',dbName,'--remote','--config',configName]);
  const migration=(await query("SELECT COUNT(*) AS n FROM d1_migrations WHERE name='0011_awaited_child_capacity.sql'")).results[0];
  assert.equal(migration.n,1,'Migration 0011 absent on disposable D1');
  // Mark both resources for cleanup before upload: a failed deploy may leave
  // a partially registered native Workflow.
  workerCreated=true;
  workflowCreated=true;
  wrangler(['deploy','--config',configName,'--secrets-file',fileURLToPath(secretPath)]);
  const url='https://'+workerName+'.aiyaya.workers.dev';
  let ready=false;
  for(let i=0;i<30;i++){
    try{
      const r=await fetch(url+'/mcp',{signal:AbortSignal.timeout(4000)});
      if(r.status===401 || r.status===405){ready=true;break;}
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.ok(ready,'Disposable Worker did not become reachable');
  client=new Client({name:'isolated-child-acceptance',version:'0.1.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(url+'/mcp'),{
    requestInit:{headers:{authorization:'Bearer '+ownerToken}},
  }));
  const childDef={version:1,name:'isolated-child-'+suffix,
    steps:[{id:'emit',uses:'result.emit',with:{data:{receipt:'verified'}}}]};
  const draftChild=await tool('workflow_create',{definition:JSON.stringify(childDef)});
  assert.equal((await tool('workflow_validate',{
    workflow_id:draftChild.workflow_id,revision:1,
  })).valid,true);
  const publishedChild=await tool('workflow_publish',{
    workflow_id:draftChild.workflow_id,expected_revision:1,
  });
  const parentDef={version:1,name:'isolated-parent-'+suffix,inputs:{proof:'normal'},steps:[
    {id:'call',flow:'child',workflow_id:draftChild.workflow_id,
      version_id:publishedChild.published_version_id,inputs:{proof:{ref:'inputs.proof'}}},
    {id:'forward',uses:'result.emit',needs:['call'],with:{data:{ref:'steps.call.output'}}},
  ]};
  const draftParent=await tool('workflow_create',{definition:JSON.stringify(parentDef)});
  const validation=await tool('workflow_validate',{
    workflow_id:draftParent.workflow_id,revision:1,
  });
  assert.equal(validation.valid,true,JSON.stringify(validation.issues??[]));
  assert.equal(validation.required_children?.length,1,'Missing exact child Publish grant');
  const parentPublished=await tool('workflow_publish',{
    workflow_id:draftParent.workflow_id,expected_revision:1,
    approved_children:validation.required_children,
  });
  assert.ok(parentPublished.published_version_id);
  const opts={workflow_id:draftParent.workflow_id,inputs:{proof:'normal'},
    idempotency_key:'isolated-'+suffix};
  const started=await tool('workflow_run',opts);
  assert.equal((await tool('workflow_run',opts)).run_id,started.run_id);
  const result=await settle(started.run_id);
  assert.equal(result.status,'succeeded','Parent native result must succeed');
  assert.deepEqual(result.result,{receipt:'verified'});
  const childRows=(await query(
    'SELECT id,parent_run_id,parent_step_id,version_id,outcome FROM runs WHERE parent_run_id=?',
    [started.run_id])).results;
  assert.equal(childRows.length,1,'Child must have exactly one durable Run');
  assert.equal(childRows[0].parent_step_id,'call');
  assert.equal(childRows[0].version_id,publishedChild.published_version_id);
  assert.equal(childRows[0].outcome,'succeeded');
  assert.equal((await query(
    'SELECT COUNT(*) AS n FROM runs WHERE parent_run_id=?',[started.run_id])).results[0].n,1);
  console.log('CHILD_NATIVE_CLOUDFLARE_PARENT_RESULT_REPLAY_AND_LINEAGE_OK');
  const delayed=await tool('workflow_run',{
    workflow_id:draftParent.workflow_id,inputs:{proof:'cancel-test'},
    idempotency_key:'native-cancel-'+suffix,
  });
  let delayedChild=null;
  for(let i=0;i<100;i++){
    delayedChild=(await query('SELECT id,start_state,outcome FROM runs WHERE parent_run_id=?',[delayed.run_id])).results[0]??null;
    if(delayedChild?.start_state==='started'&&['queued','running'].includes(delayedChild.outcome))break;
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert.equal(delayedChild?.start_state,'started','Child did not reach native dispatch before cancellation');
  const cancelled=await tool('workflow_cancel',{run_id:delayed.run_id,step_id:'call'});
  assert.ok(['requested_unverified','terminal_confirmed'].includes(cancelled.cancellation),
    'Native child cancellation must be accepted');
  let stopped=false;
  for(let i=0;i<90;i++){
    const row=(await query('SELECT outcome FROM runs WHERE id=?',[delayedChild.id])).results[0];
    if(row?.outcome==='cancelled'){stopped=true;break;}
    await tool('workflow_cancel',{run_id:delayed.run_id,step_id:'call'});
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.ok(stopped,'Cloudflare native child termination was not confirmed');
  const claimed=(await query('SELECT termination_attempted_at FROM child_cancellations WHERE child_run_id=?',[delayedChild.id])).results;
  assert.ok(claimed[0]?.termination_attempted_at,'No one-shot termination fence was claimed');
  const repeated=await tool('workflow_cancel',{run_id:delayed.run_id,step_id:'call'});
  assert.equal(repeated.cancellation,'terminal_confirmed','Repeated cancellation must only observe');
  const parentCancelled=await settle(delayed.run_id);
  assert.notEqual(parentCancelled.status,'succeeded','Cancelled child must prevent parent success');
  console.log('CHILD_NATIVE_TERMINATION_ONE_SHOT_AND_PARENT_FENCE_OK');
  // Real Cloudflare scheduling + disposable D1 intent injection. The intent
  // models a native termination whose ACK is missing: no second native API
  // request is made, so the delayed child can prove the authorization fence.
  async function injectLostAckRace(proof,requiredChildOutcome,label){
    const launched=await tool('workflow_run',{
      workflow_id:draftParent.workflow_id,inputs:{proof},
      idempotency_key:proof+'-'+suffix,
    });
    let found;
    for(let i=0;i<100;i++){
      found=(await query(
        'SELECT id,outcome,start_state FROM runs WHERE parent_run_id=?',
        [launched.run_id])).results[0];
      if(found?.start_state==='started'&&found.outcome===
          (proof==='late-result'?'running':'queued'))break;
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.ok(found?.start_state==='started','Child not dispatched before injection');
    assert.equal(found.outcome,proof==='late-result'?'running':'queued',
      'Child did not reach expected native checkpoint');
    await new Promise(resolve=>setTimeout(resolve,400));
    await query(`INSERT OR IGNORE INTO child_cancellations
      (parent_run_id,parent_step_id,child_run_id,requested_at)
      VALUES (?,'call',?,?)`,[launched.run_id,found.id,Date.now()]);
    assert.equal((await query(
      'SELECT COUNT(*) AS n FROM child_cancellations WHERE child_run_id=?',
      [found.id])).results[0].n,1,'Lost-ACK cancellation intent missing');
    const outcome=await settle(launched.run_id);
    assert.equal(outcome.status,'failed','Cancelled child must never authorize parent');
    assert.equal(outcome.steps.find(s=>s.step_id==='forward')?.status,'skipped');
    const childFinal=(await query(
      'SELECT outcome,error_code FROM runs WHERE id=?',[found.id])).results[0];
    assert.equal(childFinal.outcome,requiredChildOutcome,label);
    if(proof==='cancel-entry'){
      assert.equal(childFinal.error_code,'child_cancel_requested');
      assert.equal((await query(
        'SELECT COUNT(*) AS n FROM run_steps WHERE run_id=?',[found.id])).results[0].n,0);
    }else{
      assert.equal((await query(
        'SELECT COUNT(*) AS n FROM run_steps WHERE run_id=? AND status=?',
        [found.id,'succeeded'])).results[0].n,1,
        'Child actually completed after cancellation, but parent must fail');
    }
    console.log(label);
  }
  await injectLostAckRace(
    'cancel-entry','failed','CHILD_NATIVE_CANCELLED_BEFORE_ENTRY_FENCE_OK');
  await injectLostAckRace(
    'late-result','succeeded','CHILD_NATIVE_LATE_SUCCESS_AFTER_CANCEL_FENCE_OK');
  await tool('workflow_pause',{workflow_id:draftChild.workflow_id});
  const denied=await tool('workflow_run',{
    workflow_id:draftParent.workflow_id,idempotency_key:'paused-'+suffix,
  });
  const deniedResult=await settle(denied.run_id);
  assert.notEqual(deniedResult.status,'succeeded','Paused child must fail closed');
  const rejectedChildren=(await query(
    'SELECT COUNT(*) AS n FROM runs WHERE parent_run_id=?',[denied.run_id])).results[0].n;
  assert.equal(rejectedChildren,0,'Paused child must not reserve/start an instance');
  console.log('CHILD_NATIVE_PAUSED_TARGET_NO_DISPATCH_OK');
  await tool('workflow_resume',{workflow_id:draftChild.workflow_id});
  const revisedChild={...childDef,steps:[
    {id:'emit',uses:'result.emit',with:{data:{receipt:'republished'}}},
  ]};
  const revised=await tool('workflow_update',{
    workflow_id:draftChild.workflow_id,expected_revision:1,
    definition:JSON.stringify(revisedChild),
  });
  assert.equal(revised.draft_revision,2);
  const nextChild=await tool('workflow_publish',{
    workflow_id:draftChild.workflow_id,expected_revision:2,
  });
  assert.notEqual(nextChild.published_version_id,publishedChild.published_version_id,
    'A republish must create a new immutable child version');
  const stale=await tool('workflow_run',{
    workflow_id:draftParent.workflow_id,inputs:{proof:'normal'},
    idempotency_key:'republished-'+suffix,
  });
  const staleResult=await settle(stale.run_id);
  assert.notEqual(staleResult.status,'succeeded',
    'Parent must not dispatch its no-longer-active pinned child version');
  assert.equal((await query(
    'SELECT COUNT(*) AS n FROM runs WHERE parent_run_id=?',[stale.run_id])).results[0].n,0,
    'Republished target must not reserve a stale child');
  console.log('CHILD_NATIVE_REPUBLISH_PINNED_VERSION_FAIL_CLOSED_OK');
}
async function cleanup(){
  if(client)try{await client.close();}catch{}
  if(workerCreated)try{
    await api('DELETE',root+'/workers/scripts/'+workerName);
    console.log('CHILD_ACCEPTANCE_WORKER_REMOVED');
  }catch(e){failed=true;errors.push('worker_cleanup:'+diagnostic(e));}
  if(workflowCreated)try{
    await api('DELETE',root+'/workflows/'+workflowName);
    console.log('CHILD_ACCEPTANCE_WORKFLOW_REMOVED');
  }catch(e){failed=true;errors.push('workflow_cleanup:'+diagnostic(e));}
  if(databaseId)try{
    await api('DELETE',root+'/d1/database/'+databaseId);
    console.log('CHILD_ACCEPTANCE_D1_REMOVED');
  }catch(e){failed=true;errors.push('d1_cleanup:'+diagnostic(e));}
  for(const f of [configPath,secretPath,wrapperPath])try{unlinkSync(f);}catch{}
}
try{await acceptance();}
catch(e){failed=true;errors.push('acceptance:'+diagnostic(e));}
finally{await cleanup();}
for(const e of errors)console.error('CHILD_CLOUD_ACCEPTANCE_FAILED',e);
if(!failed)console.log('CHILD_CLOUD_ACCEPTANCE_AND_CLEANUP_OK');
process.exit(failed?1:0);
