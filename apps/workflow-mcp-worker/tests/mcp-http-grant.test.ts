import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toolSchemaDigest } from '../src/plan.ts';
import { TRUSTED_PORTAL_ENDPOINT } from '../src/mcp-public-fetch.ts';
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
const FIXTURE='https://fixture.lirtual.dpdns.org/echo';
const FIXTURE_ID='echo';
const HTTP_SCHEMA={type:'object',properties:{value:{type:'string'}},additionalProperties:false};
const HTTP_DIGEST=await toolSchemaDigest(HTTP_SCHEMA);
const PORTAL_ID='test-only-service-token-id';
const PORTAL_SECRET='test-only-service-token-secret';
const OWNER='https://owner.example.org/mcp';
const TOKEN='disposable-portal-token-mcp-http-grant';
const MIGRATIONS=['0001_s1.sql','0002_native_complete_seen.sql','0003_s3_attempt_claim.sql','0004_s3_callback_receipts.sql','0005_github_workflow_check.sql','0006_github_registered_action.sql','0007_run_cancel.sql','0008_grant_revocation.sql','0009_child_run.sql'];

type Flags={hint:'false'|'true'|'missing'; drift:boolean; http:'echo'|'redirect'|'throw'};

function harness(t: test.TestContext, flags: Flags){
  const sqlite=new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  for(const name of MIGRATIONS) sqlite.exec(readFileSync(new URL('../migrations/'+name, import.meta.url), 'utf8'));
  function prepare(sql:string){
    let args: any[]=[];
    return {
      bind(...values: any[]){args=values;return this;},
      async first(){return sqlite.prepare(sql).get(...args)??null;},
      async all(){return {results:sqlite.prepare(sql).all(...args)};},
      async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}}},
    };
  }
  const env={
    MCP_ACCESS_TOKEN:TOKEN,
    MCP_PORTAL_CLIENT_ID:PORTAL_ID,
    MCP_PORTAL_CLIENT_SECRET:PORTAL_SECRET,
    MCP_PORTAL_ENDPOINT:TRUSTED,
    HTTP_FIXTURE_ID:FIXTURE_ID,
    HTTP_FIXTURE_URL:FIXTURE,
    HTTP_FIXTURE_SCHEMA_DIGEST:HTTP_DIGEST,
    DB:{prepare, async batch(items:{run:()=>Promise<unknown>}[]){return Promise.all(items.map(item=>item.run()));}},
    WORKFLOW:{async create(){}, async get(){return {async status(){return {status:'running'};}}}},
  } as unknown as Env;
  let noteCalls=0;
  let httpCalls=0;
  const seenUrls: string[]=[];
  const previous=globalThis.fetch;
  globalThis.fetch=(async(input: RequestInfo|URL, init?: RequestInit)=>{
    const request=new Request(input, init);
    seenUrls.push(request.url);
    const body=request.method==='POST' ? await request.clone().text() : '';
    assert.equal(body.includes(PORTAL_SECRET), false);
    assert.equal(body.includes(PORTAL_ID), false);
    if(request.url===TRUSTED){
      assert.equal(request.headers.get('cf-access-client-secret'), PORTAL_SECRET);
      if(request.method==='POST'){
        const rpc=JSON.parse(body) as {method?: string};
        if(rpc.method==='tools/call') noteCalls++;
      }
      const response=await noteWorker.fetch(request);
      if(request.method!=='POST' || flags.hint==='false' && !flags.drift) return response;
      const rpc=JSON.parse(body) as {method?: string};
      if(rpc.method!=='tools/list' || !response.ok) return response;
      const raw=await response.text();
      const payload=response.headers.get('content-type')?.includes('text/event-stream')
        ? raw.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n')
        : raw;
      const listed=JSON.parse(payload) as {result:{tools:Array<{annotations?:{readOnlyHint?:boolean}; inputSchema?:{properties?:Record<string, {maxLength?:number}>}}>}};
      const tool=listed.result.tools[0];
      if(!tool) return Response.json(listed);
      if(flags.hint==='missing') delete tool.annotations;
      if(flags.hint==='true') tool.annotations={readOnlyHint:true};
      if(flags.drift && tool.inputSchema?.properties?.value) tool.inputSchema.properties.value.maxLength=1;
      return Response.json(listed);
    }
    if(request.url===FIXTURE){
      httpCalls++;
      assert.equal(request.method, 'POST');
      assert.equal(request.redirect, 'manual');
      assert.equal(request.headers.get('authorization'), null);
      assert.equal(request.headers.get('cf-access-client-secret'), null);
      if(flags.http==='redirect') return new Response(null,{status:302, headers:{location:'https://evil.example/taken'}});
      if(flags.http==='throw') throw new Error('socket lost');
      return Response.json({echo:JSON.parse(body)});
    }
    throw new Error('unexpected_target');
  }) as typeof fetch;
  t.after(()=>{globalThis.fetch=previous;});
  async function call(name: string, args: Record<string, unknown>, error?: string){
    const output=await client.callTool({name, arguments:args});
    const first=output.content[0];
    if(!first || first.type!=='text') throw new Error('unexpected_tool_content');
    assert.equal(first.text.includes(PORTAL_SECRET), false, name);
    assert.equal(first.text.includes(PORTAL_ID), false, name);
    assert.equal(first.text.includes('hidden-secret-value'), false, name);
    const value=JSON.parse(first.text);
    if(error){
      assert.equal(output.isError, true, name);
      assert.equal(value.error, error);
    }else assert.notEqual(output.isError, true, name+' '+first.text);
    return value;
  }
  const client=new Client({name:'mcp-http-grant', version:'0.1.0'});
  const transport=new StreamableHTTPClientTransport(new URL(OWNER),{
    requestInit:{headers:{authorization:'Bearer '+TOKEN}},
    fetch:(async(input: RequestInfo|URL, init?: RequestInit)=>ownerWorker.fetch(new Request(input, init), env)) as typeof fetch,
  });
  async function run(runId: string){
    await new WorkflowRunner({} as ExecutionContext, env).run({payload:{run_id:runId}} as WorkflowEvent<{run_id:string}>,{
      do:async(_name: unknown, _options: unknown, fn: ()=>Promise<unknown>)=>fn(),
    } as unknown as WorkflowStep);
  }
  return {env, sqlite, call, run, client, transport, seenUrls, counts:()=>({noteCalls, httpCalls})};
}

