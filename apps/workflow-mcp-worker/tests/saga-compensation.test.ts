import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { TRUSTED_PORTAL_ENDPOINT } from '../src/mcp-public-fetch.ts';
import { CANCEL_SAGA_GRACE_MS } from '../src/run-cancel.ts';
import type { Env } from '../src/store.ts';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import noteWorker from './fixtures/controlled-note-worker.ts';

const hook=registerHooks({resolve(specifier,context,next){
  if(specifier==='cloudflare:workers')return {
    url:'data:text/javascript,export class WorkflowEntrypoint { constructor(ctx,env){this.env=env;} }',
    shortCircuit:true,
  };
  return next(specifier,context);
}});
const [{default:ownerWorker},{WorkflowRunner}]=await Promise.all([
  import('../src/index.ts'),import('../src/runner.ts'),
]);
hook.deregister();

const TRUSTED=TRUSTED_PORTAL_ENDPOINT;
const TOKEN='disposable-portal-token-saga-compensation';
const OWNER='https://owner.example.org/mcp';
const MIGRATIONS=['0001_s1.sql','0002_native_complete_seen.sql','0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql','0005_github_workflow_check.sql','0006_github_registered_action.sql','0007_run_cancel.sql','0008_grant_revocation.sql','0009_runtime_approval.sql','0010_child_run.sql'];
type Call={tool:string;value?:string};

function harness(t: test.TestContext){
  const sqlite=new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  for(const name of MIGRATIONS) sqlite.exec(readFileSync(new URL('../migrations/'+name, import.meta.url), 'utf8'));
  function prepare(sql:string){
    let args: any[]=[];
    return {
      bind(...values: unknown[]){args=values;return this;},
      async first(){return sqlite.prepare(sql).get(...args)??null;},
      async all(){return {results:sqlite.prepare(sql).all(...args)};},
      async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}}},
    };
  }
  const native=new Map<string, string>();
  let terminates=0;
  let trackTerminate=false;
  let releaseNotes=()=>{};
  let noteGate:Promise<void>|null=null;
  const env={
    MCP_ACCESS_TOKEN:TOKEN,
    MCP_PORTAL_CLIENT_ID:'test-only-service-token-id',
    MCP_PORTAL_CLIENT_SECRET:'test-only-service-token-secret',
    MCP_PORTAL_ENDPOINT:TRUSTED,
    DB:{prepare, async batch(items:{run:()=>Promise<unknown>}[]){return Promise.all(items.map(item=>item.run()));}},
    WORKFLOW:{async create(){}, async get(id:string){return {
      async status(){return {status:native.get(id)??'running'};},
      ...(trackTerminate?{async terminate(){terminates+=1;native.set(id,'terminated');}}:{}),
    };}},
  } as unknown as Env;
  const calls: Call[]=[];
  let armedRun: string | undefined;
  let notesAtArm=0;
  const previous=globalThis.fetch;
  globalThis.fetch=(async(input: RequestInfo|URL, init?: RequestInit)=>{
    const request=new Request(input, init);
    if(request.url!==TRUSTED) throw new Error('unexpected_target');
    if(request.method==='POST'){
      const body=await request.clone().text();
      const rpc=JSON.parse(body) as {method?:string;params?:{name?:string;arguments?:{value?:unknown}}};
      if(rpc.method==='tools/call' && rpc.params?.name){
        const value=rpc.params.arguments?.value;
        calls.push({tool:rpc.params.name, ...(typeof value==='string'?{value}:{})});
        if(rpc.params.name==='note' && armedRun && calls.filter(item=>item.tool==='note').length===notesAtArm+2)
          sqlite.prepare('UPDATE runs SET cancel_requested_at=? WHERE id=? AND cancel_requested_at IS NULL').run(Date.now(), armedRun);
        if(rpc.params.name==='note' && noteGate) await noteGate;
      }
    }
    return noteWorker.fetch(request);
  }) as typeof fetch;
  t.after(()=>{releaseNotes();globalThis.fetch=previous;});
  async function call(name: string, args: Record<string, unknown>, error?: string){
    const output=await client.callTool({name, arguments:args});
    const first=output.content[0];
    if(!first || first.type!=='text') throw new Error('unexpected_tool_content');
    const value=JSON.parse(first.text);
    if(error){
      assert.equal(output.isError, true, name);
      assert.equal(value.error, error);
    }else assert.notEqual(output.isError, true, name+' '+first.text);
    return value;
  }
  const client=new Client({name:'saga-compensation', version:'0.1.0'});
  const transport=new StreamableHTTPClientTransport(new URL(OWNER),{
    requestInit:{headers:{authorization:'Bearer '+TOKEN}},
    fetch:(async(input: RequestInfo|URL, init?: RequestInit)=>ownerWorker.fetch(new Request(input, init), env)) as typeof fetch,
  });
  async function run(runId: string){
    await new WorkflowRunner({} as ExecutionContext, env).run({payload:{run_id:runId}} as WorkflowEvent<{run_id:string}>,{
      do:async(_name: unknown, _options: unknown, fn: ()=>Promise<unknown>)=>fn(),
    } as unknown as WorkflowStep);
  }
  return {
    sqlite, call, run, client, transport, calls,
    arm(runId: string){armedRun=runId;notesAtArm=calls.filter(item=>item.tool==='note').length;},
    enableTerminate(){trackTerminate=true;},
    terminates:()=>terminates,
    holdNotes(){noteGate=new Promise(resolve=>{releaseNotes=()=>{noteGate=null;resolve();};});},
    releaseNotes(){releaseNotes();},
  };
}

