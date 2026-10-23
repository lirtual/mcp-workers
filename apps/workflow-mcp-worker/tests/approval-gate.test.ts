import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toolSchemaDigest } from '../src/plan.ts';
import { waitForRuntimeApproval } from '../src/runtime-approval.ts';
import { PORTAL_ENDPOINT } from '../src/mcp-public-fetch.ts';
import type { Env } from '../src/store.ts';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import noteWorker from './fixtures/controlled-note-worker.ts';

const hook = registerHooks({resolve(specifier, context, next){
  if (specifier === 'cloudflare:workers') return {
    url: 'data:text/javascript,export class WorkflowEntrypoint { constructor(ctx,env){this.env=env;} }',
    shortCircuit: true,
  };
  return next(specifier, context);
}});
const [{default: ownerWorker}, {WorkflowRunner}] = await Promise.all([
  import('../src/index.ts'), import('../src/runner.ts'),
]);
hook.deregister();

const TRUSTED = PORTAL_ENDPOINT;
const PORTAL_ID = 'test-only-service-token-id';
const PORTAL_SECRET = 'test-only-service-token-secret';
const OWNER = 'https://owner.example.org/mcp';
const TOKEN = 'disposable-portal-token-approval-gate';
const MIGRATIONS = ['0001_s1.sql','0002_native_complete_seen.sql','0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql','0005_github_workflow_check.sql','0006_github_registered_action.sql','0007_run_cancel.sql','0008_grant_revocation.sql','0009_runtime_approval.sql','0010_child_run.sql'];
const BINDING = ['run_id', 'step_id', 'published_version_id'];

type Wake = {resolve: () => void; reject: (error: Error) => void};

function harness(t: test.TestContext){
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  for (const name of MIGRATIONS) sqlite.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  function prepare(sql: string){
    let args: any[] = [];
    return {
      bind(...values: unknown[]){ args = values; return this; },
      async first(){ return sqlite.prepare(sql).get(...args) ?? null; },
      async all(){ return {results: sqlite.prepare(sql).all(...args)}; },
      async run(){ return {meta: {changes: Number(sqlite.prepare(sql).run(...args).changes)}}; },
    };
  }
  const waiters = new Map<string, Wake>();
  const timeoutRuns = new Set<string>();
  let holdWakes = false;
  let noteCalls = 0;
  const env = {
    MCP_ACCESS_TOKEN: TOKEN,
    MCP_PORTAL_CLIENT_ID: PORTAL_ID,
    MCP_PORTAL_CLIENT_SECRET: PORTAL_SECRET,
    MCP_PORTAL_ENDPOINT: TRUSTED,
    DB: {prepare, async batch(items: {run: () => Promise<unknown>}[]){ return Promise.all(items.map(item => item.run())); }},
    WORKFLOW: {
      async create(){},
      async get(instanceId: string){
        return {
          async status(){ return {status: 'running'}; },
          async sendEvent(event: {type: string}){
            if (holdWakes) return;
            waiters.get(instanceId + '|' + event.type)?.resolve();
          },
        };
      },
    },
  } as unknown as Env;
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.method === 'POST' ? await request.clone().text() : '';
    assert.equal(body.includes(PORTAL_SECRET), false);
    if (request.url !== TRUSTED) throw new Error('unexpected_target');
    if (request.method === 'POST'){
      const rpc = JSON.parse(body) as {method?: string};
      if (rpc.method === 'tools/call') noteCalls++;
    }
    return noteWorker.fetch(request);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = previous; });
  const client = new Client({name: 'approval-gate', version: '0.1.0'});
  const transport = new StreamableHTTPClientTransport(new URL(OWNER), {
    requestInit: {headers: {authorization: 'Bearer ' + TOKEN}},
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => ownerWorker.fetch(new Request(input, init), env)) as typeof fetch,
  });
  async function call(name: string, args: Record<string, unknown>, error?: string){
    const output = await client.callTool({name, arguments: args});
    const first = output.content[0];
    if (!first || first.type !== 'text') throw new Error('unexpected_tool_content');
    assert.equal(first.text.includes(PORTAL_SECRET), false, name);
    const value = JSON.parse(first.text);
    if (error){
      assert.equal(output.isError, true, name);
      assert.equal(value.error, error);
    } else assert.notEqual(output.isError, true, name + ' ' + first.text);
    return value;
  }
  function stepFor(runId: string): WorkflowStep{
    return {
      async do(_name: unknown, _options: unknown, fn: () => Promise<unknown>){ return fn(); },
      async waitForEvent(_name: unknown, options: {type: string}){
        if (timeoutRuns.has(runId)) throw new Error('approval_wake_timeout');
        return await new Promise((resolve, reject) => {
          waiters.set(runId + '|' + options.type, {resolve: () => resolve({}), reject});
        });
      },
    } as unknown as WorkflowStep;
  }
  function run(runId: string){
    return new WorkflowRunner({} as ExecutionContext, env).run(
      {payload: {run_id: runId}} as WorkflowEvent<{run_id: string}>,
      stepFor(runId),
    );
  }
  function stopWaiting(runId: string){
    timeoutRuns.add(runId);
    for (const [key, wake] of [...waiters]){
      if (!key.startsWith(runId + '|')) continue;
      waiters.delete(key);
      wake.reject(new Error('approval_wake_timeout'));
    }
  }
  return {
    call, client, transport, run, stopWaiting, env, sqlite,
    counts: () => ({noteCalls}),
    hold(value: boolean){ holdWakes = value; },
    rows: () => Number(sqlite.prepare('SELECT COUNT(*) AS n FROM runtime_approvals').get()?.n),
  };
}