async function noteSchema(){
  const client=new Client({name:'note-schema', version:'0.1.0'});
  const transport=new StreamableHTTPClientTransport(new URL(TRUSTED),{
    fetch:((input: RequestInfo|URL, init?: RequestInit)=>noteWorker.fetch(new Request(input, init))) as typeof fetch,
  });
  await client.connect(transport);
  try{
    const listed=await client.listTools();
    const tool=listed.tools.find(item=>item.name==='note');
    if(!tool) throw new Error('note_missing');
    return JSON.parse(JSON.stringify(tool.inputSchema));
  }finally{
    await client.close();
  }
}

test('discovery and validate show the exact MCP write and restricted HTTP fixture', async t=>{
  const {env, call, client, transport}=harness(t,{hint:'false', drift:false, http:'echo'});
  await client.connect(transport);
  try{
    const overview=await call('workflow_capabilities',{});
    assert.equal(overview.connections.mcp_portal.endpoint, TRUSTED);
    assert.deepEqual(overview.connections.mcp_portal.scopes, ['read','write']);
    assert.equal(overview.connections.http_fixture.status, 'configured');
    assert.equal(overview.connections.http_fixture.fixture, FIXTURE_ID);
    assert.equal(overview.connections.http_fixture.endpoint, FIXTURE);
    assert.equal(overview.connections.http_fixture.scope, 'read');
    assert.equal(overview.connections.http_fixture.method, 'POST');
    assert.equal(overview.connections.http_fixture.schema_digest, HTTP_DIGEST);
    const write=await call('workflow_capabilities',{id:'action.mcp.write'});
    const http=await call('workflow_capabilities',{id:'action.http'});
    assert.equal(write.scope, 'write');
    assert.equal(write.uses, 'mcp.call');
    assert.match(write.permissions, /readOnlyHint/);
    assert.match(write.permissions, /accept_target_risks/);
    assert.equal(http.scope, 'read');
    assert.equal(http.uses, 'http.request');
    assert.equal(http.with_keys.includes('url'), false);
    assert.deepEqual(http.example.steps[0].with.input_schema, HTTP_SCHEMA);
    const approvedWrite=await call('workflow_validate',{definition:JSON.stringify(write.example)});
    assert.equal(approvedWrite.valid, true);
    assert.equal(approvedWrite.required_approvals[0].scope, 'write');
    assert.equal(approvedWrite.required_approvals[0].tool, 'note');
    const approvedHttp=await call('workflow_validate',{definition:JSON.stringify(http.example)});
    assert.equal(approvedHttp.valid, true);
    assert.deepEqual(approvedHttp.required_approvals[0], {
      endpoint:FIXTURE, fixture:FIXTURE_ID, schema_digest:HTTP_DIGEST, scope:'read',
    });
    const arbitrary=await call('workflow_validate',{definition:JSON.stringify({
      version:1, name:'Proxy', steps:[{id:'a', uses:'http.request', with:{fixture:FIXTURE_ID, scope:'read', input_schema:HTTP_SCHEMA, arguments:{url:'https://evil.example/take', value:'x'}}}],
    })});
    assert.equal(arbitrary.valid, false);
    assert.equal(arbitrary.issues[0].code, 'target_argument_rejected');
    env.HTTP_FIXTURE_URL='https://user:hidden-secret-value@fixture.lirtual.dpdns.org/echo';
    const hidden=await call('workflow_capabilities',{});
    assert.equal(hidden.connections.http_fixture.status, 'unavailable');
    assert.equal(JSON.stringify(hidden).includes('hidden-secret-value'), false);
    const refused=await call('workflow_publish',{
      workflow_id:'00000000-0000-4000-8000-000000000099', expected_revision:1,
      approved_operations:[approvedHttp.required_approvals[0]], accept_target_risks:true,
    }, 'workflow_not_found');
    assert.equal(JSON.stringify(refused).includes('hidden-secret-value'), false);
  }finally{
    await client.close();
  }
});