async function toolSchemas(){
  const client=new Client({name:'saga-schema', version:'0.1.0'});
  const transport=new StreamableHTTPClientTransport(new URL(TRUSTED),{
    fetch:((input: RequestInfo|URL, init?: RequestInit)=>noteWorker.fetch(new Request(input, init))) as typeof fetch,
  });
  await client.connect(transport);
  try{
    const listed=await client.listTools();
    const schema=(name: string)=>{
      const tool=listed.tools.find(item=>item.name===name);
      if(!tool) throw new Error(name+'_missing');
      return JSON.parse(JSON.stringify(tool.inputSchema));
    };
    return {note:schema('note'), clear:schema('note_clear')};
  }finally{
    await client.close();
  }
}

function portalStep(id: string, schema: unknown, value: unknown, needs: string[]=[], compensate?: {schema: unknown; value: unknown}){
  return {
    id, ...(needs.length?{needs}:{}), uses:'mcp.call',
    with:{endpoint:TRUSTED, tool:'note', scope:'write', input_schema:schema, arguments:{value}},
    ...(compensate?{compensate:{
      tool:'note_clear', scope:'write', input_schema:compensate.schema, arguments:{value:compensate.value},
    }}:{}),
  };
}

const fails={id:'later', uses:'result.emit', with:{data:{ref:'inputs.blob'}}};
const blob='x'.repeat(50000);