async function noteSchema(){
  const client = new Client({name: 'note-schema', version: '0.1.0'});
  const transport = new StreamableHTTPClientTransport(new URL(TRUSTED), {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => noteWorker.fetch(new Request(input, init))) as typeof fetch,
  });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const tool = listed.tools.find(item => item.name === 'note');
    if (!tool) throw new Error('note_missing');
    return JSON.parse(JSON.stringify(tool.inputSchema));
  } finally {
    await client.close();
  }
}

async function untilStatus(call: (name: string, args: Record<string, unknown>) => Promise<any>, runId: string, status: string){
  for (let attempt = 0; attempt < 50; attempt++){
    const current = await call('workflow_status', {run_id: runId});
    const step = current.steps.find((item: {step_id: string}) => item.step_id === 'save');
    if (step?.status === status) return current;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('status_not_' + status);
}

test('discovery and validation show which high-impact actions wait, and reads do not', async t => {
  const {call, client, transport} = harness(t);
  await client.connect(transport);
  try {
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /not an ACID rollback/);
    assert.match(instructions, /do not create that approval/);
    assert.match(instructions, /workflow_approval/);
    const write = await call('workflow_capabilities', {id: 'action.mcp.write'});
    const read = await call('workflow_capabilities', {id: 'action.mcp.call'});
    const http = await call('workflow_capabilities', {id: 'action.http'});
    const github = await call('workflow_capabilities', {id: 'action.github.run'});
    assert.equal(write.approval_gate.high_impact, true);
    assert.equal(write.approval_gate.optional, true);
    assert.equal(write.approval_gate.scope, 'write');
    assert.equal(write.approval_gate.when, 'before_dispatch');
    assert.deepEqual(write.approval_gate.binding, BINDING);
    assert.equal(write.approval_gate.effect, 'once');
    assert.equal(read.approval_gate.high_impact, false);
    assert.equal(read.approval_gate.when, 'not_used');
    assert.equal(read.approval_gate.scope, 'read');
    assert.equal(http.approval_gate.when, 'not_used');
    assert.equal(github.approval_gate.scope, 'github_execution');
    assert.equal(github.approval_gate.when, 'before_dispatch');
    assert.equal('approval' in write.schema.properties, true);
    assert.equal('approval' in read.schema.properties, false);
    const plain = await call('workflow_validate', {definition: JSON.stringify(write.example)});
    assert.equal(plain.valid, true);
    assert.equal('approval_gates' in plain, false);
    assert.equal(plain.required_approvals[0].scope, 'write');
    const gated = structuredClone(write.example);
    gated.steps[0].approval = {required: true};
    const preview = await call('workflow_validate', {definition: JSON.stringify(gated)});
    assert.deepEqual(preview.approval_gates, [{
      step_id: gated.steps[0].id,
      action: 'mcp.call',
      scope: 'write',
      when: 'before_dispatch',
      binding: BINDING,
      effect: 'once',
    }]);
    const widened = structuredClone(gated);
    widened.steps[0].approval = {required: true, scope: 'admin'};
    const extra = await call('workflow_validate', {definition: JSON.stringify(widened)});
    assert.equal(extra.valid, false);
    assert.equal(extra.issues[0].code, 'unsupported_field');
    const argument = structuredClone(gated);
    argument.steps[0].with.arguments = {approval: {required: true}, value: 'x'};
    const smuggled = await call('workflow_validate', {definition: JSON.stringify(argument)});
    assert.equal(smuggled.valid, false);
    assert.equal(smuggled.issues[0].code, 'approval_argument_rejected');
    const readGate = structuredClone(read.example);
    readGate.steps[0].approval = {required: true};
    const readRejected = await call('workflow_validate', {definition: JSON.stringify(readGate)});
    assert.equal(readRejected.valid, false);
    assert.equal(readRejected.issues[0].code, 'approval_not_applicable');
    const httpGate = structuredClone(http.example);
    httpGate.steps[0].approval = {required: true};
    const httpRejected = await call('workflow_validate', {definition: JSON.stringify(httpGate)});
    assert.equal(httpRejected.valid, false);
    assert.equal(httpRejected.issues[0].code, 'approval_not_applicable');
    const heavy = structuredClone(github.example);
    heavy.steps[0].approval = {required: true};
    const heavyPreview = await call('workflow_validate', {definition: JSON.stringify(heavy)});
    assert.equal(heavyPreview.approval_gates[0].scope, 'github_execution');
    assert.equal(heavyPreview.approval_gates[0].when, 'before_dispatch');
    assert.equal(heavyPreview.requires_heavy_execution_approval, true);
    const sameScope = structuredClone(gated);
    sameScope.steps[0].with.arguments = {value: 'x', scope: 'admin', endpoint: 'https://evil.example/mcp'};
    const unchanged = await call('workflow_validate', {definition: JSON.stringify(sameScope)});
    assert.equal(unchanged.required_approvals[0].scope, 'write');
    assert.equal(unchanged.required_approvals[0].endpoint, gated.steps[0].with.endpoint);
    assert.equal(unchanged.approval_gates[0].scope, 'write');
  } finally {
    await client.close();
  }
});

