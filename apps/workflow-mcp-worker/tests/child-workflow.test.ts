import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { LIMITS } from '../src/capabilities.ts';
import { TRUSTED_PORTAL_ENDPOINT } from '../src/mcp-public-fetch.ts';
import { toolSchemaDigest } from '../src/plan.ts';
import type { Env } from '../src/store.ts';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import readonlyWorker from './fixtures/readonly-worker.ts';

const hook = registerHooks({resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return {
    url: 'data:text/javascript,export class WorkflowEntrypoint { constructor(ctx,env){this.env=env;} }',
    shortCircuit: true,
  };
  return next(specifier, context);
}});
const [{default: ownerWorker}, {WorkflowRunner}] = await Promise.all([
  import('../src/index.ts'),
  import('../src/runner.ts'),
]);
hook.deregister();

const TOKEN = 'disposable-portal-token-child-t12';
const ORIGIN = 'https://owner.example.org/mcp';
const PORTAL_SECRET = 'portal-secret-value-ok';
const PINNED_SCHEMA = {type: 'object', properties: {
  value: {type: 'string', maxLength: 4096},
  delay_ms: {type: 'integer', minimum: 0, maximum: 15000},
}, required: ['value'], '$schema': 'https://json-schema.org/draft/2020-12/schema', additionalProperties: false};
const PINNED_DIGEST = await toolSchemaDigest(PINNED_SCHEMA);
const MIGRATIONS = ['0001_s1.sql', '0002_native_complete_seen.sql', '0003_s3_attempt_claim.sql', '0004_s3_callback_receipts.sql', '0005_github_workflow_check.sql', '0006_github_registered_action.sql', '0007_run_cancel.sql', '0008_grant_revocation.sql', '0009_runtime_approval.sql','0010_child_run.sql'];

type Call = (name: string, args: Record<string, unknown>, error?: string) => Promise<any>;

function harness(t: test.TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of MIGRATIONS) sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  function prepare(sql: string) {
    let args: any[] = [];
    return {
      bind(...values: any[]) { args = values; return this; },
      async first() { return sqlite.prepare(sql).get(...args) ?? null; },
      async all() { return {results: sqlite.prepare(sql).all(...args)}; },
      async run() { return {meta: {changes: Number(sqlite.prepare(sql).run(...args).changes)}}; },
    };
  }
  let nativeStatus = 'running';
  let holding = false;
  let exhaustChildWaits = false;
  let releaseHold = () => {};
  let holdGate = Promise.resolve();
  const inflight = new Map<string, Promise<void>>();
  const env = {
    MCP_ACCESS_TOKEN: TOKEN,
    MCP_PORTAL_CLIENT_ID: 'child-workflow-portal-id',
    MCP_PORTAL_CLIENT_SECRET: PORTAL_SECRET,
    MCP_PORTAL_ENDPOINT: TRUSTED_PORTAL_ENDPOINT,
    DB: {prepare, async batch(items: {run: () => Promise<unknown>}[]) { return Promise.all(items.map(item => item.run())); }},
    WORKFLOW: {
      async create() {},
      async get() {
        return {async status() { return {status: nativeStatus}; }};
      },
    },
  } as unknown as Env;
  const step = {
    async do(_name: unknown, _options: unknown, callback: () => Promise<unknown>) { return callback(); },
    async waitForEvent() {
      if (exhaustChildWaits) throw new Error('child-wait-budget');
      if (holding) await holdGate;
      const rows = sqlite.prepare("SELECT id FROM runs WHERE outcome IN ('queued','running')").all() as {id: string}[];
      for (const row of rows) await execute(row.id);
      throw new Error('reread-child');
    },
  };
  function execute(runId: string): Promise<void> {
    const existing = inflight.get(runId);
    if (existing) return existing;
    const promise = (async () => {
      try {
        await new WorkflowRunner({} as ExecutionContext, env).run(
          {payload: {run_id: runId}} as WorkflowEvent<{run_id: string}>,
          step as unknown as WorkflowStep,
        );
      } finally {
        inflight.delete(runId);
      }
    })();
    inflight.set(runId, promise);
    return promise;
  }
  function armHold() {
    holding = true;
    holdGate = new Promise<void>(resolve => {
      releaseHold = () => { holding = false; resolve(); };
    });
  }
  t.after(async () => {
    holding = false;
    releaseHold();
    await Promise.allSettled([...inflight.values()]);
    sqlite.close();
  });
  async function until(predicate: () => boolean) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (predicate()) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error(JSON.stringify(sqlite.prepare('SELECT id,outcome,parent_run_id,child_mode,call_depth,error_code FROM runs').all()));
  }
  const client = new Client({name: 'child-workflow-test', version: '0.1.0'});
  const transport = new StreamableHTTPClientTransport(new URL(ORIGIN), {
    requestInit: {headers: {authorization: 'Bearer ' + TOKEN}},
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => ownerWorker.fetch(new Request(input, init), env)) as typeof fetch,
  });
  async function call(name: string, args: Record<string, unknown>, error?: string) {
    const output = await client.callTool({name, arguments: args});
    const first = output.content[0];
    if (!first || first.type !== 'text') throw new Error('unexpected_tool_content');
    assert.equal(first.text.includes(PORTAL_SECRET), false, first.text);
    const value = JSON.parse(first.text);
    if (error) {
      assert.equal(output.isError, true);
      assert.equal(value.error, error);
    } else assert.notEqual(output.isError, true, first.text);
    return value;
  }
  return {sqlite, env, call, client, transport, execute, armHold, releaseHold: () => releaseHold(), until, exhaustChildWaits() { exhaustChildWaits = true; }, setNative(status: string) { nativeStatus = status; }};
}