test('discovery and publish show only explicit compensation grants', async t=>{
  const {call, client, transport, calls}=harness(t);
  const schemas=await toolSchemas();
  await client.connect(transport);
  try{
    const saga=await call('workflow_capabilities',{id:'flow.saga'});
    assert.equal(saga.status, 'supported');
    assert.equal(saga.boundary, 'not_an_acid_rollback');
    assert.deepEqual(saga.triggers, ['failure','cancel']);
    const preview=await call('workflow_validate',{definition:JSON.stringify(saga.example)});
    assert.equal(preview.valid, true);
    assert.equal(preview.saga.boundary, 'not_an_acid_rollback');
    assert.equal(preview.saga.compensations.length, 1);
    assert.equal(preview.saga.compensations[0].connection.scope, 'write');
    const empty=await call('workflow_validate',{definition:JSON.stringify({
      version:1, name:'Empty', saga:{}, steps:[{id:'a', uses:'result.emit', with:{data:1}}],
    })});
    assert.equal(empty.valid, false);
    assert.equal(empty.issues[0].code, 'invalid_saga');
    const read=await call('workflow_validate',{definition:JSON.stringify({
      version:1, name:'Read', saga:{on:['failure']}, steps:[{
        id:'a', uses:'mcp.call', compensate:{tool:'note_clear', scope:'write', input_schema:schemas.clear, arguments:{value:'x'}},
        with:{endpoint:TRUSTED, tool:'note', scope:'read', input_schema:schemas.note, arguments:{value:'x'}},
      }],
    })});
    assert.equal(read.issues[0].code, 'compensation_not_controlled');
    const definition={
      version:1, name:'Granted', saga:{on:['failure','cancel']},
      steps:[portalStep('save', schemas.note, 'kept', [], {schema:schemas.clear, value:'kept'})],
    };
    const created=await call('workflow_create',{definition:JSON.stringify(definition)});
    const checked=await call('workflow_validate',{workflow_id:created.workflow_id, revision:1});
    assert.equal(checked.saga.compensations[0].connection.endpoint, TRUSTED);
    assert.equal(checked.saga.compensations[0].connection.tool, 'note_clear');
    assert.equal(checked.saga.on.includes('failure') && checked.saga.on.includes('cancel'), true);
    const forward=checked.required_approvals.find((item:{tool:string})=>item.tool==='note');
    const clear=checked.required_approvals.find((item:{tool:string})=>item.tool==='note_clear');
    assert.equal(clear.schema_digest, checked.saga.compensations[0].schema_digest);
    await call('workflow_publish',{
      workflow_id:created.workflow_id, expected_revision:1, approved_operations:[forward], accept_target_risks:true,
    }, 'external_approval_required');
    const published=await call('workflow_publish',{
      workflow_id:created.workflow_id, expected_revision:1, approved_operations:[forward, clear], accept_target_risks:true,
    });
    assert.equal(published.saga.boundary, 'not_an_acid_rollback');
    assert.equal(published.saga.compensations[0].step_id, 'save');
    assert.equal(calls.length, 0);
  }finally{
    await client.close();
  }
});

test('a later failure compensates opted-in writes in reverse order and leaves the other write', async t=>{
  const {call, run, client, transport, calls}=harness(t);
  const schemas=await toolSchemas();
  await client.connect(transport);
  try{
    const definition={
      version:1, name:'Reverse', saga:{on:['failure']},
      steps:[
        portalStep('alpha', schemas.note, 'alpha', [], {schema:schemas.clear, value:'alpha'}),
        portalStep('side', schemas.note, 'side', ['alpha']),
        portalStep('beta', schemas.note, 'beta', ['side'], {schema:schemas.clear, value:'beta'}),
        {...fails, needs:['beta']},
      ],
    };
    const created=await call('workflow_create',{definition:JSON.stringify(definition)});
    const checked=await call('workflow_validate',{workflow_id:created.workflow_id, revision:1});
    const published=await call('workflow_publish',{
      workflow_id:created.workflow_id, expected_revision:1,
      approved_operations:checked.required_approvals, accept_target_risks:true,
    });
    assert.equal(published.saga.compensations.map((item:{step_id:string})=>item.step_id).includes('side'), false);
    const started=await call('workflow_run',{workflow_id:created.workflow_id, inputs:{blob}});
    await run(started.run_id);
    const result=await call('workflow_result',{run_id:started.run_id});
    assert.equal(result.status, 'failed');
    assert.equal(result.compensation.acid_rollback, false);
    assert.equal(result.compensation.trigger, 'failure');
    assert.deepEqual(result.compensation.steps.map((item:{step_id:string;status:string})=>[item.step_id,item.status]), [
      ['beta','succeeded'], ['alpha','succeeded'],
    ]);
    assert.deepEqual(calls.filter(item=>item.tool==='note_clear').map(item=>item.value), ['beta','alpha']);
    assert.equal(calls.filter(item=>item.tool==='note').length, 3);
  }finally{
    await client.close();
  }
});

