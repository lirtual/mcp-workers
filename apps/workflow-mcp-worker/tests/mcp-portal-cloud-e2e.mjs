// Disposable Cloudflare Workflow E2E: MCP -> test Portal/IMA or real platform Cron.
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {writeFileSync,unlinkSync} from 'node:fs';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {PORTAL_ENDPOINT,scopedPublicMcpFetch} from '../src/mcp-public-fetch.ts';
import {toolSchemaDigest} from '../src/plan.ts';
const need=k=>{assert.ok(process.env[k],'Missing '+k);return process.env[k]};
const cf=need('CLOUDFLARE_API_TOKEN'),account=need('CLOUDFLARE_ACCOUNT_ID');
const cronMode=process.env.MCP_CRON_E2E==='true';
const pair=cronMode?null:{clientId:need('MCP_PORTAL_CLIENT_ID'),clientSecret:need('MCP_PORTAL_CLIENT_SECRET')};
const suffix=randomBytes(5).toString('hex'),name='workflow-mcp-'+(cronMode?'cron':'ima')+'-'+suffix;
const file='wrangler.mcp-isolated-'+suffix+'.json',cwd=new URL('..',import.meta.url).pathname;
const endpoint='https://'+name+'.aiyaya.workers.dev/mcp',ownerToken=randomUUID()+randomUUID();
let dbId,attempted=false,owner,portal;const pause=ms=>new Promise(r=>setTimeout(r,ms));
assert.match(name,cronMode?/^workflow-mcp-cron-[a-f0-9]{10}$/:/^workflow-mcp-ima-[a-f0-9]{10}$/);
async function api(method,path,body,timeout=25000){
  const r=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{authorization:'Bearer '+cf,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(timeout)});
  const v=await r.json().catch(()=>null);if(!r.ok||!v?.success)throw Error('Cloudflare '+method+' HTTP '+r.status);return v.result;
}
function wr(args,input){
  const r=spawnSync('pnpm',['exec','wrangler',...args],{cwd,encoding:'utf8',input,timeout:120000,maxBuffer:2097152,env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'}});
  if(r.status!==0)throw Error('wrangler '+args[0]+' '+(args[1]||'')+' failed '+r.status+' (details suppressed)');return r.stdout;
}
function mcp(url,options){const client=new Client({name:'isolated-s2',version:'1'});return {client,transport:new StreamableHTTPClientTransport(new URL(url),options)};}
async function tool(name,args,expect){const r=await owner.callTool({name,arguments:args},{timeout:20000});assert.equal(r.content?.[0]?.type,'text');const v=JSON.parse(r.content[0].text);if(expect){assert.equal(r.isError,true);assert.equal(v.error,expect);}else assert.notEqual(r.isError,true,name+' returned error');return v;}
async function d1Select(sql,params=[]){
  assert.match(sql,/^\s*SELECT\b/i,'Cron D1 readback must remain read-only');
  const result=await api('POST','/accounts/'+account+'/d1/database/'+dbId+'/query',{sql,params},12000);
  assert.ok(Array.isArray(result)&&Array.isArray(result[0]?.results),'Unexpected D1 query response');
  return result[0].results;
}
async function run(){
  let cand;
  if(!cronMode){
    portal=mcp(PORTAL_ENDPOINT,{fetch:scopedPublicMcpFetch(PORTAL_ENDPOINT,fetch,pair)});
    await portal.client.connect(portal.transport);
    cand=(await portal.client.listTools()).tools.find(t=>t.name==='ima_list_notebooks');
    assert.ok(cand&&cand.annotations?.readOnlyHint===true&&cand.annotations?.destructiveHint!==true,'IMA read-only contract missing');
  }
  const created=await api('POST','/accounts/'+account+'/d1/database',{name});dbId=created.uuid;
  assert.match(dbId,/^[a-f0-9-]{36}$/i);console.log('DISPOSABLE_DB_CREATED',name);
  const config={name,main:'src/index.ts',compatibility_date:'2026-09-10',workers_dev:true,preview_urls:false,keep_vars:false,
    ...(cronMode?{triggers:{crons:['* * * * *']}}:{vars:{MCP_PORTAL_ENDPOINT:PORTAL_ENDPOINT}}),
    d1_databases:[{binding:'DB',database_name:name,database_id:dbId,migrations_dir:'migrations'}],workflows:[{name,binding:'WORKFLOW',class_name:'WorkflowRunner'}]};
  writeFileSync(new URL('../'+file,import.meta.url),JSON.stringify(config));
  wr(['d1','migrations','apply',name,'--remote','--config',file]);
  attempted=true;wr(['deploy','--config',file]);
  const secrets={MCP_ACCESS_TOKEN:ownerToken,...(cronMode?{}:{MCP_PORTAL_CLIENT_ID:pair.clientId,MCP_PORTAL_CLIENT_SECRET:pair.clientSecret})};
  for(const [key,val] of Object.entries(secrets))wr(['secret','put',key,'--config',file],val);
  console.log('DISPOSABLE_WORKER_READY',name);
  // Each secret update can roll out a new Worker version. Do not begin
  // state-changing MCP requests until the disposable route is stable.
  let stable=0;
  for(let i=0;i<25&&stable<3;i++){
    try{
      const response=await fetch('https://'+name+'.aiyaya.workers.dev/health',{
        method:'GET',signal:AbortSignal.timeout(5500),
      });
      if(response.status===200&&((await response.json())?.ok===true))stable++;
      else stable=0;
    }catch{stable=0;}
    if(stable<3)await pause(2200);
  }
  assert.equal(stable,3,'disposable_worker_route_unstable_after_secrets');
  console.log('MCP_ISOLATED_STABLE_WORKER_HEALTH_OK',name);
  let connected=false;for(let i=0;i<15;i++){
    const instance=mcp(endpoint,{requestInit:{headers:{authorization:'Bearer '+ownerToken}}});
    try{await instance.client.connect(instance.transport);owner=instance.client;connected=true;break;}catch{await instance.client.close().catch(()=>{});await pause(2000);}
  }assert.ok(connected,'Isolated Worker unavailable');
  // A healthy GET /health does not guarantee the workers.dev MCP POST route
  // is stable across edge locations. Force actual network reads, each limited
  // to 3.5s; 12 attempts plus waits stay below the bounded Cron job timeout.
  let stableMcpReads=0;
  for(let i=0;i<12&&stableMcpReads<3;i++){
    try{
      const listing=await owner.listTools({}, {timeout:3500,cacheMode:'bypass'});
      if(listing.tools.some(t=>t.name==='workflow_create'))stableMcpReads++;
      else stableMcpReads=0;
    }catch{stableMcpReads=0;}
    if(stableMcpReads<3)await pause(2000);
  }
  assert.equal(stableMcpReads,3,'disposable_worker_mcp_route_unstable');
  console.log('MCP_ISOLATED_STABLE_MCP_READS_OK',name);
  if(cronMode){
    const definition={version:1,name:'isolated-cron-'+suffix,triggers:[{id:'schedule',type:'cron',expression:'* * * * *'}],
      steps:[{id:'emit',uses:'result.emit',with:{data:{scheduled_time:{ref:'inputs.payload.scheduled_time'}}}}]};
    const draft=await tool('workflow_create',{definition:JSON.stringify(definition)});
    const validation=await tool('workflow_validate',{workflow_id:draft.workflow_id,revision:1});
    assert.equal(validation.valid,true,JSON.stringify(validation.issues));
    const published=await tool('workflow_publish',{workflow_id:draft.workflow_id,expected_revision:1});
    assert.ok(published.published_version_id);
    console.log('DISPOSABLE_CRON_PUBLISHED',JSON.stringify({worker:name,workflow_id:draft.workflow_id}));
    // Allow Cloudflare's documented propagation window plus two actual ticks
    // and async completion, but stop after 18 minutes so cleanup remains bounded.
    // No scheduled handler is invoked: only the deployed Cron can admit Runs.
    const deadline=Date.now()+18*60_000,events=new Map();
    const readEvents=async()=>{
      const rows=await d1Select(`SELECT id,admission_key,inputs,created_at,outcome FROM runs
        WHERE workflow_id=? AND json_extract(inputs,'$.event')='cron'
        ORDER BY created_at ASC`,[draft.workflow_id]);
      for(const row of rows){
        const inputs=JSON.parse(row.inputs);
        assert.match(inputs.event_id,/^cron-\d{8}T\d{4}$/,'Cron event id must encode the admitted UTC minute');
        const encoded=new Date(Date.UTC(Number(inputs.event_id.slice(5,9)),Number(inputs.event_id.slice(9,11))-1,
          Number(inputs.event_id.slice(11,13)),Number(inputs.event_id.slice(14,16)),Number(inputs.event_id.slice(16,18)))).toISOString();
        assert.equal(inputs.payload?.scheduled_time,encoded);
        const stableKey='evt_'+createHash('sha256').update('cron\0'+inputs.event_id).digest('hex');
        assert.equal(row.admission_key,stableKey,'Cron minute must use its stable event admission key');
        const prior=events.get(inputs.event_id);
        if(prior)assert.equal(prior.run_id,row.id,'Same UTC minute must resolve to the same Run');
        events.set(inputs.event_id,{run_id:row.id,scheduled_time:inputs.payload.scheduled_time});
      }
      const duplicates=await d1Select(`SELECT json_extract(inputs,'$.event_id') AS event_id,COUNT(*) AS copies FROM runs
        WHERE workflow_id=? AND json_extract(inputs,'$.event')='cron'
        GROUP BY json_extract(inputs,'$.event_id') HAVING COUNT(*)>1`,[draft.workflow_id]);
      assert.deepEqual(duplicates,[],'A UTC scheduled minute must not create duplicate Runs');
    };
    const completed=new Set();
    while(Date.now()<deadline&&(events.size<2||completed.size<2)){
      await readEvents();
      for(const [eventId,event] of [...events.entries()].slice(0,2)){
        if(completed.has(eventId))continue;
        const result=await tool('workflow_result',{run_id:event.run_id});
        if(['failed','cancelled','indeterminate'].includes(result.status))
          assert.fail('Cron Run terminal status: '+result.status+' '+result.error_code);
        if(result.status==='succeeded'){
          assert.equal(result.result?.scheduled_time,event.scheduled_time);
          completed.add(eventId);
        }
      }
      if(events.size<2||completed.size<2)await pause(10_000);
    }
    assert.ok(events.size>=2,'Fewer than two real Cloudflare Cron minutes arrived before the bounded deadline');
    assert.equal(completed.size,2,'Cron Runs did not succeed with their scheduled_time results');
    const finalRows=await d1Select(`SELECT id,admission_key,inputs FROM runs WHERE workflow_id=? AND json_extract(inputs,'$.event')='cron'`,[draft.workflow_id]);
    const finalByEvent=new Map();
    for(const row of finalRows){
      const inputs=JSON.parse(row.inputs);
      assert.match(inputs.event_id,/^cron-\d{8}T\d{4}$/,'Unexpected Cron event id in final D1 readback');
      const scheduled=new Date(Date.UTC(Number(inputs.event_id.slice(5,9)),Number(inputs.event_id.slice(9,11))-1,
        Number(inputs.event_id.slice(11,13)),Number(inputs.event_id.slice(14,16)),Number(inputs.event_id.slice(16,18)))).toISOString();
      assert.equal(inputs.payload?.scheduled_time,scheduled);
      assert.equal(row.admission_key,'evt_'+createHash('sha256').update('cron\0'+inputs.event_id).digest('hex'));
      assert.equal(finalByEvent.has(inputs.event_id),false,'One UTC minute must map to one Run');
      finalByEvent.set(inputs.event_id,row.id);
    }
    for(const [eventId,event] of events)
      assert.equal(finalByEvent.get(eventId),event.run_id,'Every observed Run must remain present under its original id');
    assert.equal(new Set(finalRows.map(row=>row.id)).size,finalRows.length);
    const finalDuplicates=await d1Select(`SELECT json_extract(inputs,'$.event_id') AS event_id,COUNT(*) AS copies FROM runs
      WHERE workflow_id=? AND json_extract(inputs,'$.event')='cron'
      GROUP BY json_extract(inputs,'$.event_id') HAVING COUNT(*)>1`,[draft.workflow_id]);
    assert.deepEqual(finalDuplicates,[],'Final D1 readback found duplicate Runs for a UTC minute');
    console.log('MCP_ISOLATED_REAL_CRON_E2E_OK',JSON.stringify({worker:name,workflow_id:draft.workflow_id,
      minutes:[...events.keys()],runs:[...events.values()].map(value=>value.run_id)}));
    return;
  }
  const definition={version:1,name:'isolated-ima-'+suffix,steps:[{id:'read',uses:'mcp.call',with:{endpoint:PORTAL_ENDPOINT,tool:'ima_list_notebooks',scope:'read',input_schema:cand.inputSchema,...(cand.outputSchema?{output_schema:cand.outputSchema}:{}),arguments:{limit:1}}},{id:'emit',uses:'result.emit',needs:['read'],with:{data:{ref:'steps.read.output'}}}]};
  const draft=await tool('workflow_create',{definition:JSON.stringify(definition)});
  const validation=await tool('workflow_validate',{workflow_id:draft.workflow_id,revision:1});
  assert.equal(validation.valid,true);assert.equal(validation.required_approvals?.length,1);
  assert.deepEqual(validation.required_approvals[0],{endpoint:PORTAL_ENDPOINT,tool:'ima_list_notebooks',scope:'read',schema_digest:await toolSchemaDigest(cand.inputSchema,cand.outputSchema)});
  const base={workflow_id:draft.workflow_id,expected_revision:1};
  await tool('workflow_publish',{...base,approved_operations:validation.required_approvals},'target_risk_acknowledgment_required');
  await tool('workflow_publish',{...base,approved_operations:[],accept_target_risks:true},'external_approval_required');
  const published=await tool('workflow_publish',{...base,approved_operations:validation.required_approvals,accept_target_risks:true});assert.ok(published.published_version_id);
  const params={workflow_id:draft.workflow_id,inputs:{},idempotency_key:'mcp-ima-'+suffix};
  const started=await tool('workflow_run',params);const runId=started.run_id;let outcome;
  for(let i=0;i<60;i++){outcome=await tool('workflow_result',{run_id:runId});if(['succeeded','failed','indeterminate','cancelled'].includes(outcome.status))break;await pause(1000);}
  assert.equal(outcome.status,'succeeded','Actual Cloudflare Workflow failed');
  assert.equal(outcome.steps.length,2);assert.ok(outcome.steps.every(s=>s.status==='succeeded'));
  assert.ok(Array.isArray(outcome.result?.content),'IMA tool data missing');
  assert.equal((await tool('workflow_run',params)).run_id,runId);
  console.log('MCP_ISOLATED_CLOUD_E2E_OK',JSON.stringify({worker:name,runId,steps:outcome.steps.map(s=>s.status),tool:'ima_list_notebooks'}));
}
async function resourcePresent(path){
  const response=await fetch('https://api.cloudflare.com/client/v4'+path,{
    headers:{authorization:'Bearer '+cf},signal:AbortSignal.timeout(15000),
  });
  const doc=await response.json().catch(()=>null);
  if(response.status===404||doc?.errors?.some(e=>e.code===10007))return false;
  if(!response.ok||doc?.success!==true)throw Error('Cleanup verification failed: HTTP '+response.status);
  return true;
}
async function removeExact(path){
  if(await resourcePresent(path))await api('DELETE',path);
  if(await resourcePresent(path))throw Error('Disposable resource still present');
}
async function cleanup(){
  // A stalled SDK stream must never block exact-name cleanup of disposable
  // Worker / Workflow / D1 resources.
  await Promise.race([
    Promise.allSettled([
      Promise.resolve().then(()=>owner?.close()),
      Promise.resolve().then(()=>portal?.client?.close()),
    ]),
    new Promise(resolve=>setTimeout(resolve,1500)),
  ]);
  if(!new RegExp('^workflow-mcp-'+(cronMode?'cron':'ima')+'-[a-f0-9]{10}$').test(name))throw Error('Unsafe cleanup identity');
  const failed=[];
  const worker='/accounts/'+account+'/workers/scripts/'+name;
  const workflow='/accounts/'+account+'/workflows/'+name;
  if(attempted){
    try{
      if(await resourcePresent(worker+'/script-settings'))
        await api('DELETE',worker+'?force=true');
      if(await resourcePresent(worker+'/script-settings'))throw Error('worker remains');
    }catch{failed.push('worker');}
    try{await removeExact(workflow);}catch{failed.push('workflow');}
  }
  if(dbId){
    try{await removeExact('/accounts/'+account+'/d1/database/'+dbId);}
    catch{failed.push('d1');}
  }
  try{unlinkSync(new URL('../'+file,import.meta.url));}catch{}
  if(failed.length)throw Error('DISPOSABLE_CLEANUP_FAILED: '+failed.join(',')+' name='+name);
  console.log('DISPOSABLE_CLEANUP_OK',name);
}
let failure;
try{await run()}catch(e){failure=e;console.error('MCP_CLOUD_E2E_FAILED',String(e.message).replaceAll(cf,'[redacted]').replaceAll(pair?.clientSecret??'\0','[redacted]'),'name='+name);}
finally{try{await cleanup();}catch(e){failure??=e;console.error(String(e.message));}}
// CLI has completed all awaited cleanup. Close lingering SDK/HTTP handles rather
// than letting a successful test hang until GitHub cancels the entire job.
process.exit(failure?1:0);