test('one matching approval dispatches once; denial, timeout, mismatch, repeat, and revocation do not', async t => {
  const ctx = harness(t);
  const schema = await noteSchema();
  const digest = await toolSchemaDigest(schema);
  await ctx.client.connect(ctx.transport);
  try {
    const definition = {version: 1, name: 'Gated note', inputs: {message: 'x'}, steps: [{
      id: 'save', uses: 'mcp.call', approval: {required: true},
      with: {endpoint: TRUSTED, tool: 'note', scope: 'write', input_schema: schema, arguments: {value: {ref: 'inputs.message'}}},
    }]};
    const created = await ctx.call('workflow_create', {definition: JSON.stringify(definition)});
    const preview = await ctx.call('workflow_validate', {workflow_id: created.workflow_id, revision: 1});
    const grant = preview.required_approvals[0];
    assert.deepEqual(grant, {endpoint: TRUSTED, tool: 'note', scope: 'write', schema_digest: digest});
    assert.equal(preview.approval_gates[0].step_id, 'save');
    const base = {workflow_id: created.workflow_id, expected_revision: 1};
    const published = await ctx.call('workflow_publish', {...base, approved_operations: [grant], accept_target_risks: true});
    assert.equal(published.approval_gates[0].scope, 'write');
    assert.equal(ctx.rows(), 0);
    assert.equal(ctx.counts().noteCalls, 0);

    const started = await ctx.call('workflow_run', {workflow_id: created.workflow_id, inputs: {message: 'once'}});
    const execution = ctx.run(started.run_id);
    const finished = execution.then(() => undefined, () => undefined);
    t.after(async () => { ctx.stopWaiting(started.run_id); await finished; });
    const waiting = await untilStatus(ctx.call, started.run_id, 'waiting_approval');
    assert.equal(waiting.steps.find((step: {step_id: string}) => step.step_id === 'save').status, 'waiting_approval');
    assert.equal(ctx.counts().noteCalls, 0);

    const otherVersion = '00000000-0000-4000-8000-0000000000aa';
    await ctx.call('workflow_approval', {
      run_id: started.run_id, step_id: 'save', published_version_id: otherVersion, decision: 'approve',
    }, 'approval_binding_mismatch');
    await ctx.call('workflow_approval', {
      run_id: started.run_id, step_id: 'other', published_version_id: published.published_version_id, decision: 'approve',
    }, 'approval_not_required');
    await ctx.call('workflow_approval', {
      run_id: '00000000-0000-4000-8000-0000000000bb', step_id: 'save', published_version_id: published.published_version_id, decision: 'approve',
    }, 'run_not_found');
    assert.equal(ctx.counts().noteCalls, 0);
    assert.equal(ctx.rows(), 0);

    const approved = await ctx.call('workflow_approval', {
      run_id: started.run_id, step_id: 'save', published_version_id: published.published_version_id, decision: 'approve',
    });
    assert.equal(approved.decision, 'approved');
    assert.equal(approved.consumed, false);
    assert.equal(approved.human_presence, false);
    await finished;
    const done = await ctx.call('workflow_result', {run_id: started.run_id});
    assert.equal(done.status, 'succeeded');
    assert.equal(done.result.content[0].text, 'stored:once');
    assert.equal(ctx.counts().noteCalls, 1);
    const repeated = await ctx.call('workflow_approval', {
      run_id: started.run_id, step_id: 'save', published_version_id: published.published_version_id, decision: 'approve',
    });
    assert.equal(repeated.consumed, true);
    await ctx.call('workflow_approval', {
      run_id: started.run_id, step_id: 'save', published_version_id: published.published_version_id, decision: 'deny',
    }, 'approval_conflict');
    assert.equal(ctx.counts().noteCalls, 1);

    const deniedRun = await ctx.call('workflow_run', {workflow_id: created.workflow_id, inputs: {message: 'no'}});
    const deniedExecution = ctx.run(deniedRun.run_id);
    const deniedFinished = deniedExecution.then(() => undefined, () => undefined);
    t.after(async () => { ctx.stopWaiting(deniedRun.run_id); await deniedFinished; });
    await untilStatus(ctx.call, deniedRun.run_id, 'waiting_approval');
    await ctx.call('workflow_approval', {
      run_id: deniedRun.run_id, step_id: 'save', published_version_id: published.published_version_id, decision: 'deny',
    });
    await deniedFinished;
    const denied = await ctx.call('workflow_status', {run_id: deniedRun.run_id});
    assert.equal(denied.status, 'failed');
    assert.equal(denied.steps.find((step: {step_id: string}) => step.step_id === 'save').error_code, 'approval_denied');
    assert.equal(ctx.counts().noteCalls, 1);

    const timed = await ctx.call('workflow_run', {workflow_id: created.workflow_id, inputs: {message: 'late'}});
    const timedExecution = ctx.run(timed.run_id);
    const timedFinished = timedExecution.then(() => undefined, () => undefined);
    t.after(async () => { ctx.stopWaiting(timed.run_id); await timedFinished; });
    await untilStatus(ctx.call, timed.run_id, 'waiting_approval');
    ctx.stopWaiting(timed.run_id);
    await timedFinished;
    const timedOut = await ctx.call('workflow_status', {run_id: timed.run_id});
    assert.equal(timedOut.steps.find((step: {step_id: string}) => step.step_id === 'save').error_code, 'approval_timeout');
    assert.equal(ctx.counts().noteCalls, 1);

    const other = await ctx.call('workflow_run', {workflow_id: created.workflow_id, inputs: {message: 'other-run'}});
    const approvedOther = await ctx.call('workflow_run', {workflow_id: created.workflow_id, inputs: {message: 'matched-run'}});
    const otherExecution = ctx.run(other.run_id);
    const matchedExecution = ctx.run(approvedOther.run_id);
    const otherFinished = otherExecution.then(() => undefined, () => undefined);
    const matchedFinished = matchedExecution.then(() => undefined, () => undefined);
    t.after(async () => { ctx.stopWaiting(other.run_id); ctx.stopWaiting(approvedOther.run_id); await otherFinished; await matchedFinished; });
    await untilStatus(ctx.call, other.run_id, 'waiting_approval');
    await untilStatus(ctx.call, approvedOther.run_id, 'waiting_approval');
    await ctx.call('workflow_approval', {
      run_id: approvedOther.run_id, step_id: 'save', published_version_id: published.published_version_id, decision: 'approve',
    });
    await matchedFinished;
    const matched = await ctx.call('workflow_result', {run_id: approvedOther.run_id});
    assert.equal(matched.result.content[0].text, 'stored:matched-run');
    assert.equal(ctx.counts().noteCalls, 2);
    ctx.stopWaiting(other.run_id);
    await otherFinished;
    const untouched = await ctx.call('workflow_status', {run_id: other.run_id});
    assert.equal(untouched.steps.find((step: {step_id: string}) => step.step_id === 'save').error_code, 'approval_timeout');
    assert.equal(ctx.counts().noteCalls, 2);

    ctx.hold(true);
    const blocked = await ctx.call('workflow_run', {workflow_id: created.workflow_id, inputs: {message: 'revoked'}});
    const blockedExecution = ctx.run(blocked.run_id);
    const blockedFinished = blockedExecution.then(() => undefined, () => undefined);
    t.after(async () => { ctx.stopWaiting(blocked.run_id); await blockedFinished; });
    await untilStatus(ctx.call, blocked.run_id, 'waiting_approval');
    await ctx.call('workflow_approval', {
      run_id: blocked.run_id, step_id: 'save', published_version_id: published.published_version_id, decision: 'approve',
    });
    await ctx.call('workflow_revoke', {
      workflow_id: created.workflow_id, published_version_id: published.published_version_id, operation: grant,
    });
    ctx.hold(false);
    ctx.stopWaiting(blocked.run_id);
    await blockedFinished;
    const revoked = await ctx.call('workflow_status', {run_id: blocked.run_id});
    assert.equal(revoked.steps.find((step: {step_id: string}) => step.step_id === 'save').error_code, 'grant_revoked');
    assert.equal(ctx.counts().noteCalls, 2);
  } finally {
    await ctx.client.close();
  }
});