test('a failed compensation does not skip another granted compensation', async t=>{
  const {call, run, client, transport, calls}=harness(t);
  const schemas=await toolSchemas();
  await client.connect(transport);
  try{
    const definition={
      version:1, name:'Partial', saga:{on:['failure']},
      steps:[
        portalStep('left', schemas.note, 'left', [], {schema:schemas.clear, value:'left'}),
        portalStep('right', schemas.note, 'right', [], {schema:schemas.clear, value:{ref:'steps.right.output.missing'}}),
        {...fails, needs:['left','right']},
      ],
    };
    const created=await call('workflow_create',{definition:JSON.stringify(definition)});
    const checked=await call('workflow_validate',{workflow_id:created.workflow_id, revision:1});
    await call('workflow_publish',{
      workflow_id:created.workflow_id, expected_revision:1,
      approved_operations:checked.required_approvals, accept_target_risks:true,
    });
    const started=await call('workflow_run',{workflow_id:created.workflow_id, inputs:{blob}});
    await run(started.run_id);
    const result=await call('workflow_result',{run_id:started.run_id});
    assert.equal(result.status, 'failed');
    assert.equal(result.compensation.acid_rollback, false);
    assert.deepEqual(result.compensation.steps.map((item:{step_id:string;status:string;error_code?:string})=>[item.step_id,item.status,item.error_code??null]), [
      ['right','failed','invalid_arguments'], ['left','succeeded',null],
    ]);
    assert.deepEqual(calls.filter(item=>item.tool==='note_clear').map(item=>item.value), ['left']);
  }finally{
    await client.close();
  }
});

test('parallel indeterminate dispatch is not an ACID rollback', async t=>{
  const {call, run, client, transport, calls}=harness(t);
  const schemas=await toolSchemas();
  await client.connect(transport);
  try{
    const definition={
      version:1, name:'Unknown', saga:{on:['failure']},
      steps:[
        portalStep('alpha', schemas.note, 'alpha', [], {schema:schemas.clear, value:'alpha'}),
        portalStep('beta', schemas.note, 'lose', [], {schema:schemas.clear, value:'beta'}),
        fails,
      ],
    };
    const created=await call('workflow_create',{definition:JSON.stringify(definition)});
    const checked=await call('workflow_validate',{workflow_id:created.workflow_id, revision:1});
    await call('workflow_publish',{
      workflow_id:created.workflow_id, expected_revision:1,
      approved_operations:checked.required_approvals, accept_target_risks:true,
    });
    const started=await call('workflow_run',{workflow_id:created.workflow_id, inputs:{blob}});
    await run(started.run_id);
    const result=await call('workflow_result',{run_id:started.run_id});
    assert.equal(result.status, 'indeterminate');
    assert.notEqual(result.status, 'succeeded');
    assert.equal(result.compensation.acid_rollback, false);
    assert.equal(result.compensation.steps.find((item:{step_id:string})=>item.step_id==='beta').status, 'uncleared');
    assert.equal(result.compensation.steps.find((item:{step_id:string})=>item.step_id==='alpha').status, 'succeeded');
    assert.deepEqual(calls.filter(item=>item.tool==='note_clear').map(item=>item.value), ['alpha']);
  }finally{
    await client.close();
  }
});