async function publish(call: Call, definition: unknown, approvals?: unknown[]) {
  const body = JSON.stringify(definition);
  const created = await call('workflow_create', {definition: body});
  await call('workflow_publish', {
    workflow_id: created.workflow_id,
    expected_revision: 1,
    ...(approvals ? {approved_operations: approvals, accept_target_risks: true} : {}),
  });
  return created.workflow_id as string;
}

function emitWorkflow(name: string, data: unknown, inputs?: Record<string, unknown>) {
  return {version: 1, name, ...(inputs ? {inputs} : {}), steps: [{id: 'emit', uses: 'result.emit', with: {data}}]};
}

test('a published parent waits for the child result and propagates the child failure', async t => {
  const {call, client, transport, execute} = harness(t);
  await client.connect(transport);
  const childId = await publish(call, emitWorkflow('Child', 'from-child'));
  const failingId = await publish(call, {
    version: 1, name: 'Failing child', inputs: {flag: {type: 'number'}},
    steps: [{id: 'bad', uses: 'result.emit', if: {ref: 'inputs.flag'}, with: {data: 'unused'}}],
  });
  const parentId = await publish(call, {
    version: 1, name: 'Parent',
    steps: [
      {id: 'call', uses: 'workflow.call', with: {workflow_id: childId, inputs: {}}},
      {id: 'report', needs: ['call'], uses: 'result.emit', with: {data: {ref: 'steps.call.output'}}},
    ],
  });
  const admitted = await call('workflow_run', {workflow_id: parentId});
  await execute(admitted.run_id);
  const result = await call('workflow_result', {run_id: admitted.run_id});
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result, 'from-child');

  const failingParent = await publish(call, {
    version: 1, name: 'Parent of failure',
    steps: [{id: 'call', uses: 'workflow.call', with: {workflow_id: failingId, inputs: {flag: {ref: 'inputs.flag'}}}}],
    inputs: {flag: {type: 'number'}},
  });
  const failed = await call('workflow_run', {workflow_id: failingParent, inputs: {flag: 1}});
  await execute(failed.run_id);
  const failure = await call('workflow_result', {run_id: failed.run_id});
  assert.equal(failure.status, 'failed');
  assert.equal(failure.steps.find((step: {step_id: string}) => step.step_id === 'call').error_code, 'step_execution_failed');
});