test('workflow_approval before an open gate does not authorize the write', async t => {
  const ctx = harness(t);
  const schema = await noteSchema();
  await ctx.client.connect(ctx.transport);
  try {
    const definition = {version: 1, name: 'Early approval', inputs: {message: 'early'}, steps: [{
      id: 'save', uses: 'mcp.call', approval: {required: true},
      with: {endpoint: TRUSTED, tool: 'note', scope: 'write', input_schema: schema, arguments: {value: {ref: 'inputs.message'}}},
    }]};
    const created = await ctx.call('workflow_create', {definition: JSON.stringify(definition)});
    const preview = await ctx.call('workflow_validate', {workflow_id: created.workflow_id, revision: 1});
    const published = await ctx.call('workflow_publish', {
      workflow_id: created.workflow_id, expected_revision: 1,
      approved_operations: preview.required_approvals, accept_target_risks: true,
    });
    const write = await ctx.call('workflow_capabilities', {id: 'action.mcp.write'});
    assert.match(write.approval_gate.declaration, /open/);
    const started = await ctx.call('workflow_run', {workflow_id: created.workflow_id, inputs: {message: 'early'}});
    await ctx.call('workflow_approval', {
      run_id: started.run_id, step_id: 'save', published_version_id: published.published_version_id, decision: 'approve',
    }, 'approval_not_open');
    assert.equal(ctx.rows(), 0);
    assert.equal(ctx.counts().noteCalls, 0);
    const execution = ctx.run(started.run_id);
    const finished = execution.then(() => undefined, () => undefined);
    t.after(async () => { ctx.stopWaiting(started.run_id); await finished; });
    await untilStatus(ctx.call, started.run_id, 'waiting_approval');
    await ctx.call('workflow_approval', {
      run_id: started.run_id, step_id: 'save', published_version_id: published.published_version_id, decision: 'approve',
    });
    await finished;
    const done = await ctx.call('workflow_result', {run_id: started.run_id});
    assert.equal(done.status, 'succeeded');
    assert.equal(done.result.content[0].text, 'stored:early');
    assert.equal(ctx.counts().noteCalls, 1);
  } finally {
    await ctx.client.close();
  }
});