test('replay does not repeat compensation or report a rollback', async t=>{
  const {sqlite, call, run, client, transport, calls}=harness(t);
  const schemas=await toolSchemas();
  await client.connect(transport);
  try{
    const definition={
      version:1, name:'Replay', saga:{on:['failure']},
      steps:[
        portalStep('alpha', schemas.note, 'alpha', [], {schema:schemas.clear, value:'alpha'}),
        portalStep('beta', schemas.note, 'beta', ['alpha'], {schema:schemas.clear, value:'beta'}),
        {...fails, needs:['beta']},
      ],
    };
    const created=await call('workflow_create',{definition:JSON.stringify(definition)});
    const checked=await call('workflow_validate',{workflow_id:created.workflow_id, revision:1});
    await call('workflow_publish',{
      workflow_id:created.workflow_id, expected_revision:1,
      approved_operations:checked.required_approvals, accept_target_risks:true,
    });
    const started=await call('workflow_run',{workflow_id:created.workflow_id, inputs:{blob}});
    await run(started.run_id);
    const first=calls.filter(item=>item.tool==='note_clear').map(item=>item.value);
    assert.deepEqual(first, ['beta','alpha']);
    sqlite.prepare("DELETE FROM run_steps WHERE run_id=? AND step_id='saga:compensation'").run(started.run_id);
    sqlite.prepare("UPDATE runs SET outcome='running' WHERE id=?").run(started.run_id);
    await run(started.run_id);
    assert.deepEqual(calls.filter(item=>item.tool==='note_clear').map(item=>item.value), first);
    const result=await call('workflow_result',{run_id:started.run_id});
    assert.equal(result.status, 'failed');
    assert.equal(result.compensation.acid_rollback, false);
  }finally{
    await client.close();
  }
});

test('a revoked compensation grant is not used and stays uncleared', async t=>{
  const {call, run, client, transport, calls}=harness(t);
  const schemas=await toolSchemas();
  await client.connect(transport);
  try{
    const definition={
      version:1, name:'Revoked', saga:{on:['failure']},
      steps:[
        portalStep('alpha', schemas.note, 'alpha', [], {schema:schemas.clear, value:'alpha'}),
        {...fails, needs:['alpha']},
      ],
    };
    const created=await call('workflow_create',{definition:JSON.stringify(definition)});
    const checked=await call('workflow_validate',{workflow_id:created.workflow_id, revision:1});
    const clear=checked.required_approvals.find((item:{tool:string})=>item.tool==='note_clear');
    const published=await call('workflow_publish',{
      workflow_id:created.workflow_id, expected_revision:1,
      approved_operations:checked.required_approvals, accept_target_risks:true,
    });
    await call('workflow_revoke',{
      workflow_id:created.workflow_id, published_version_id:published.published_version_id, operation:clear,
    });
    const started=await call('workflow_run',{workflow_id:created.workflow_id, inputs:{blob}});
    await run(started.run_id);
    const result=await call('workflow_result',{run_id:started.run_id});
    assert.equal(result.status, 'failed');
    assert.equal(result.compensation.acid_rollback, false);
    assert.deepEqual(result.compensation.steps, [{step_id:'alpha', status:'uncleared', error_code:'grant_revoked'}]);
    assert.equal(calls.some(item=>item.tool==='note_clear'), false);
    assert.equal(calls.filter(item=>item.tool==='note').length, 1);
  }finally{
    await client.close();
  }
});

test('cancel compensates only when cancel was published', async t=>{
  const {call, run, client, transport, calls, arm}=harness(t);
  const schemas=await toolSchemas();
  await client.connect(transport);
  try{
    async function admit(on: Array<'failure'|'cancel'>){
      const definition={
        version:1, name:'Cancel '+on.join('-'), saga:{on},
        steps:[
          portalStep('alpha', schemas.note, 'alpha', [], {schema:schemas.clear, value:'alpha'}),
          portalStep('beta', schemas.note, 'beta', ['alpha'], {schema:schemas.clear, value:'beta'}),
          {id:'later', needs:['beta'], uses:'result.emit', with:{data:'kept'}},
        ],
      };
      const created=await call('workflow_create',{definition:JSON.stringify(definition)});
      const checked=await call('workflow_validate',{workflow_id:created.workflow_id, revision:1});
      await call('workflow_publish',{
        workflow_id:created.workflow_id, expected_revision:1,
        approved_operations:checked.required_approvals, accept_target_risks:true,
      });
      return call('workflow_run',{workflow_id:created.workflow_id, inputs:{}});
    }
    const cancelled=await admit(['cancel']);
    const before=calls.filter(item=>item.tool==='note_clear').length;
    arm(cancelled.run_id);
    await run(cancelled.run_id);
    const status=await call('workflow_status',{run_id:cancelled.run_id});
    assert.equal(status.cancellation, 'requested');
    assert.equal(status.compensation.acid_rollback, false);
    assert.equal(status.compensation.trigger, 'cancel');
    assert.deepEqual(status.compensation.steps.map((item:{step_id:string;status:string})=>[item.step_id,item.status]), [
      ['beta','succeeded'], ['alpha','succeeded'],
    ]);
    assert.equal(calls.filter(item=>item.tool==='note_clear').length, before+2);
    assert.equal(status.steps.find((item:{step_id:string})=>item.step_id==='later').status, 'waiting');

    const failureOnly=await admit(['failure']);
    const clears=calls.filter(item=>item.tool==='note_clear').length;
    arm(failureOnly.run_id);
    await run(failureOnly.run_id);
    const held=await call('workflow_status',{run_id:failureOnly.run_id});
    assert.equal(held.cancellation, 'requested');
    assert.equal('compensation' in held, false);
    assert.equal(calls.filter(item=>item.tool==='note_clear').length, clears);
  }finally{
    await client.close();
  }
});