test('the child uses its own grant and rejects a parent secret or connection input', async t => {
  const {call, client, transport, execute, sqlite} = harness(t);
  const previous = globalThis.fetch;
  let toolCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.method === 'POST' ? await request.clone().text() : '';
    assert.equal(body.includes(PORTAL_SECRET), false);
    if (body.includes('tools/call')) {
      toolCalls++;
      assert.equal(body.includes('owned-by-child'), true);
    }
    return readonlyWorker.fetch(request);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = previous; });
  await client.connect(transport);
  const childDef = {
    version: 1, name: 'Echo child',
    steps: [{id: 'read', uses: 'mcp.call', with: {
      endpoint: TRUSTED_PORTAL_ENDPOINT, tool: 'echo', scope: 'read', input_schema: PINNED_SCHEMA,
      arguments: {value: 'owned-by-child'},
    }}],
  };
  const preview = await call('workflow_validate', {definition: JSON.stringify(childDef)});
  assert.equal(preview.valid, true);
  const childId = await publish(call, childDef, preview.required_approvals);
  const parentId = await publish(call, {
    version: 1, name: 'Parent without grant',
    steps: [
      {id: 'call', uses: 'workflow.call', with: {workflow_id: childId, inputs: {}}},
      {id: 'report', needs: ['call'], uses: 'result.emit', with: {data: {ref: 'steps.call.output'}}},
    ],
  });
  const plans = sqlite.prepare('SELECT workflow_id, plan FROM workflow_versions').all() as {workflow_id: string; plan: string}[];
  const childPlan = plans.find(row => row.workflow_id === childId)?.plan ?? '';
  const parentPlan = plans.find(row => row.workflow_id === parentId)?.plan ?? '';
  assert.equal(childPlan.includes('mcp_approvals'), true);
  assert.equal(parentPlan.includes('mcp_approvals'), false);
  assert.equal(parentPlan.includes(PORTAL_SECRET), false);
  const admitted = await call('workflow_run', {workflow_id: parentId});
  await execute(admitted.run_id);
  const result = await call('workflow_result', {run_id: admitted.run_id});
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.content[0].text, 'owned-by-child');
  assert.equal(JSON.stringify(result).includes(PORTAL_SECRET), false);
  assert.equal(toolCalls, 1);

  const declared = await publish(call, emitWorkflow('Declared', {ref: 'inputs.subject'}, {subject: 'seed'}));
  const leaky = await publish(call, {
    version: 1, name: 'Leaky parent', inputs: {subject: 'seed'},
    steps: [{id: 'call', uses: 'workflow.call', with: {workflow_id: declared, inputs: {subject: {ref: 'inputs.subject'}}}}],
  });
  const rejected = await call('workflow_run', {workflow_id: leaky, inputs: {subject: PORTAL_SECRET}});
  await execute(rejected.run_id);
  const secretResult = await call('workflow_result', {run_id: rejected.run_id});
  assert.equal(secretResult.status, 'failed');
  assert.equal(secretResult.steps[0].error_code, 'child_input_rejected');
  const leakedChildren = sqlite.prepare('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id=?').get(rejected.run_id) as {n: number};
  assert.equal(leakedChildren.n, 0);
  const target = await call('workflow_validate', {definition: JSON.stringify({
    version: 1, name: 'Target input',
    steps: [{id: 'call', uses: 'workflow.call', with: {workflow_id: declared, inputs: {endpoint: 'https://evil.example/mcp'}}}],
  })});
  assert.equal(target.valid, false);
  assert.equal(target.issues[0].code, 'target_argument_rejected');
});