test('replay resumes a consumed MCP or GitHub gate while the effect fence remains authoritative',async t=>{
  const ctx=harness(t);
  await ctx.client.connect(ctx.transport);
  const db=ctx.sqlite;
  const created=await ctx.call('workflow_create',{definition:JSON.stringify({version:1,name:'Approval replay base',steps:[{id:'emit',uses:'result.emit',with:{data:'ok'}}]})});
  const published=await ctx.call('workflow_publish',{workflow_id:created.workflow_id,expected_revision:1});
  const run=await ctx.call('workflow_run',{workflow_id:created.workflow_id});
  const runId=run.run_id,versionId=published.published_version_id;
  const at=Date.now();
  const workflowStep={async do(_name:unknown,_options:unknown,fn:()=>Promise<unknown>){return fn();},async waitForEvent(){throw Error('unexpected_wait');}} as unknown as WorkflowStep;
  for(const stepId of ['mcp_write','github_action']){
    db.prepare('INSERT INTO runtime_approval_gates(run_id,step_id,version_id,deadline_at) VALUES(?,?,?,?)').run(runId,stepId,versionId,at+60_000);
    db.prepare("INSERT INTO runtime_approvals(run_id,step_id,version_id,decision,created_at,consumed_at) VALUES(?,?,?,'approved',?,?)")
      .run(runId,stepId,versionId,at-1000,at-500);
    const result=await waitForRuntimeApproval(ctx.env.DB,workflowStep,runId,stepId,versionId,
      stepId==='mcp_write'?'exact-approved-grant':null,async()=>false);
    assert.deepEqual(result,{ok:true},stepId);
  }
  await ctx.client.close();
});