test('workflow_cancel lets published cancel compensation finish before terminate', async t=>{
  const {call, run, client, transport, calls, sqlite, enableTerminate, terminates, holdNotes, releaseNotes}=harness(t);
  const schemas=await toolSchemas();
  await client.connect(transport);
  enableTerminate();
  try{
    const definition={
      version:1, name:'Public cancel', saga:{on:['cancel']},
      steps:[
        portalStep('alpha', schemas.note, 'alpha', [], {schema:schemas.clear, value:'alpha'}),
        {id:'later', needs:['alpha'], uses:'result.emit', with:{data:'kept'}},
      ],
    };
    const created=await call('workflow_create',{definition:JSON.stringify(definition)});
    const checked=await call('workflow_validate',{workflow_id:created.workflow_id, revision:1});
    await call('workflow_publish',{
      workflow_id:created.workflow_id, expected_revision:1,
      approved_operations:checked.required_approvals, accept_target_risks:true,
    });
    holdNotes();
    const started=await call('workflow_run',{workflow_id:created.workflow_id, inputs:{}});
    const execution=run(started.run_id);
    const finished=execution.then(()=>undefined, ()=>undefined);
    t.after(async()=>{releaseNotes();await finished;});
    for(let attempt=0;attempt<50 && !calls.some(item=>item.tool==='note');attempt++)
      await new Promise(resolve=>setTimeout(resolve, 10));
    assert.equal(calls.some(item=>item.tool==='note'), true);
    const requested=await call('workflow_cancel',{run_id:started.run_id});
    assert.equal(requested.cancellation, 'requested');
    assert.notEqual(requested.status, 'cancelled');
    assert.equal(terminates(), 0);
    assert.equal(calls.some(item=>item.tool==='note_clear'), false);
    releaseNotes();
    await finished;
    assert.equal(terminates(), 0);
    assert.deepEqual(calls.filter(item=>item.tool==='note_clear').map(item=>item.value), ['alpha']);
    const status=await call('workflow_status',{run_id:started.run_id});
    assert.equal(terminates(), 1);
    assert.equal(status.compensation.acid_rollback, false);
    assert.equal(status.compensation.trigger, 'cancel');
    assert.deepEqual(status.compensation.steps.map((item:{step_id:string;status:string})=>[item.step_id,item.status]), [
      ['alpha','succeeded'],
    ]);
  }finally{
    await client.close();
  }
});

