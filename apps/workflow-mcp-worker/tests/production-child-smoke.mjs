// Production-only, bounded awaited-child acceptance. Reuses existing MCP and D1.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

assert.equal(process.env.GITHUB_REPOSITORY,'lirtual/mcp-workers');
assert.equal(process.env.GITHUB_REF,'refs/heads/main');
assert.equal(process.env.WORKFLOW_CHILD_SMOKE,'true');
const token=process.env.MCP_ACCESS_TOKEN;
const cloudToken=process.env.CLOUDFLARE_API_TOKEN;
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
assert.ok(token&&cloudToken&&/^[a-f0-9]{32}$/i.test(account||''),'Acceptance credentials missing');
const database='a4a477cd-6339-478c-ab7c-f7d87bb0d772';
const root='https://api.cloudflare.com/client/v4/accounts/'+account+'/d1/database/'+database+'/query';
const label=randomUUID();
const names='production-child-acceptance-'+label;
const ids=[];
const client=new Client({name:'workflow-child-production-acceptance',version:'1.0.0'});
const transport=new StreamableHTTPClientTransport(new URL('https://workflow.lirtual.dpdns.org/mcp'),{
  requestInit:{headers:{authorization:'Bearer '+token}},
});
let failure;
const terminal=new Set(['succeeded','failed','cancelled']);

