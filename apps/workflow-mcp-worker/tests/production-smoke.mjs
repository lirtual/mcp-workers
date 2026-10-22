// Deliberately narrow production acceptance: one temporary Workflow echo workflow, no deployment.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { scopedPublicMcpFetch, PRODUCTION_PORTAL_ENDPOINT } from '../src/mcp-public-fetch.ts';
import { toolSchemaDigest } from '../src/plan.ts';

const token = process.env.MCP_ACCESS_TOKEN;
assert.ok(token, 'MCP_ACCESS_TOKEN must be present in GitHub Environment');
assert.ok(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID,
  'Cloudflare read/cleanup credentials must be present in GitHub Environment');

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = 'https://workflow.lirtual.dpdns.org';
const client = new Client({ name: 'workflow-production-smoke', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
  requestInit: { headers: { authorization: 'Bearer ' + token } },
});
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const label = randomUUID();
const echo = 'workflow-production-smoke-' + label;
let workflowId;
let runId;
let failure;
let s3PhysicalCompleted = false;

function sql(statement) {
  // stdout contains JSON only; do not log credentials, SQL args or Wrangler internals.
  const output = execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute',
    'workflow-mcp-worker', '--remote', '--json', '--command', statement], {
    cwd, encoding: 'utf8', timeout: 45_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(output);
  assert.ok(Array.isArray(parsed) && parsed[0]?.success, 'Remote D1 statement failed');
  return parsed[0].results ?? [];
}
function quotedId(id) {
  assert.match(id, uuid, 'invalid generated Workflow ID');
  return "'" + id + "'";
}
function workflowRows() {
  const id = quotedId(workflowId);
  return sql(`SELECT outcome FROM runs WHERE workflow_id = ${id}`);
}
function cleanup() {
  if (!workflowId) return;
  const id = quotedId(workflowId);
  const runs = workflowRows();
  if (runs.some(r => !terminal.has(r.outcome))) {
    throw Error('Refusing to delete temporary records: nonterminal Run still exists');
  }
  if(process.env.WORKFLOW_GITHUB_SMOKE==='true' && runId && !s3PhysicalCompleted)
    throw Error('Refusing GitHub cleanup until physical GitHub Job is completed');
  if(process.env.WORKFLOW_GITHUB_SMOKE==='true'){
    sql('DELETE FROM callback_receipts WHERE attempt_id IN (SELECT attempt_id FROM step_attempts WHERE run_id IN (SELECT id FROM runs WHERE workflow_id = ' + id + '))');
    sql('DELETE FROM step_attempts WHERE run_id IN (SELECT id FROM runs WHERE workflow_id = ' + id + ')');
  }
  // Foreign-key order; scoped by the server-returned random Workflow UUID.
  sql(`DELETE FROM run_steps WHERE run_id IN (SELECT id FROM runs WHERE workflow_id = ${id})`);
  sql(`DELETE FROM runs WHERE workflow_id = ${id}`);
  sql(`DELETE FROM workflow_versions WHERE workflow_id = ${id}`);
  sql(`DELETE FROM workflows WHERE id = ${id}`);
  const rows = sql(`SELECT
    (SELECT count(*) FROM workflows WHERE id = ${id}) AS workflows,
    (SELECT count(*) FROM workflow_versions WHERE workflow_id = ${id}) AS versions,
    (SELECT count(*) FROM runs WHERE workflow_id = ${id}) AS runs,
    (SELECT count(*) FROM run_steps WHERE run_id IN (SELECT id FROM runs WHERE workflow_id = ${id})) AS steps`);
  assert.ok(rows.length === 1 && Object.values(rows[0]).every(n => n === 0),
    'Temporary D1 rows were not fully removed');
  console.log('CLEANUP_OK: temporary Workflow, versions, Runs and Steps are absent from D1');
}
async function tool(name, args) {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(response.content?.[0]?.text, name + ' returned no text');
  const value = JSON.parse(response.content[0].text);
  assert.notEqual(response.isError, true, name + ' returned MCP error: ' + JSON.stringify(value));
  return value;
}
async function runSmoke() {
  // Fail closed if another production Run is unfinished or ambiguous.
  const outstanding = sql(`SELECT count(*) AS n FROM runs
    WHERE outcome NOT IN ('succeeded','failed','cancelled')`);
  assert.equal(outstanding[0]?.n, 0, 'Production has nonterminal Runs: smoke aborted before writes');

  await client.connect(transport);
  const listed = await client.listTools();
  for (const name of ['workflow_create', 'workflow_validate', 'workflow_publish',
    'workflow_run', 'workflow_status', 'workflow_result']) {
    assert.ok(listed.tools.some(t => t.name === name), 'Missing Workflow tool ' + name);
  }
  assert.ok(!listed.tools.some(t => /s2|webhook|github/i.test(t.name)),
    'Unexpected MCP/GitHub tool exposed');

  const definition = {
    version: 1, name: echo,
    steps: [
      { id: 'read', uses: 'fixture.echo',
        with: { tool: 'echo', arguments: { value: { ref: 'inputs.subject' } } } },
      { id: 'report', uses: 'result.emit',
        needs: ['read'], with: { data: { ref: 'steps.read.output' } } },
    ],
  };
  const draft = await tool('workflow_create', { definition: JSON.stringify(definition) });
  workflowId = draft.workflow_id;
  assert.match(workflowId, uuid);
  assert.equal(draft.state, 'draft');
  assert.equal(draft.draft_revision, 1);
  assert.equal((await tool('workflow_validate', { workflow_id: workflowId, revision: 1 })).valid, true);
  const published = await tool('workflow_publish', { workflow_id: workflowId, expected_revision: 1 });
  assert.ok(published.published_version_id);
  const inputs = { subject: echo };
  const key = 'prod-smoke-' + label;
  const started = await tool('workflow_run', {
    workflow_id: workflowId, inputs, idempotency_key: key,
  });
  runId = started.run_id;
  assert.match(runId, uuid);
  assert.equal(started.published_version_id, published.published_version_id);
  const replay = await tool('workflow_run', {
    workflow_id: workflowId, inputs, idempotency_key: key,
  });
  assert.equal(replay.run_id, runId, 'Idempotency must reuse the Run');

  let status;
  for (let attempt = 0; attempt < 60; attempt++) {
    status = await tool('workflow_status', { run_id: runId });
    if (terminal.has(status.status) || status.status === 'indeterminate') break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(status?.status, 'succeeded', 'Native Workflow did not successfully finish');
  assert.equal(status.steps.length, 2);
  assert.ok(status.steps.every(s => s.status === 'succeeded'));
  const result = await tool('workflow_result', { run_id: runId });
  assert.equal(result.result?.content?.[0]?.text, echo);
  console.log('SMOKE_OK: authenticated Draft → Validate → Publish → Run → Result; idempotency and echo verified');
  console.log('Verified Workflow ID:', workflowId);
  console.log('Verified Run ID:', runId);
}
async function runS2Smoke() {
  // The exact production Portal and tool/schema must be explicitly approved.
  const pair = { clientId:process.env.MCP_PORTAL_CLIENT_ID,
    clientSecret:process.env.MCP_PORTAL_CLIENT_SECRET };
  assert.ok(pair.clientId && pair.clientSecret, 'Production Portal secrets missing');
  const outstanding = sql("SELECT count(*) AS n FROM runs WHERE outcome NOT IN ('succeeded','failed','cancelled')");
  assert.equal(outstanding[0]?.n,0,'Production has nonterminal Runs: smoke aborted before writes');
  const portal = new Client({name:'workflow-mcp-production-contract',version:'0.1.0'});
  const portalTransport = new StreamableHTTPClientTransport(new URL(PRODUCTION_PORTAL_ENDPOINT),{
    fetch:scopedPublicMcpFetch(PRODUCTION_PORTAL_ENDPOINT,fetch,pair,PRODUCTION_PORTAL_ENDPOINT),
  });
  let candidate;
  try{
    await portal.connect(portalTransport);
    candidate=(await portal.listTools()).tools.find(t=>t.name==='ima_list_notebooks');
    assert.ok(candidate?.annotations?.readOnlyHint===true &&
      candidate.annotations?.destructiveHint!==true,'IMA read-only tool unavailable');
  }finally{await portal.close().catch(()=>{});}
  await client.connect(transport);
  const definition={version:1,name:'workflow-mcp-production-smoke-'+label,
    steps:[
      {id:'read',uses:'mcp.call',with:{
        endpoint:PRODUCTION_PORTAL_ENDPOINT,tool:'ima_list_notebooks',
        scope:'read',arguments:{limit:1},input_schema:candidate.inputSchema,
        ...(candidate.outputSchema?{output_schema:candidate.outputSchema}:{})
      }},
      {id:'emit',needs:['read'],uses:'result.emit',
        with:{data:{ref:'steps.read.output'}}},
    ]};
  const draft=await tool('workflow_create',{definition:JSON.stringify(definition)});
  workflowId=draft.workflow_id;
  assert.match(workflowId,uuid);
  const checked=await tool('workflow_validate',{workflow_id:workflowId,revision:1});
  assert.equal(checked.valid,true);
  assert.deepEqual(checked.required_approvals,[{
    endpoint:PRODUCTION_PORTAL_ENDPOINT,tool:'ima_list_notebooks',scope:'read',
    schema_digest:await toolSchemaDigest(candidate.inputSchema,candidate.outputSchema),
  }]);
  const publish=await tool('workflow_publish',{workflow_id:workflowId,expected_revision:1,
    approved_operations:checked.required_approvals,accept_target_risks:true});
  assert.ok(publish.published_version_id);
  const opts={workflow_id:workflowId,inputs:{},idempotency_key:'mcp-prod-smoke-'+label};
  const started=await tool('workflow_run',opts);
  runId=started.run_id;
  assert.match(runId,uuid);
  assert.equal((await tool('workflow_run',opts)).run_id,runId);
  let outcome;
  for(let i=0;i<90;i++){
    // Read-only result requests may time out; never retry workflow_run.
    try{outcome=await tool('workflow_result',{run_id:runId});}
    catch(error){
      if(!/Request timed out/i.test(String(error))||i>=89)throw error;
      await new Promise(r=>setTimeout(r,1500));
      continue;
    }
    if(terminal.has(outcome.status)||outcome.status==='indeterminate')break;
    await new Promise(r=>setTimeout(r,1000));
  }
  assert.equal(outcome?.status,'succeeded','Production MCP Workflow did not finish successfully');
  assert.equal(outcome.steps.length,2);
  assert.ok(outcome.steps.every(s=>s.status==='succeeded'));
  assert.ok(Array.isArray(outcome.result?.content),'No read-only MCP result content');
  console.log('MCP_PRODUCTION_SMOKE_OK: pinned Portal + IMA read-only + published Workflow + result');
}

async function runS3Smoke() {
  const credential=process.env.WORKFLOW_EXECUTOR_TOKEN;
  assert.ok(credential && credential.length>=20,'Dedicated GitHub token missing');
  const outstanding=sql("SELECT count(*) AS n FROM runs WHERE outcome NOT IN ('succeeded','failed','cancelled')");
  assert.equal(outstanding[0]?.n,0,'Production has nonterminal Runs: GitHub smoke aborted');
  await client.connect(transport);
  const definition={version:1,name:'workflow-github-production-smoke-'+label,steps:[
    {id:'heavy',uses:'github.run',with:{capability:'heavy.github.echo'}},
    {id:'emit',needs:['heavy'],uses:'result.emit',
      with:{data:{ref:'steps.heavy.output'}}},
  ]};
  const draft=await tool('workflow_create',{definition:JSON.stringify(definition)});
  workflowId=draft.workflow_id;
  assert.match(workflowId,uuid);
  const checked=await tool('workflow_validate',{workflow_id:workflowId,revision:1});
  assert.equal(checked.valid,true);
  assert.equal(checked.requires_heavy_execution_approval,true);
  const denied=await client.callTool({name:'workflow_publish',arguments:{
    workflow_id:workflowId,expected_revision:1,
  }});
  assert.equal(denied.isError,true,'Unapproved GitHub Publish must be rejected');
  const approved=await tool('workflow_publish',{
    workflow_id:workflowId,expected_revision:1,approve_heavy_execution:true,
  });
  assert.ok(approved.published_version_id);
  const opts={workflow_id:workflowId,inputs:{},idempotency_key:'github-prod-smoke-'+label};
  const first=await tool('workflow_run',opts);
  runId=first.run_id;
  assert.match(runId,uuid);
  assert.equal((await tool('workflow_run',opts)).run_id,runId,
    'Idempotency must reuse original physical dispatch');
  let outcome;
  for(let i=0;i<220;i++){
    try{outcome=await tool('workflow_result',{run_id:runId});}
    catch(error){
      if(!/Request timed out/i.test(String(error)))throw error;
      await new Promise(r=>setTimeout(r,1200));continue;
    }
    if(terminal.has(outcome.status)||outcome.status==='indeterminate')break;
    await new Promise(r=>setTimeout(r,1200));
  }
  assert.equal(outcome?.status,'succeeded','GitHub business outcome not succeeded');
  assert.equal(outcome.steps.length,2);
  assert.ok(outcome.steps.every(s=>s.status==='succeeded'));
  assert.equal(outcome.result?.echo,'ok');
  assert.equal(outcome.result?.source,'workflow-github-executor');
  const attempt=sql('SELECT candidate_run_id,candidate_run_attempt FROM step_attempts WHERE run_id='+quotedId(runId));
  assert.equal(attempt.length,1,'Expected one durable GitHub Attempt');
  assert.ok(Number.isSafeInteger(attempt[0].candidate_run_id)&&attempt[0].candidate_run_id>0);
  assert.equal(attempt[0].candidate_run_attempt,1);
  const receipts=sql('SELECT count(*) AS n FROM callback_receipts WHERE attempt_id IN (SELECT attempt_id FROM step_attempts WHERE run_id='+quotedId(runId)+')');
  assert.equal(receipts[0]?.n,1,'Expected one durable callback');
  const url='https://api.github.com/repos/lirtual/mcp-workers/actions/runs/'+attempt[0].candidate_run_id;
  for(let i=0;i<70;i++){
    const response=await fetch(url,{headers:{
      accept:'application/vnd.github+json',authorization:'Bearer '+credential,
      'user-agent':'mcp-workers-github-production-smoke',
    },redirect:'manual',signal:AbortSignal.timeout(12000)});
    assert.equal(response.status,200,'GitHub physical job state unavailable');
    const run=await response.json();
    if(run.status==='completed'){
      assert.equal(run.conclusion,'success','Physical GitHub Job did not succeed');
      s3PhysicalCompleted=true;break;
    }
    await new Promise(r=>setTimeout(r,1000));
  }
  assert.equal(s3PhysicalCompleted,true,'Physical GitHub Job not completed');
  console.log('GITHUB_PRODUCTION_SMOKE_OK: one Echo, OIDC callback, physical Job complete');
}

try {
  await (process.env.WORKFLOW_GITHUB_SMOKE==='true'?runS3Smoke():
    process.env.WORKFLOW_MCP_SMOKE==='true'?runS2Smoke():runSmoke());
} catch (e) {
  failure = e;
  console.error('SMOKE_FAILED:', String(e?.message ?? e).replaceAll(token, '[redacted]'));
} finally {
  try { await client.close(); } catch { /* No successful state assumed from close */ }
  try { cleanup(); } catch (e) {
    failure ??= e;
    console.error('CLEANUP_FAILED:', String(e?.message ?? e).replaceAll(token, '[redacted]'));
    if (workflowId) console.error('Manual follow-up Workflow ID:', workflowId);
  }
}
if (failure) process.exitCode = 1;