test('a detached child keeps running after the parent finishes and is outside parent cancel', async t => {
  const {call, client, transport, execute, sqlite, armHold, releaseHold, until, setNative} = harness(t);
  await client.connect(transport);
  const sideId = await publish(call, emitWorkflow('Side', 'side-done'));
  const waitedId = await publish(call, emitWorkflow('Waited', 'waited-done', {subject: 'seed'}));
  const finisher = await publish(call, {
    version: 1, name: 'Detach only',
    steps: [
      {id: 'kick', uses: 'workflow.call', with: {workflow_id: sideId, detach: true, inputs: {}}},
      {id: 'done', needs: ['kick'], uses: 'result.emit', with: {data: 'parent-finished'}},
    ],
  });
  const finished = await call('workflow_run', {workflow_id: finisher});
  await execute(finished.run_id);
  const finishedResult = await call('workflow_result', {run_id: finished.run_id});
  assert.equal(finishedResult.status, 'succeeded');
  assert.equal(finishedResult.result, 'parent-finished');
  const side = sqlite.prepare("SELECT id, outcome, cancel_requested_at FROM runs WHERE parent_run_id=? AND child_mode='detach'").get(finished.run_id) as {id: string; outcome: string; cancel_requested_at: number | null};
  assert.equal(side.outcome, 'queued');
  assert.equal(side.cancel_requested_at, null);
  await execute(side.id);
  assert.equal((await call('workflow_result', {run_id: side.id})).result, 'side-done');
  assert.equal((await call('workflow_result', {run_id: finished.run_id})).result, 'parent-finished');

  const parentId = await publish(call, {
    version: 1, name: 'Detach and await',
    steps: [
      {id: 'side', uses: 'workflow.call', with: {workflow_id: sideId, detach: true, inputs: {}}},
      {id: 'wait', uses: 'workflow.call', with: {workflow_id: waitedId, inputs: {subject: 'seed'}}},
    ],
  });
  armHold();
  const admitted = await call('workflow_run', {workflow_id: parentId});
  const running = execute(admitted.run_id);
  await until(() => {
    const parent = sqlite.prepare('SELECT outcome FROM runs WHERE id=?').get(admitted.run_id) as {outcome: string};
    const children = sqlite.prepare('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id=?').get(admitted.run_id) as {n: number};
    return parent.outcome === 'waiting' && children.n === 2;
  });
  const requested = await call('workflow_cancel', {run_id: admitted.run_id});
  assert.equal(requested.cancellation, 'requested');
  assert.notEqual(requested.status, 'cancelled');
  const awaited = sqlite.prepare("SELECT id, cancel_requested_at FROM runs WHERE parent_run_id=? AND child_mode='await'").get(admitted.run_id) as {id: string; cancel_requested_at: number | null};
  const detached = sqlite.prepare("SELECT id, cancel_requested_at, outcome FROM runs WHERE parent_run_id=? AND child_mode='detach'").get(admitted.run_id) as {id: string; cancel_requested_at: number | null; outcome: string};
  assert.notEqual(awaited.cancel_requested_at, null);
  assert.equal(detached.cancel_requested_at, null);
  const awaitedStatus = await call('workflow_status', {run_id: awaited.id});
  assert.equal(awaitedStatus.cancellation, 'requested');
  assert.notEqual(awaitedStatus.status, 'cancelled');
  await execute(detached.id);
  assert.equal((await call('workflow_result', {run_id: detached.id})).status, 'succeeded');
  assert.equal((await call('workflow_status', {run_id: detached.id})).cancellation, undefined);
  setNative('terminated');
  const cancelled = await call('workflow_status', {run_id: admitted.run_id});
  assert.equal(cancelled.cancellation, 'cancelled');
  assert.equal(cancelled.status, 'cancelled');
  const childCancelled = await call('workflow_status', {run_id: awaited.id});
  assert.equal(childCancelled.cancellation, 'cancelled');
  assert.equal(childCancelled.status, 'cancelled');
  releaseHold();
  await running;
  assert.equal((sqlite.prepare('SELECT cancel_requested_at FROM runs WHERE id=?').get(detached.id) as {cancel_requested_at: number | null}).cancel_requested_at, null);
});