test('an expired approval gate does not authorize the write', async t => {
  const ctx = harness(t);
  const schema = await noteSchema();
  await ctx.client.connect(ctx.transport);
  try {
    const definition = {version: 1, name: 'Expired approval', inputs: {message: 'late'}, steps: [{
      id: 'save', uses: 'mcp.call', approval: {required: true},
      with: {endpoint: TRUSTED, tool: 'note', scope: 'write', input_schema: schema, arguments: {value: {ref: 'inputs.message'}}},
    }]};
    const created = await ctx.call('workflow_create', {definition: JSON.stringify(definition)});
    const preview = await ctx.call('workflow_validate', {workflow_id: created.workflow_id, revision: 1});
    const published = await ctx.call('workflow_publish', {
      workflow_id: created.workflow_id, expected_revision: 1,
      approved_operations: preview.required_approvals, accept_target_risks: true,
    });
    const started = await ctx.call('workflow_run', {workflow_id: created.workflow_id, inputs: {message: 'late'}});
    const execution = ctx.run(started.run_id);
    const finished = execution.then(() => undefined, () => undefined);
    t.after(async () => { ctx.stopWaiting(started.run_id); await finished; });
    await untilStatus(ctx.call, started.run_id, 'waiting_approval');
    ctx.sqlite.prepare('UPDATE runtime_approval_gates SET deadline_at=? WHERE run_id=?').run(Date.now() - 1, started.run_id);
    await ctx.call('workflow_approval', {
      run_id: started.run_id, step_id: 'save', published_version_id: published.published_version_id, decision: 'approve',
    }, 'approval_not_open');
    assert.equal(ctx.rows(), 0);
    ctx.stopWaiting(started.run_id);
    await finished;
    const timedOut = await ctx.call('workflow_status', {run_id: started.run_id});
    assert.equal(timedOut.steps.find((step: {step_id: string}) => step.step_id === 'save').error_code, 'approval_timeout');
    assert.equal(ctx.counts().noteCalls, 0);
  } finally {
    await ctx.client.close();
  }
});

test('an already authorized write without a gate does not wait', async t => {
  const ctx = harness(t);
  const schema = await noteSchema();
  await ctx.client.connect(ctx.transport);
  try {
    const definition = {version: 1, name: 'Plain note', inputs: {message: 'x'}, steps: [{
      id: 'save', uses: 'mcp.call',
      with: {endpoint: TRUSTED, tool: 'note', scope: 'write', input_schema: schema, arguments: {value: {ref: 'inputs.message'}}},
    }]};
    const created = await ctx.call('workflow_create', {definition: JSON.stringify(definition)});
    const preview = await ctx.call('workflow_validate', {workflow_id: created.workflow_id, revision: 1});
    assert.equal('approval_gates' in preview, false);
    await ctx.call('workflow_publish', {
      workflow_id: created.workflow_id, expected_revision: 1,
      approved_operations: preview.required_approvals, accept_target_risks: true,
    });
    const started = await ctx.call('workflow_run', {workflow_id: created.workflow_id, inputs: {message: 'direct'}});
    await ctx.run(started.run_id);
    const result = await ctx.call('workflow_result', {run_id: started.run_id});
    assert.equal(result.status, 'succeeded');
    assert.equal(result.result.content[0].text, 'stored:direct');
    assert.equal(ctx.counts().noteCalls, 1);
    assert.equal(ctx.rows(), 0);
  } finally {
    await ctx.client.close();
  }
});