test('an unanswered cancel saga terminates as indeterminate after the grace', async t=>{
  const {call, client, transport, calls, sqlite, enableTerminate, terminates}=harness(t);
  const schemas=await toolSchemas();
  await client.connect(transport);
  enableTerminate();
  try{
    async function publish(on: Array<'failure'|'cancel'>){
      const definition={
        version:1, name:'Grace '+on.join('-'), saga:{on},
        steps:[portalStep('alpha', schemas.note, 'alpha', [], {schema:schemas.clear, value:'alpha'})],
      };
      const created=await call('workflow_create',{definition:JSON.stringify(definition)});
      const checked=await call('workflow_validate',{workflow_id:created.workflow_id, revision:1});
      await call('workflow_publish',{
        workflow_id:created.workflow_id, expected_revision:1,
        approved_operations:checked.required_approvals, accept_target_risks:true,
      });
      return call('workflow_run',{workflow_id:created.workflow_id, inputs:{}});
    }
    const waiting=await publish(['cancel']);
    const requested=await call('workflow_cancel',{run_id:waiting.run_id});
    assert.equal(requested.cancellation, 'requested');
    assert.equal(terminates(), 0);
    sqlite.prepare('UPDATE runs SET cancel_requested_at=? WHERE id=?').run(Date.now()-CANCEL_SAGA_GRACE_MS-1, waiting.run_id);
    const expired=await call('workflow_status',{run_id:waiting.run_id});
    assert.equal(terminates(), 1);
    assert.equal(expired.cancellation, 'indeterminate');
    assert.equal(expired.status, 'indeterminate');
    assert.notEqual(expired.status, 'cancelled');
    const stored=sqlite.prepare('SELECT outcome,error_code FROM runs WHERE id=?').get(waiting.run_id) as {outcome:string;error_code:string};
    assert.equal(stored.outcome, 'indeterminate');
    assert.equal(stored.error_code, 'cancel_unconfirmed');
    assert.equal(calls.some(item=>item.tool==='note_clear'), false);

    const failureOnly=await publish(['failure']);
    const stopped=await call('workflow_cancel',{run_id:failureOnly.run_id});
    assert.equal(terminates(), 2);
    assert.equal(stopped.cancellation, 'cancelled');
    assert.equal(stopped.status, 'cancelled');
    assert.equal('compensation' in stopped, false);
  }finally{
    await client.close();
  }
});

test('success and a write without compensate do not send a compensation call', async t=>{
  const {call, run, client, transport, calls}=harness(t);
  const schemas=await toolSchemas();
  await client.connect(transport);
  try{
    const plain={
      version:1, name:'Plain', steps:[
        portalStep('alpha', schemas.note, 'alpha'),
        {...fails, needs:['alpha']},
      ],
    };
    const plainDraft=await call('workflow_create',{definition:JSON.stringify(plain)});
    const plainChecked=await call('workflow_validate',{workflow_id:plainDraft.workflow_id, revision:1});
    assert.equal('saga' in plainChecked, false);
    await call('workflow_publish',{
      workflow_id:plainDraft.workflow_id, expected_revision:1,
      approved_operations:plainChecked.required_approvals, accept_target_risks:true,
    });
    const plainRun=await call('workflow_run',{workflow_id:plainDraft.workflow_id, inputs:{blob}});
    await run(plainRun.run_id);
    assert.equal((await call('workflow_result',{run_id:plainRun.run_id})).status, 'failed');
    assert.equal(calls.some(item=>item.tool==='note_clear'), false);

    const happy={
      version:1, name:'Happy', saga:{on:['failure','cancel']},
      steps:[portalStep('alpha', schemas.note, 'alpha', [], {schema:schemas.clear, value:'alpha'})],
    };
    const happyDraft=await call('workflow_create',{definition:JSON.stringify(happy)});
    const happyChecked=await call('workflow_validate',{workflow_id:happyDraft.workflow_id, revision:1});
    await call('workflow_publish',{
      workflow_id:happyDraft.workflow_id, expected_revision:1,
      approved_operations:happyChecked.required_approvals, accept_target_risks:true,
    });
    const happyRun=await call('workflow_run',{workflow_id:happyDraft.workflow_id, inputs:{}});
    await run(happyRun.run_id);
    const result=await call('workflow_result',{run_id:happyRun.run_id});
    assert.equal(result.status, 'succeeded');
    assert.equal('compensation' in result, false);
    assert.equal(calls.some(item=>item.tool==='note_clear'), false);
  }finally{
    await client.close();
  }
});