test('an exhausted child wait stays unconfirmed and does not take the child success or an advancing slot', async t => {
  const {call, client, transport, execute, sqlite, until, exhaustChildWaits} = harness(t);
  await client.connect(transport);
  const childId = await publish(call, emitWorkflow('Slow child', 'child-ok'));
  const parentId = await publish(call, {
    version: 1, name: 'Budget parent',
    steps: [
      {id: 'call', uses: 'workflow.call', with: {workflow_id: childId, inputs: {}}},
      {id: 'report', needs: ['call'], uses: 'result.emit', with: {data: {ref: 'steps.call.output'}}},
    ],
  });
  exhaustChildWaits();
  const admitted = await call('workflow_run', {workflow_id: parentId});
  await execute(admitted.run_id);
  const parked = sqlite.prepare('SELECT outcome, result FROM runs WHERE id=?').get(admitted.run_id) as {outcome: string; result: string | null};
  const child = sqlite.prepare('SELECT id, outcome FROM runs WHERE parent_run_id=?').get(admitted.run_id) as {id: string; outcome: string};
  const step = sqlite.prepare("SELECT status, error_code, output FROM run_steps WHERE run_id=? AND step_id='call'").get(admitted.run_id) as {status: string; error_code: string | null; output: string | null};
  assert.equal(child.outcome, 'queued');
  assert.equal(parked.outcome, 'waiting');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM runs WHERE id=? AND outcome IN ('queued','running')").get(admitted.run_id)?.n, 0);
  assert.equal(step.status, 'indeterminate');
  assert.equal(step.error_code, 'child_wait_unconfirmed');
  assert.equal(step.output, null);
  const waiting = await call('workflow_status', {run_id: admitted.run_id});
  assert.equal(waiting.status, 'waiting');
  assert.notEqual(waiting.status, 'succeeded');
  assert.equal(waiting.steps.find((item: {step_id: string}) => item.step_id === 'call').error_code, 'child_wait_unconfirmed');
  await execute(child.id);
  await until(() => (sqlite.prepare('SELECT outcome FROM runs WHERE id=?').get(child.id) as {outcome: string}).outcome === 'succeeded');
  const parent = await call('workflow_result', {run_id: admitted.run_id});
  const childResult = await call('workflow_result', {run_id: child.id});
  assert.equal(childResult.status, 'succeeded');
  assert.equal(childResult.result, 'child-ok');
  assert.notEqual(parent.status, 'succeeded');
  assert.notEqual(parent.result, 'child-ok');
  assert.equal(parent.steps.find((item: {step_id: string}) => item.step_id === 'call').error_code, 'child_wait_unconfirmed');
  assert.equal((sqlite.prepare('SELECT outcome FROM runs WHERE id=?').get(admitted.run_id) as {outcome: string}).outcome === 'running', false);
  await execute(admitted.run_id);
  const replayed = await call('workflow_result', {run_id: admitted.run_id});
  assert.notEqual(replayed.status, 'succeeded');
  assert.notEqual(replayed.result, 'child-ok');
});

test('eight waiting parents do not block child admission', async t => {
  const {call, client, transport, execute, sqlite, armHold, releaseHold, until} = harness(t);
  await client.connect(transport);
  const childId = await publish(call, emitWorkflow('Slot child', 'child-ok'));
  const parentId = await publish(call, {
    version: 1, name: 'Slot parent', inputs: {subject: 'seed'},
    steps: [
      {id: 'call', uses: 'workflow.call', with: {workflow_id: childId, inputs: {}}},
      {id: 'report', needs: ['call'], uses: 'result.emit', with: {data: {ref: 'steps.call.output'}}},
    ],
  });
  armHold();
  const pending: Promise<void>[] = [];
  for (let index = 0; index < LIMITS.admissionCap; index++) {
    const admitted = await call('workflow_run', {workflow_id: parentId});
    pending.push(execute(admitted.run_id));
    await until(() => {
      const parent = sqlite.prepare('SELECT outcome FROM runs WHERE id=?').get(admitted.run_id) as {outcome: string};
      const child = sqlite.prepare('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id=?').get(admitted.run_id) as {n: number};
      return parent.outcome === 'waiting' && child.n === 1;
    });
  }
  const waiting = sqlite.prepare("SELECT COUNT(*) AS n FROM runs WHERE parent_run_id IS NULL AND outcome='waiting'").get() as {n: number};
  const children = sqlite.prepare('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id IS NOT NULL').get() as {n: number};
  assert.equal(waiting.n, LIMITS.admissionCap);
  assert.equal(children.n, LIMITS.admissionCap);
  await call('workflow_run', {workflow_id: childId}, 'run_capacity_exceeded');
  releaseHold();
  await Promise.all(pending);
  const results = sqlite.prepare("SELECT result FROM runs WHERE parent_run_id IS NULL").all() as {result: string}[];
  assert.equal(results.length, LIMITS.admissionCap);
  assert.deepEqual(results.map(row => JSON.parse(row.result)), Array.from({length: LIMITS.admissionCap}, () => 'child-ok'));
});