function safeError(error){
  return String(error?.message||error||'unknown').replaceAll(token,'[redacted]')
    .replaceAll(cloudToken,'[redacted]').slice(0,320);
}
async function databaseQuery(sql,params=[]){
  const response=await fetch(root,{method:'POST',headers:{
    authorization:'Bearer '+cloudToken,'content-type':'application/json',
  },body:JSON.stringify({sql,params}),signal:AbortSignal.timeout(25000)});
  const value=await response.json();
  assert.ok(response.ok&&value?.success===true&&value.result?.[0]?.success===true,
    'Cloudflare D1 query was rejected');
  return value.result[0].results||[];
}
async function databaseBatch(batch){
  const response=await fetch(root,{method:'POST',headers:{
    authorization:'Bearer '+cloudToken,'content-type':'application/json',
  },body:JSON.stringify({batch}),signal:AbortSignal.timeout(35000)});
  const value=await response.json();
  assert.ok(response.ok&&value?.success===true&&value.result?.every(r=>r.success===true),
    'Cloudflare D1 cleanup batch was rejected');
}
async function tool(name,args){
  const response=await client.callTool({name,arguments:args});
  const content=response.content?.find(x=>x.type==='text')?.text;
  assert.ok(content,'MCP response is missing JSON text for '+name);
  const value=JSON.parse(content);
  assert.notEqual(response.isError,true,'MCP '+name+' rejected');
  return value;
}
async function settle(runId){
  for(let i=0;i<90;i++){
    const value=await tool('workflow_result',{run_id:runId});
    if(terminal.has(value.status))return value;
    await new Promise(resolve=>setTimeout(resolve,800));
  }
  throw Error('Native parent Workflow did not settle within acceptance bound');
}
async function accept(){
  // Native result-only parent/child acceptance has no external effects.
  // Preserve historical indeterminate receipts while refusing concurrent
  // queued/running Runs and every live or uncertain physical Session.
  const preflight=(await databaseQuery("SELECT (SELECT COUNT(*) FROM runs WHERE outcome IN ('queued','running')) AS active,(SELECT COUNT(*) FROM session_executions WHERE state IS NULL OR state!='terminated') AS sessions"))[0];
  assert.equal(preflight?.active,0,'Active production Run blocks acceptance');
  assert.equal(preflight?.sessions,0,'Nonterminal production Session blocks acceptance');
  await client.connect(transport);
  const advertised=await client.listTools();
  for(const name of ['workflow_create','workflow_validate','workflow_publish','workflow_run','workflow_result','workflow_pause']){
    assert.ok(advertised.tools.some(t=>t.name===name),'Missing live MCP tool '+name);
  }
  const publisher=advertised.tools.find(t=>t.name==='workflow_publish');
  assert.ok(publisher.inputSchema?.properties?.approved_children,
    'Live MCP publish schema must declare approved_children');

  const receipt={receipt:'verified',acceptance:label};
  const childDefinition={version:1,name:names+'-child',steps:[
    {id:'emit',uses:'result.emit',with:{data:receipt}},
  ]};
  const child=await tool('workflow_create',{definition:JSON.stringify(childDefinition)});
  ids.push(child.workflow_id);
  assert.match(child.workflow_id,/^[0-9a-f-]{36}$/i);
  assert.equal((await tool('workflow_validate',{workflow_id:child.workflow_id,revision:1})).valid,true);
  const childPublished=await tool('workflow_publish',{
    workflow_id:child.workflow_id,expected_revision:1,
  });
  assert.ok(childPublished.published_version_id);

  const parentDefinition={version:1,name:names+'-parent',steps:[
    {id:'call',flow:'child',workflow_id:child.workflow_id,
      version_id:childPublished.published_version_id,inputs:{proof:'production'}},
    {id:'forward',uses:'result.emit',needs:['call'],
      with:{data:{ref:'steps.call.output'}}},
  ]};
  const parent=await tool('workflow_create',{definition:JSON.stringify(parentDefinition)});
  ids.push(parent.workflow_id);
  const validated=await tool('workflow_validate',{
    workflow_id:parent.workflow_id,revision:1,
  });
  assert.equal(validated.valid,true);
  assert.equal(validated.required_children?.length,1);
  const exact=validated.required_children[0];
  assert.equal(exact.workflow_id,child.workflow_id);
  assert.equal(exact.version_id,childPublished.published_version_id);
  assert.match(exact.digest,/^[0-9a-f]{64}$/);

  // Authorization must fail closed when exact child approval is omitted.
  const unapproved=await client.callTool({name:'workflow_publish',
    arguments:{workflow_id:parent.workflow_id,expected_revision:1}});
  assert.equal(unapproved.isError,true,'Unapproved child publish must fail');
  const parentPublished=await tool('workflow_publish',{
    workflow_id:parent.workflow_id,expected_revision:1,
    approved_children:validated.required_children,
  });
  assert.ok(parentPublished.published_version_id);
  console.log('CHILD_PRODUCTION_GRANT_ENFORCEMENT_OK');

  const key='awaited-child-'+label;
  const start=await tool('workflow_run',{workflow_id:parent.workflow_id,idempotency_key:key});
  const repeat=await tool('workflow_run',{workflow_id:parent.workflow_id,idempotency_key:key});
  assert.equal(repeat.run_id,start.run_id,'Idempotency changed parent identity');
  const result=await settle(start.run_id);
  assert.equal(result.status,'succeeded','Native parent did not succeed');
  assert.deepEqual(result.result,receipt,'Parent must forward the real child result');
  const childRows=await databaseQuery(
    'SELECT id,version_id,parent_run_id,parent_step_id,outcome FROM runs WHERE parent_run_id=?',
    [start.run_id]);
  assert.equal(childRows.length,1,'Expected exactly one native child Run');
  assert.equal(childRows[0].version_id,childPublished.published_version_id);
  assert.equal(childRows[0].parent_step_id,'call');
  assert.equal(childRows[0].outcome,'succeeded');
  console.log('CHILD_PRODUCTION_NATIVE_RESULT_REPLAY_LINEAGE_OK');

  await tool('workflow_pause',{workflow_id:child.workflow_id});
  const denied=await tool('workflow_run',{
    workflow_id:parent.workflow_id,idempotency_key:'paused-child-'+label,
  });
  const deniedResult=await settle(denied.run_id);
  assert.notEqual(deniedResult.status,'succeeded',
    'Paused child must not authorize parent success');
  const admitted=await databaseQuery(
    'SELECT COUNT(*) AS n FROM runs WHERE parent_run_id=?',[denied.run_id]);
  assert.equal(admitted[0]?.n,0,'Paused child must not reserve a Run');
  console.log('CHILD_PRODUCTION_PAUSED_TARGET_DENIED_OK');
}
async function cleanup(){
  if(ids.length===0)return;
  const marks=ids.map(()=>'?').join(',');
  // Fail closed rather than hide an unconfirmed physical/ledger terminal state.
  const rows=await databaseQuery(
    'SELECT id,workflow_id,outcome FROM runs WHERE workflow_id IN ('+marks+')',ids);
  if(rows.some(r=>!terminal.has(r.outcome)))throw Error(
    'Refusing cleanup while a temporary Run is nonterminal: '+ids.join(','));
  const owned=await databaseQuery(
    'SELECT id,name FROM workflows WHERE id IN ('+marks+')',ids);
  if(owned.length!==ids.length||owned.some(w=>!w.name.startsWith(names)))
    throw Error('Refusing cleanup of non-owned Workflow');
  const statements=[
    {sql:'DELETE FROM child_cancellations WHERE parent_run_id IN (SELECT id FROM runs WHERE workflow_id IN ('+marks+')) OR child_run_id IN (SELECT id FROM runs WHERE workflow_id IN ('+marks+'))',params:[...ids,...ids]},
    {sql:'DELETE FROM run_steps WHERE run_id IN (SELECT id FROM runs WHERE workflow_id IN ('+marks+'))',params:ids},
    {sql:'DELETE FROM runs WHERE parent_run_id IS NOT NULL AND workflow_id IN ('+marks+')',params:ids},
    {sql:'DELETE FROM runs WHERE workflow_id IN ('+marks+')',params:ids},
    {sql:'DELETE FROM workflow_versions WHERE workflow_id IN ('+marks+')',params:ids},
    {sql:'DELETE FROM workflows WHERE id IN ('+marks+')',params:ids},
  ];
  await databaseBatch(statements);
  const after=(await databaseQuery(
    'SELECT (SELECT COUNT(*) FROM workflows WHERE id IN ('+marks+')) AS workflows,(SELECT COUNT(*) FROM workflow_versions WHERE workflow_id IN ('+marks+')) AS versions,(SELECT COUNT(*) FROM runs WHERE workflow_id IN ('+marks+')) AS runs,(SELECT COUNT(*) FROM pragma_foreign_key_check) AS foreign_key_errors',
    [...ids,...ids,...ids]))[0];
  assert.deepEqual(after,{workflows:0,versions:0,runs:0,foreign_key_errors:0});
  console.log('CHILD_PRODUCTION_CLEANUP_OK');
}
try{await accept();}
catch(e){failure=e;console.error('CHILD_PRODUCTION_ACCEPTANCE_FAILED:',safeError(e));}
finally{
  try{await client.close();}catch{}
  try{await cleanup();}catch(e){
    failure ||=e;
    console.error('CHILD_PRODUCTION_CLEANUP_FAILED:',safeError(e));
    if(ids.length)console.error('Temporary Workflow IDs for guarded recovery:',ids.join(','));
  }
}
if(failure)process.exitCode=1;