test('one approved MCP write and one restricted HTTP fixture complete, then revocation blocks reuse', async t=>{
  const flags: Flags={hint:'false', drift:false, http:'echo'};
  const {env, sqlite, call, run, client, transport, seenUrls, counts}=harness(t, flags);
  const schema=await noteSchema();
  const digest=await toolSchemaDigest(schema);
  await client.connect(transport);
  try{
    const instructions=client.getInstructions()??'';
    assert.match(instructions, /workflow_revoke/);
    assert.match(instructions, /saga are unsupported/);
    assert.match(instructions, /does not publish/i);
    const writeDefinition={version:1, name:'Approved note', inputs:{message:'x'}, steps:[{
      id:'save', uses:'mcp.call', with:{
        endpoint:TRUSTED, tool:'note', scope:'write', input_schema:schema,
        arguments:{value:{ref:'inputs.message'}},
      },
    }]};
    const created=await call('workflow_create',{definition:JSON.stringify(writeDefinition)});
    const preview=await call('workflow_validate',{workflow_id:created.workflow_id, revision:1});
    const grant=preview.required_approvals[0];
    assert.deepEqual(grant, {endpoint:TRUSTED, tool:'note', scope:'write', schema_digest:digest});
    const base={workflow_id:created.workflow_id, expected_revision:1};
    await call('workflow_publish',{...base, approved_operations:[grant]}, 'target_risk_acknowledgment_required');
    await call('workflow_publish',{...base, approved_operations:[{...grant, endpoint:'https://evil.example/mcp'}], accept_target_risks:true}, 'external_approval_required');
    const evil=await call('workflow_create',{definition:JSON.stringify({
      ...writeDefinition, name:'Evil target', steps:[{...writeDefinition.steps[0], with:{...writeDefinition.steps[0].with, endpoint:'https://evil.example/mcp'}}],
    })});
    const evilPreview=await call('workflow_validate',{workflow_id:evil.workflow_id, revision:1});
    await call('workflow_publish',{
      workflow_id:evil.workflow_id, expected_revision:1,
      approved_operations:evilPreview.required_approvals, accept_target_risks:true,
    }, 'portal_target_not_authorized');
    const published=await call('workflow_publish',{...base, approved_operations:[grant], accept_target_risks:true});
    const plan=JSON.parse((sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?').get(published.published_version_id) as {plan:string}).plan);
    assert.deepEqual(plan.mcp_approvals, [grant]);
    assert.equal(plan.mcp_target_risks_accepted, true);
    const before=counts().noteCalls;
    const started=await call('workflow_run',{workflow_id:created.workflow_id, inputs:{message:'https://evil.example/not-the-server'}});
    await run(started.run_id);
    const outcome=await call('workflow_result',{run_id:started.run_id});
    assert.equal(outcome.status, 'succeeded');
    assert.equal(outcome.result.content[0].text, 'stored:https://evil.example/not-the-server');
    assert.equal(counts().noteCalls, before+1);
    assert.equal(seenUrls.every(url=>url===TRUSTED || url===FIXTURE), true);

    sqlite.prepare("UPDATE runs SET outcome='running' WHERE id=?").run(started.run_id);
    await run(started.run_id);
    assert.equal(counts().noteCalls, before+1);
    assert.equal((await call('workflow_result',{run_id:started.run_id})).status, 'succeeded');
    await call('workflow_revoke',{workflow_id:created.workflow_id, published_version_id:published.published_version_id, operation:grant});
    sqlite.prepare("UPDATE runs SET outcome='running' WHERE id=?").run(started.run_id);
    await run(started.run_id);
    const replay=await call('workflow_result',{run_id:started.run_id});
    assert.equal(replay.status, 'succeeded');
    assert.equal(replay.result.content[0].text, 'stored:https://evil.example/not-the-server');
    assert.equal(JSON.stringify(replay).includes('rollback'), false);
    assert.equal(counts().noteCalls, before+1);
    const blocked=await call('workflow_run',{workflow_id:created.workflow_id, inputs:{message:'after revoke'}});
    await run(blocked.run_id);
    const denied=await call('workflow_result',{run_id:blocked.run_id});
    assert.equal(denied.status, 'failed');
    assert.equal(denied.steps[0].error_code, 'grant_revoked');
    assert.equal(counts().noteCalls, before+1);

    const leaked=await call('workflow_run',{workflow_id:created.workflow_id, inputs:{message:PORTAL_SECRET}});
    await run(leaked.run_id);
    const hidden=await call('workflow_result',{run_id:leaked.run_id});
    assert.equal(hidden.status, 'failed');
    assert.equal(hidden.steps[0].error_code, 'target_argument_rejected');
    assert.equal(JSON.stringify(hidden).includes(PORTAL_SECRET), false);
    assert.equal(counts().noteCalls, before+1);

    const httpDefinition={version:1, name:'Fixture', inputs:{value:'ok'}, steps:[{
      id:'echo', uses:'http.request', with:{fixture:FIXTURE_ID, scope:'read', input_schema:HTTP_SCHEMA, arguments:{value:{ref:'inputs.value'}}},
    }]};
    const httpDraft=await call('workflow_create',{definition:JSON.stringify(httpDefinition)});
    const httpPreview=await call('workflow_validate',{workflow_id:httpDraft.workflow_id, revision:1});
    const httpGrant=httpPreview.required_approvals[0];
    assert.equal(httpGrant.endpoint, FIXTURE);
    await call('workflow_publish',{
      workflow_id:httpDraft.workflow_id, expected_revision:1, approved_operations:[httpGrant],
    }, 'target_risk_acknowledgment_required');
    const httpPublished=await call('workflow_publish',{
      workflow_id:httpDraft.workflow_id, expected_revision:1, approved_operations:[httpGrant], accept_target_risks:true,
    });
    const httpBefore=counts().httpCalls;
    const httpRun=await call('workflow_run',{workflow_id:httpDraft.workflow_id, inputs:{value:'https://evil.example/still-not-the-url'}});
    await run(httpRun.run_id);
    const httpOutcome=await call('workflow_result',{run_id:httpRun.run_id});
    assert.equal(httpOutcome.status, 'succeeded');
    assert.deepEqual(httpOutcome.result.echo, {value:'https://evil.example/still-not-the-url'});
    assert.equal(counts().httpCalls, httpBefore+1);
    assert.equal(seenUrls.includes('https://evil.example/still-not-the-url'), false);
    env.HTTP_FIXTURE_SCHEMA_DIGEST='0'.repeat(64);
    const driftedRun=await call('workflow_run',{workflow_id:httpDraft.workflow_id, inputs:{value:'schema'}});
    await run(driftedRun.run_id);
    const driftedOutcome=await call('workflow_result',{run_id:driftedRun.run_id});
    assert.equal(driftedOutcome.status, 'failed');
    assert.equal(driftedOutcome.steps[0].error_code, 'approved_schema_changed');
    assert.equal(counts().httpCalls, httpBefore+1);
    env.HTTP_FIXTURE_SCHEMA_DIGEST=HTTP_DIGEST;

    flags.http='redirect';
    const redirected=await call('workflow_run',{workflow_id:httpDraft.workflow_id, inputs:{value:'redirected'}});
    await run(redirected.run_id);
    const redirectOutcome=await call('workflow_result',{run_id:redirected.run_id});
    assert.equal(redirectOutcome.status, 'indeterminate');
    assert.equal(redirectOutcome.steps[0].error_code, 'http_redirect_denied');
    assert.equal(redirectOutcome.error_code, 'http_redirect_denied');
    assert.equal(JSON.stringify(redirectOutcome).includes('rollback'), false);
    assert.equal(counts().httpCalls, httpBefore+2);
    assert.equal(seenUrls.every(url=>url===TRUSTED || url===FIXTURE), true);
    sqlite.prepare("UPDATE runs SET outcome='running' WHERE id=?").run(redirected.run_id);
    await run(redirected.run_id);
    const redirectReplay=await call('workflow_result',{run_id:redirected.run_id});
    assert.equal(redirectReplay.status, 'indeterminate');
    assert.equal(redirectReplay.error_code, 'http_redirect_denied');
    assert.equal(counts().httpCalls, httpBefore+2);

    flags.http='throw';
    const lost=await call('workflow_run',{workflow_id:httpDraft.workflow_id, inputs:{value:'lost'}});
    await run(lost.run_id);
    const lostOutcome=await call('workflow_result',{run_id:lost.run_id});
    assert.equal(lostOutcome.status, 'indeterminate');
    assert.equal(lostOutcome.error_code, 'external_outcome_unknown');
    assert.equal(JSON.stringify(lostOutcome).includes('rollback'), false);
    await call('workflow_revoke',{workflow_id:httpDraft.workflow_id, published_version_id:httpPublished.published_version_id, operation:httpGrant});
    sqlite.prepare("UPDATE runs SET outcome='running' WHERE id=?").run(lost.run_id);
    await run(lost.run_id);
    const lostReplay=await call('workflow_result',{run_id:lost.run_id});
    assert.equal(lostReplay.status, 'indeterminate');
    assert.notEqual(lostReplay.error_code, 'grant_revoked');
    assert.equal(JSON.stringify(lostReplay).includes('rollback'), false);
    const callsAfterLost=counts().httpCalls;
    const after=await call('workflow_run',{workflow_id:httpDraft.workflow_id, inputs:{value:'blocked'}});
    await run(after.run_id);
    const blockedHttp=await call('workflow_result',{run_id:after.run_id});
    assert.equal(blockedHttp.status, 'failed');
    assert.equal(blockedHttp.steps[0].error_code, 'grant_revoked');
    assert.equal(counts().httpCalls, callsAfterLost);

    const other=await call('workflow_create',{definition:JSON.stringify({
      ...httpDefinition, name:'Other fixture', steps:[{...httpDefinition.steps[0], with:{...httpDefinition.steps[0].with, fixture:'other'}}],
    })});
    const otherPreview=await call('workflow_validate',{workflow_id:other.workflow_id, revision:1});
    await call('workflow_publish',{
      workflow_id:other.workflow_id, expected_revision:1,
      approved_operations:otherPreview.required_approvals, accept_target_risks:true,
    }, 'http_target_not_authorized');
    env.HTTP_FIXTURE_SCHEMA_DIGEST='0'.repeat(64);
    const drifted=await call('workflow_validate',{definition:JSON.stringify(httpDefinition)});
    assert.equal(drifted.valid, false);
    assert.equal(drifted.issues[0].code, 'approved_schema_changed');
  }finally{
    await client.close();
  }
});

test('MCP write fails closed on an untrusted readOnlyHint or a changed schema before tools/call', async t=>{
  const schema=await noteSchema();
  const digest=await toolSchemaDigest(schema);
  async function publishAndRun(flags: Flags){
    const {call, run, client, transport, counts}=harness(t, flags);
    await client.connect(transport);
    try{
      const definition={version:1, name:'Hint', steps:[{
        id:'save', uses:'mcp.call', with:{endpoint:TRUSTED, tool:'note', scope:'write', input_schema:schema, arguments:{value:'no'}},
      }]};
      const created=await call('workflow_create',{definition:JSON.stringify(definition)});
      const preview=await call('workflow_validate',{workflow_id:created.workflow_id, revision:1});
      assert.equal(preview.required_approvals[0].schema_digest, digest);
      const published=await call('workflow_publish',{
        workflow_id:created.workflow_id, expected_revision:1,
        approved_operations:preview.required_approvals, accept_target_risks:true,
      });
      assert.ok(published.published_version_id);
      const started=await call('workflow_run',{workflow_id:created.workflow_id, inputs:{}});
      const before=counts().noteCalls;
      await run(started.run_id);
      const outcome=await call('workflow_result',{run_id:started.run_id});
      return {outcome, calls:counts().noteCalls-before};
    }finally{
      await client.close();
    }
  }
  const missing=await publishAndRun({hint:'missing', drift:false, http:'echo'});
  assert.equal(missing.outcome.status, 'failed');
  assert.equal(missing.outcome.steps[0].error_code, 'readonly_hint_untrusted');
  assert.equal(missing.calls, 0);
  const claimed=await publishAndRun({hint:'true', drift:false, http:'echo'});
  assert.equal(claimed.outcome.steps[0].error_code, 'readonly_hint_untrusted');
  assert.equal(claimed.calls, 0);
  const drifted=await publishAndRun({hint:'false', drift:true, http:'echo'});
  assert.equal(drifted.outcome.status, 'failed');
  assert.equal(drifted.outcome.steps[0].error_code, 'tool_schema_drift');
  assert.equal(drifted.calls, 0);
});
