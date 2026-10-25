// Deliberately narrow production acceptance: one temporary result-only Workflow, no deployment.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { scopedPublicMcpFetch, PRODUCTION_PORTAL_ENDPOINT } from '../src/mcp-public-fetch.ts';
import { toolSchemaDigest } from '../src/plan.ts';
import {WORKFLOW_MIGRATION_READINESS_SQL,verifyWorkflowCodeReleaseReadiness} from '../../../scripts/manual-worker-release.mjs';

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
let githubPhysicalCompleted = false;
let webhookCredential;

function sql(statement) {
  // stdout contains JSON only; do not log credentials, SQL args or Wrangler internals.
  const output = execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute',
    'workflow-mcp-db', '--remote', '--json', '--command', statement], {
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
  if((process.env.WORKFLOW_GITHUB_SMOKE==='true' || process.env.WORKFLOW_ACTION_TASK_SMOKE==='true') && runId && !githubPhysicalCompleted)
    throw Error('Refusing GitHub cleanup until physical GitHub Job is completed');
  if(process.env.WORKFLOW_GITHUB_SMOKE==='true' || process.env.WORKFLOW_ACTION_TASK_SMOKE==='true'){
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

  // Reuse the existing authenticated native acceptance and cleanup pipeline
  // for a two-stage pure Foreach, retaining a normal final emit Step.
  const definition = {
    version: 1, name: echo, inputs: { items: ['A','B'], subject: echo },
    steps: [
      { id: 'each', flow: 'foreach', items: { ref: 'inputs.items' }, max_items: 2,
        template: { steps: [
          { id: 'prepare', uses: 'result.emit',
            with: { data: { value: { ref: 'item.value' }, index: { ref: 'item.index' } } } },
          { id: 'finish', uses: 'result.emit',
            with: { data: { ref: 'steps.prepare.output.value' } } },
        ] } },
      { id: 'report', needs: ['each'], uses: 'result.emit',
        with: { data: { ref: 'inputs.subject' } } },
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
  const inputs = { subject: echo, items: ['A','B'] };
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
  assert.equal(status.steps.length, 6);
  for(const id of ['each','each_0_prepare','each_0_finish',
    'each_1_prepare','each_1_finish','report'])
    assert.equal(status.steps.find(s => s.step_id === id)?.status, 'succeeded', id);
  const result = await tool('workflow_result', { run_id: runId });
  assert.equal(result.result, echo);
  const saved = sql("SELECT output FROM run_steps WHERE run_id = " +
    quotedId(runId) + " AND step_id = 'each'");
  assert.deepEqual(JSON.parse(saved[0]?.output ?? 'null'), ['A','B'],
    'Only the item-local second stage output should be collected');
  console.log('MULTI_EMIT_FOREACH_PRODUCTION_OK: four checkpointed native children, immutable item-local outputs, all D1 Steps terminal');
  console.log('SMOKE_OK: authenticated Draft → Validate → Publish → Run → Result; idempotency and result verified');
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
      // Reuse the same reviewed Portal grant; each item runs a pure
      // prepare Step followed by a real read-only MCP call consuming its
      // previously checkpointed result. No new test worker or endpoint.
      {id:'each',flow:'foreach',items:{ref:'inputs.limits'},max_items:2,
        template:{steps:[
          {id:'prepare',uses:'result.emit',with:{data:{ref:'item.value'}}},
          {id:'list',uses:'mcp.call',with:{
            endpoint:PRODUCTION_PORTAL_ENDPOINT,tool:'ima_list_notebooks',
            scope:'read',arguments:{limit:{ref:'steps.prepare.output'}},
            input_schema:candidate.inputSchema,
            ...(candidate.outputSchema?{output_schema:candidate.outputSchema}:{})
          }},
        ]}},
      {id:'emit',needs:['read','each'],uses:'result.emit',
        with:{data:{direct:{ref:'steps.read.output'},mapped:{ref:'steps.each.output'}}}},
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
  const opts={workflow_id:workflowId,inputs:{limits:[1,1]},
    idempotency_key:'mcp-prod-smoke-'+label};
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
  assert.equal(outcome.steps.length,7);
  assert.ok(outcome.steps.every(s=>s.status==='succeeded'));
  assert.ok(Array.isArray(outcome.result?.direct?.content),'No static read-only MCP result');
  assert.equal(outcome.result?.mapped?.length,2,'Bounded Foreach result missing');
  assert.ok(outcome.result.mapped.every(x=>Array.isArray(x?.content)),
    'One dynamic MCP child result missing');
  for(const id of ['each','each_0_prepare','each_0_list','each_1_prepare','each_1_list','read','emit'])
    assert.equal(outcome.steps.find(s=>s.step_id===id)?.status,'succeeded',id);
  console.log('MULTI_MCP_FOREACH_PRODUCTION_OK: pinned Portal + per-item prepare result + read-only MCP, native arg checkpoints, published grant and scoped cleanup');
  console.log('MCP_PRODUCTION_SMOKE_OK: pinned Portal + static and bounded dynamic read-only MCP + published Workflow + replay + scoped cleanup');
}

async function runS3Smoke() {
  const credential=process.env.WORKFLOW_GITHUB_DISPATCH_TOKEN;
  assert.ok(credential && credential.length>=20,'Dedicated GitHub token missing');
  const outstanding=sql("SELECT count(*) AS n FROM runs WHERE outcome NOT IN ('succeeded','failed','cancelled')");
  assert.equal(outstanding[0]?.n,0,'Production has nonterminal Runs: GitHub smoke aborted');
  await client.connect(transport);
  const definition={version:1,name:'workflow-github-production-smoke-'+label,steps:[
    {id:'heavy',uses:'github.run',with:{capability:'github.workflow.check'}},
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
  assert.equal(outcome.result?.task,'github.workflow.check');
  assert.equal(outcome.result?.status,'passed');
  assert.equal(outcome.result?.repository,'lirtual/mcp-workers');
  assert.equal(outcome.result?.ref,'refs/heads/main');
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
      githubPhysicalCompleted=true;break;
    }
    await new Promise(r=>setTimeout(r,1000));
  }
  assert.equal(githubPhysicalCompleted,true,'Physical GitHub Job not completed');
  console.log('GITHUB_PRODUCTION_SMOKE_OK: one CI verification, OIDC callback, physical Job complete');
}

async function runActionTaskSmoke() {
  const credential=process.env.WORKFLOW_GITHUB_DISPATCH_TOKEN;
  assert.ok(credential && credential.length>=20,'Dedicated GitHub token missing');
  // Reuse the proven code-only release safety gate. An already Ready Session
  // owned by a succeeded parent and a claimed OIDC Attempt is unrelated to
  // this Task-only check and must remain untouched. Any unsettled Task,
  // unexpected Session, unresolved Run/Step or undelivered callback aborts.
  // Cleanup below is still scoped to this test's randomized Workflow UUID.
  const ready=verifyWorkflowCodeReleaseReadiness([{
    success:true,results:sql(WORKFLOW_MIGRATION_READINESS_SQL),
  }]);
  console.log('TASK_SMOKE_PREFLIGHT_OK: code-release safety gate passed; retained Ready Sessions:',
    ready.confirmed_ready_sessions);
  await client.connect(transport);
  const catalog=await tool('workflow_action_list',{});
  assert.ok(Array.isArray(catalog.actions),'Action catalog unavailable');
  const candidates=catalog.actions.filter(a=>a.repository==='lirtual/session-actions' &&
    a.repositoryId===1430925009 && a.workflowPath==='.github/workflows/verify-action.yml' &&
    a.name==='Verify Workflow Action' && a.type==='task' && a.can_publish===true);
  assert.equal(candidates.length,1,'Expected one verified released Task, not an untagged HEAD');
  const found=candidates[0];
  assert.deepEqual(found.inputs.outcome.options,['success','failure']);
  const reviewed={repository:found.repository,repositoryId:found.repositoryId,
    workflowId:found.workflowId,workflowPath:found.workflowPath,
    commitSha:found.commitSha,type:found.type,contractDigest:found.contractDigest};
  assert.match(found.ref,/^refs\/tags\//,'Task must be pinned to a verified Tag');
  const action={...reviewed,ref:found.ref,inputs:{outcome:'success'}};
  // This acceptance client uses only the Workflow MCP's advertised contracts,
  // not local copies of Portal tool schemas or GitHub version identities.
  const overview=await tool('workflow_capabilities',{});
  assert.ok(overview.action_with_schemas?.['mcp.call']);
  assert.ok(overview.expression_rules?.operators.includes('eq'));
  const portal=await tool('workflow_capabilities',{id:'action.mcp.call'});
  assert.equal(portal.availability,'verified_contract','Trusted Portal tool was not accessible');
  const read=portal.discovered_tools.find(t=>t.tool==='ima_list_notebooks');
  assert.ok(read && read.availability==='discovered_not_executed');
  const readStep={id:'read',uses:'mcp.call',with:{
    endpoint:read.endpoint,tool:read.tool,scope:read.scope,
    arguments:read.arguments,input_schema:read.input_schema,
    ...(read.output_schema?{output_schema:read.output_schema}:{}),
  }};
  const definition={version:1,name:'workflow-agent-first-'+label,
    inputs:{items:['success','success']},
    steps:[readStep,
      {id:'each',flow:'foreach',needs:['read'],items:{ref:'inputs.items'},max_items:2,
        template:{steps:[
          {id:'prepare',uses:'result.emit',with:{data:{ref:'item.value'}}},
          {id:'verify',uses:'github.run',
            if:{ne:[{ref:'steps.prepare.output'},'skip']},
            with:{capability:'github.action',action}},
          {id:'finish',uses:'result.emit',
            with:{data:{ref:'steps.verify.output'}}},
        ]}},
      {id:'out',uses:'result.emit',needs:['each'],
        with:{data:{ref:'steps.each.status'}}},
    ]};
  const before=sql('SELECT count(*) AS n FROM workflows')[0].n;
  const bad={...definition,steps:[{...readStep,uses:'made_up_action'},...definition.steps.slice(1)]};
  const invalid=await tool('workflow_validate',{definition:JSON.stringify(bad)});
  assert.equal(invalid.valid,false);
  assert.equal(invalid.issues[0].code,'unsupported_capability');
  assert.equal(invalid.issues[0].path,'/steps/0/uses');
  const inline=await tool('workflow_validate',{definition:JSON.stringify(definition)});
  assert.equal(inline.valid,true,'Source-blind inline Definition must validate');
  assert.equal(sql('SELECT count(*) AS n FROM workflows')[0].n,before,
    'Inline validation unexpectedly wrote D1');
  const draft=await tool('workflow_create',{definition:JSON.stringify(definition)});
  workflowId=draft.workflow_id;
  assert.match(workflowId,uuid);
  const checked=await tool('workflow_validate',{workflow_id:workflowId,revision:1});
  assert.equal(checked.valid,true,'Reviewed Action validation must pass');
  assert.deepEqual(checked.reviewed_actions,[reviewed]);
  assert.deepEqual(checked.required_approvals,[{endpoint:read.endpoint,tool:read.tool,
    scope:'read',schema_digest:read.schema_digest}]);
  const denied=await client.callTool({name:'workflow_publish',arguments:{
    workflow_id:workflowId,expected_revision:1,approve_heavy_execution:true,
  }});
  assert.equal(denied.isError,true,'Action Publish without exact reviewed grant must fail');
  const published=await tool('workflow_publish',{
    workflow_id:workflowId,expected_revision:1,
    approved_operations:checked.required_approvals,accept_target_risks:true,
    approved_actions:checked.reviewed_actions,approve_heavy_execution:true,
  });
  assert.ok(published.published_version_id);
  // Exact pinned type/choice contract must be embedded in the durable Plan,
  // never inferred from a mutable branch or caller-supplied input at Run.
  const planRows=sql('SELECT plan FROM workflow_versions WHERE id='+quotedId(published.published_version_id));
  const pinnedPlan=JSON.parse(planRows[0]?.plan ?? '{}');
  const templates=pinnedPlan.steps.find(s=>s.id==='each')?.with?.templates;
  assert.deepEqual(templates?.map(s=>s.uses),['result.emit','github.run','result.emit']);
  assert.deepEqual(templates[1].with.action.inputs,{outcome:'success'});
  const opts={workflow_id:workflowId,inputs:{items:['success','success']},
    idempotency_key:'action-task-smoke-'+label};
  const started=await tool('workflow_run',opts);
  runId=started.run_id;
  assert.match(runId,uuid);
  assert.equal((await tool('workflow_run',opts)).run_id,runId,
    'Action start idempotency must retain the same physical run');
  let outcome;
  for(let i=0;i<180;i++){
    try{outcome=await tool('workflow_result',{run_id:runId});}
    catch(error){
      if(!/Request timed out/i.test(String(error)))throw error;
      await new Promise(r=>setTimeout(r,1200));continue;
    }
    if(terminal.has(outcome.status)||outcome.status==='indeterminate')break;
    await new Promise(r=>setTimeout(r,1200));
  }
  assert.equal(outcome?.status,'succeeded','Pinned GitHub Action Task did not succeed');
  assert.equal(outcome.steps.length,9);
  assert.ok(outcome.steps.every(step=>step.status==='succeeded'));
  assert.equal(outcome.result,'succeeded');
  for(const id of ['read','each','each_0_prepare','each_0_verify','each_0_finish','each_1_prepare','each_1_verify','each_1_finish','out'])
    assert.equal(outcome.steps.find(x=>x.step_id===id)?.status,'succeeded',id);
  const rows=sql('SELECT step_id,candidate_run_id,candidate_run_attempt,owner_run_id,owner_run_attempt,state FROM step_attempts WHERE run_id='+quotedId(runId)+' ORDER BY step_id');
  assert.equal(rows.length,2,'Expected exactly two bounded GitHub Task Attempts');
  assert.deepEqual(rows.map(x=>x.step_id),['each_0_verify','each_1_verify']);
  assert.equal(new Set(rows.map(x=>x.candidate_run_id)).size,2,
    'Distinct selected children must dispatch distinct physical GitHub Runs');
  for(const attempt of rows){
    assert.ok(Number.isSafeInteger(attempt.candidate_run_id)&&attempt.candidate_run_id>0);
    assert.equal(attempt.candidate_run_attempt,1);
    assert.equal(attempt.owner_run_id,attempt.candidate_run_id);
    assert.equal(attempt.owner_run_attempt,1);
    assert.equal(attempt.state,'succeeded');
    const url='https://api.github.com/repos/lirtual/session-actions/actions/runs/'+attempt.candidate_run_id;
    let terminalPhysical=false;
    for(let i=0;i<60;i++){
      const response=await fetch(url,{headers:{
        accept:'application/vnd.github+json',authorization:'Bearer '+credential,
        'user-agent':'mcp-workers-action-task-smoke',
      },redirect:'manual',signal:AbortSignal.timeout(12000)});
      assert.equal(response.status,200,'Pinned physical Action Run not readable');
      const physical=await response.json();
      assert.equal(physical.head_sha,reviewed.commitSha,'Physical code SHA changed');
      assert.equal(physical.repository?.id,reviewed.repositoryId,'Physical repository mismatch');
      if(physical.status==='completed'){
        assert.equal(physical.conclusion,'success','Physical Action Task failed');
        terminalPhysical=true;break;
      }
      await new Promise(r=>setTimeout(r,1000));
    }
    assert.equal(terminalPhysical,true,'One physical GitHub Task still running');
  }
  githubPhysicalCompleted=true;
  console.log('FOREACH_EMIT_TASK_EMIT_PRODUCTION_OK: two reviewed literal Task children, native conditional selection, two physical terminal proofs, signed OIDC and item-local follow-up emit');
  console.log('FOREACH_GITHUB_TASK_PRODUCTION_OK: pinned Task source, signed Claims, distinct physical GitHub terminal proofs, D1 Attempt identity, no duplicate Run');
}


async function runWebhookSmoke() {
  const outstanding=sql("SELECT count(*) AS n FROM runs WHERE outcome NOT IN ('succeeded','failed','cancelled')");
  assert.equal(outstanding[0]?.n,0,'Nonterminal production Run blocks acceptance');
  await client.connect(transport);
  const ability=await tool('workflow_capabilities',{id:'trigger.webhook'});
  assert.equal(ability.availability,'supported','Production Webhook support is not deployed');
  webhookCredential=randomBytes(32).toString('base64url');
  assert.equal(webhookCredential.length,43);
  const tokenHash=createHash('sha256').update(webhookCredential).digest('hex');
  const definition={version:1,name:'webhook-production-smoke-'+label,
    inputs:{payload:null},
    triggers:[{type:'webhook',token_sha256:tokenHash}],
    steps:[{id:'emit',uses:'result.emit',with:{data:{ref:'inputs.payload'}}}]};
  const checked=await tool('workflow_validate',{definition:JSON.stringify(definition)});
  assert.equal(checked.valid,true);
  const draft=await tool('workflow_create',{definition:JSON.stringify(definition)});
  workflowId=draft.workflow_id;
  assert.match(workflowId,uuid);
  const published=await tool('workflow_publish',{workflow_id:workflowId,expected_revision:1});
  assert.ok(published.published_version_id);

  const endpoint=base+'/triggers/webhook/'+workflowId;
  async function deliver(payload,eventId,credential=webhookCredential){
    return fetch(endpoint,{
      method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),
      headers:{authorization:'Bearer '+credential,'content-type':'application/json',
        'x-workflow-event-id':eventId},
      body:JSON.stringify({payload}),
    });
  }
  const wrong=await deliver(echo,'untrusted-'+label,randomBytes(32).toString('base64url'));
  assert.equal(wrong.status,401,'Wrong token must not admit a Run');
  assert.equal(workflowRows().length,0,'Wrong token changed D1');

  const stableId='webhook-smoke-'+label;
  const first=await deliver(echo,stableId);
  assert.equal(first.status,202,'First authenticated event must be accepted');
  const firstRun=await first.json();
  runId=firstRun.run_id;
  assert.match(runId,uuid);
  assert.equal(firstRun.published_version_id,published.published_version_id);
  assert.equal(firstRun.deduplication,'stable_event_id');
  const replay=await deliver(echo,stableId);
  assert.equal(replay.status,200,'Duplicate stable event should replay');
  assert.equal((await replay.json()).run_id,runId,'Duplicate event dispatched another Run');
  assert.equal(workflowRows().length,1,'Duplicate event inserted an extra Run');
  assert.equal((await deliver('different',stableId)).status,409,
    'Changing an admitted event payload must conflict');
  const second=await deliver(echo,'distinct-'+label);
  assert.equal(second.status,202);
  const secondRun=await second.json();
  assert.notEqual(secondRun.run_id,runId);
  assert.equal(workflowRows().length,2,'Distinct stable event must create a new Run');

  for(const id of [runId,secondRun.run_id]){
    let result;
    for(let attempt=0;attempt<60;attempt++){
      result=await tool('workflow_result',{run_id:id});
      if(terminal.has(result.status)||result.status==='indeterminate')break;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    assert.equal(result?.status,'succeeded','Webhook Run not terminal success');
    assert.equal(result.result,echo);
    assert.deepEqual(result.steps.map(x=>x.status),['succeeded']);
  }
  const rows=sql(`SELECT DISTINCT version_id,admission_key,outcome FROM runs WHERE workflow_id=${quotedId(workflowId)}`);
  assert.equal(rows.length,2);
  assert.ok(rows.every(x=>x.version_id===published.published_version_id &&
    x.outcome==='succeeded' && /^webhook-[a-f0-9]{64}$/.test(x.admission_key)));

  await tool('workflow_pause',{workflow_id:workflowId});
  assert.equal((await deliver(echo,'paused-'+label)).status,409,
    'Paused published plan must not admit events');
  assert.equal(workflowRows().length,2);
  console.log('WEBHOOK_PRODUCTION_SMOKE_OK: wrong-token denied, duplicate stable event deduplicated, two immutable-version Runs succeeded, pause protected');
}

try {
  await (process.env.WORKFLOW_ACTION_TASK_SMOKE==='true'?runActionTaskSmoke():
    process.env.WORKFLOW_GITHUB_SMOKE==='true'?runS3Smoke():
    process.env.WORKFLOW_MCP_SMOKE==='true'?runS2Smoke():
    process.env.WORKFLOW_WEBHOOK_SMOKE==='true'?runWebhookSmoke():runSmoke());
} catch (e) {
  failure = e;
  console.error('SMOKE_FAILED:', String(e?.message ?? e).replaceAll(token, '[redacted]').replaceAll(webhookCredential ?? '__no_webhook_credential__', '[redacted]'));
} finally {
  try { await client.close(); } catch { /* No successful state assumed from close */ }
  try { cleanup(); } catch (e) {
    failure ??= e;
    console.error('CLEANUP_FAILED:', String(e?.message ?? e).replaceAll(token, '[redacted]').replaceAll(webhookCredential ?? '__no_webhook_credential__', '[redacted]'));
    if (workflowId) console.error('Manual follow-up Workflow ID:', workflowId);
  }
}
if (failure) process.exitCode = 1;