test('child recursion stops at the published depth and a paused child is not admitted', async t => {
  const {call, client, transport, execute, sqlite} = harness(t);
  await client.connect(transport);
  const created = await call('workflow_create', {definition: JSON.stringify(emitWorkflow('Recur', 1, {n: {type: 'number'}}))});
  const workflowId = created.workflow_id as string;
  const updated = await call('workflow_update', {
    workflow_id: workflowId, expected_revision: 1,
    definition: JSON.stringify({
      version: 1, name: 'Recur', inputs: {n: {type: 'number'}},
      steps: [{id: 'again', uses: 'workflow.call', with: {workflow_id: workflowId, inputs: {n: {ref: 'inputs.n'}}}}],
    }),
  });
  await call('workflow_publish', {workflow_id: workflowId, expected_revision: updated.draft_revision});
  const root = await call('workflow_run', {workflow_id: workflowId, inputs: {n: 1}});
  await execute(root.run_id);
  const failure = await call('workflow_result', {run_id: root.run_id});
  assert.equal(failure.status, 'failed');
  assert.equal(failure.steps[0].error_code, 'child_depth_exceeded');
  const count = sqlite.prepare('SELECT COUNT(*) AS n, MAX(call_depth) AS depth FROM runs').get() as {n: number; depth: number};
  assert.equal(count.n, LIMITS.maxChildDepth + 1);
  assert.equal(count.depth, LIMITS.maxChildDepth);

  const pausedChild = await publish(call, emitWorkflow('Paused child', 'nope'));
  await call('workflow_pause', {workflow_id: pausedChild});
  const parentId = await publish(call, {
    version: 1, name: 'Parent of paused',
    steps: [{id: 'call', uses: 'workflow.call', with: {workflow_id: pausedChild, inputs: {}}}],
  });
  const blocked = await call('workflow_run', {workflow_id: parentId});
  await execute(blocked.run_id);
  const blockedResult = await call('workflow_result', {run_id: blocked.run_id});
  assert.equal(blockedResult.status, 'failed');
  assert.equal(blockedResult.steps[0].error_code, 'workflow_not_active');
  const childRows = sqlite.prepare('SELECT COUNT(*) AS n FROM runs WHERE workflow_id=?').get(pausedChild) as {n: number};
  assert.equal(childRows.n, 0);
});

test('capabilities mark workflow.call and saga supported', async t => {
  const {call, client, transport} = harness(t);
  await client.connect(transport);
  const overview = await call('workflow_capabilities', {});
  const child = overview.capabilities.find((entry: {id: string}) => entry.id === 'flow.child_workflow');
  const saga = overview.capabilities.find((entry: {id: string}) => entry.id === 'flow.saga');
  assert.equal(child.status, 'supported');
  assert.equal(saga.status, 'supported');
  const detail = await call('workflow_capabilities', {id: 'flow.child_workflow'});
  assert.equal(detail.uses, 'workflow.call');
  assert.equal(detail.limits.max_child_depth, LIMITS.maxChildDepth);
  assert.equal(detail.limits.admission_cap, LIMITS.admissionCap);
  assert.equal(detail.limits.max_child_waits, LIMITS.maxChildWaits);
  assert.match(detail.completion, /child_wait_unconfirmed/);
  assert.match(detail.completion, new RegExp(String(LIMITS.maxChildWaits)));
  const validated = await call('workflow_validate', {definition: JSON.stringify(detail.example)});
  assert.equal(validated.valid, true);
  const expansion = await call('workflow_capabilities', {id: 'flow.dynamic_expansion'});
  assert.equal(expansion.template_uses.includes('workflow.call'), false);
  const sagaDetail = await call('workflow_capabilities', {id: 'flow.saga'});
  assert.equal(sagaDetail.status, 'supported');
  assert.equal(sagaDetail.boundary, 'not_an_acid_rollback');
});
