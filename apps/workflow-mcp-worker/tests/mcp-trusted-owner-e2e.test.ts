import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toolSchemaDigest } from '../src/plan.ts';
import { PRODUCTION_PORTAL_ENDPOINT } from '../src/mcp-public-fetch.ts';
import type { Env } from '../src/store.ts';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import readonlyWorker from './fixtures/readonly-worker.ts';

// Exercise the real Portal handler, owner MCP SDK protocol, D1 queries,
// published approval contract, Workflow runner, and the actual read-only MCP
// fixture, all in-process. The only stub is Cloudflare's orchestration shell;
// outbound trusted-target fetch is explicitly intercepted, not real Internet.
const hook=registerHooks({resolve(specifier,context,next){
  if(specifier==='cloudflare:workers')return {
    url:'data:text/javascript,export class WorkflowEntrypoint { constructor(ctx,env){this.env=env;} }',
    shortCircuit:true,
  };
  return next(specifier,context);
}});
const [{default:ownerWorker},{WorkflowOrchestrator}]=await Promise.all([
  import('../src/index.ts'),import('../src/runner.ts'),
]);
hook.deregister();

const TRUSTED=PRODUCTION_PORTAL_ENDPOINT;
const PORTAL_ID='test-only-service-token-id';
const PORTAL_SECRET='test-only-service-token-secret';
const OWNER='https://owner.example.org/mcp';
const TOKEN='disposable-portal-token-mcp-owner-e2e';
const INPUT_SCHEMA={type:'object',properties:{
  value:{type:'string',maxLength:4096},
  delay_ms:{type:'integer',minimum:0,maximum:15000},
},required:['value'],'$schema':'https://json-schema.org/draft/2020-12/schema',additionalProperties:false};
const DIGEST=await toolSchemaDigest(INPUT_SCHEMA);

test('Portal-authenticated MCP -> validate -> approve -> Publish -> Run -> Result',async t=>{
  const sqlite=new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  for(const name of ['0001_s1.sql','0002_native_complete_seen.sql'])
    sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  function prepare(sql:string){
    let args:any[]=[];
    return {
      bind(...values:any[]){args=values;return this;},
      async first(){return sqlite.prepare(sql).get(...args)??null;},
      async all(){return {results:sqlite.prepare(sql).all(...args)};},
      async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};},
    };
  }
  const env={
    MCP_ACCESS_TOKEN:TOKEN,
    MCP_PORTAL_CLIENT_ID:PORTAL_ID,
    MCP_PORTAL_CLIENT_SECRET:PORTAL_SECRET,
    MCP_PORTAL_ENDPOINT:TRUSTED,
    DB:{prepare,async batch(items:{run:()=>Promise<unknown>}[]){return Promise.all(items.map(s=>s.run()));}},
    WORKFLOW:{async create(){},async get(){return {async status(){return {status:'running'};}};}},
  } as unknown as Env;
  let internetCalls=0,toolCalls=0;
  const previousFetch=globalThis.fetch;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    internetCalls++;
    assert.equal(request.url,TRUSTED);
    assert.equal(request.redirect,'manual');
    assert.equal(request.headers.get('authorization'),null,'incoming Portal token must not leak');
    assert.equal(request.headers.get('cf-access-client-id'),PORTAL_ID);
    assert.equal(request.headers.get('cf-access-client-secret'),PORTAL_SECRET);
    if(request.method==='POST'){
      const rpc=await request.clone().json() as {method:string};
      if(rpc.method==='tools/call')toolCalls++;
    }
    return readonlyWorker.fetch(request);
  }) as typeof fetch;
  t.after(()=>{globalThis.fetch=previousFetch;});

  const unauthorized=await ownerWorker.fetch(new Request(OWNER,{
    method:'POST',headers:{authorization:'Bearer wrong-test-token'},
  }),env);
  assert.equal(unauthorized.status,401);
  const disallowedOrigin=await ownerWorker.fetch(new Request(OWNER,{
    method:'POST',headers:{authorization:'Bearer '+TOKEN,origin:'https://untrusted.example.org'},
  }),env);
  assert.equal(disallowedOrigin.status,403);
  assert.equal(internetCalls,0);

  const client=new Client({name:'trusted-mcp-owner-test',version:'0.1.0'});
  const transport=new StreamableHTTPClientTransport(new URL(OWNER),{
    requestInit:{headers:{authorization:'Bearer '+TOKEN}},
    fetch:(async(input:RequestInfo|URL,init?:RequestInit)=>
      ownerWorker.fetch(new Request(input,init),env)) as typeof fetch,
  });
  try{
    await client.connect(transport);
    const listed=await client.listTools();
    assert.ok(listed.tools.some(x=>x.name==='workflow_publish'));
    async function call(name:string,args:Record<string,unknown>,error?:string):Promise<any>{
      const output=await client.callTool({name,arguments:args});
      const first=output.content[0];
      if(!first || first.type!=='text')throw Error('unexpected_tool_content');
      const value=JSON.parse(first.text);
      if(error){
        assert.equal(output.isError,true,name+' must reject');
        assert.equal(value.error,error);
      }else assert.notEqual(output.isError,true,name+' '+JSON.stringify(value));
      return value;
    }
    const definition={version:1,name:'Trusted owner-scoped test',steps:[{
      id:'lookup',uses:'mcp.call',with:{
        endpoint:TRUSTED,tool:'echo',scope:'read',input_schema:INPUT_SCHEMA,
        arguments:{value:{ref:'inputs.message'}},
      },
    }]};
    const created=await call('workflow_create',{definition:JSON.stringify(definition)});
    const preview=await call('workflow_validate',{workflow_id:created.workflow_id,revision:1});
    const grant={endpoint:TRUSTED,tool:'echo',scope:'read',schema_digest:DIGEST};
    assert.equal(preview.valid,true);
    assert.deepEqual(preview.required_approvals,[grant]);

    const base={workflow_id:created.workflow_id,expected_revision:1};
    await call('workflow_publish',{...base,approved_operations:[grant]},'target_risk_acknowledgment_required');
    await call('workflow_publish',{...base,approved_operations:[{...grant,tool:'unreviewed'}],accept_target_risks:true},'external_approval_required');
    await call('workflow_publish',{...base,accept_target_risks:true},'external_approval_required');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_versions').get()?.n,0);
    assert.equal(internetCalls,0);

    const published=await call('workflow_publish',{...base,approved_operations:[grant],accept_target_risks:true});
    const plan=JSON.parse((sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?')
      .get(published.published_version_id) as {plan:string}).plan);
    assert.equal(plan.mcp_target_risks_accepted,true);
    assert.deepEqual(plan.mcp_approvals,[grant]);

    const run=await call('workflow_run',{
      workflow_id:created.workflow_id,inputs:{message:'approved trusted echo'},
      idempotency_key:'trusted-owner-e2e-'+created.workflow_id,
    });
    await new WorkflowOrchestrator({} as ExecutionContext,env).run({
      payload:{run_id:run.run_id},
    } as WorkflowEvent<{run_id:string}>, {
      do:async(_name:unknown,_options:unknown,fn:()=>Promise<unknown>)=>fn(),
    } as unknown as WorkflowStep);

    const outcome=await call('workflow_result',{run_id:run.run_id});
    assert.equal(outcome.status,'succeeded');
    assert.equal(outcome.steps[0].status,'succeeded');
    assert.equal(outcome.result.content[0].text,'approved trusted echo');
    assert.equal(toolCalls,1,'exactly one tools/call');

    // An environment pointing to any unapproved Portal must not execute
    // an approved Plan or leak the production Portal credentials.
    env.MCP_PORTAL_ENDPOINT='https://untrusted.example.org/mcp';
    const crossEnvironment=await call('workflow_run',{
      workflow_id:created.workflow_id,inputs:{message:'blocked wrong Portal'},
    });
    await new WorkflowOrchestrator({} as ExecutionContext,env).run({
      payload:{run_id:crossEnvironment.run_id},
    } as WorkflowEvent<{run_id:string}>,{
      do:async(_name:unknown,_options:unknown,fn:()=>Promise<unknown>)=>fn(),
    } as unknown as WorkflowStep);
    const wrongPortal=await call('workflow_result',{run_id:crossEnvironment.run_id});
    assert.equal(wrongPortal.status,'failed');
    assert.equal(wrongPortal.steps[0].status,'failed');
    assert.equal(toolCalls,1,'cross-environment Portal was not contacted');
    env.MCP_PORTAL_ENDPOINT=TRUSTED;

    // A missing outbound Portal secret must fail without sending any requests.
    env.MCP_PORTAL_CLIENT_SECRET=undefined;
    const noCredential=await call('workflow_run',{
      workflow_id:created.workflow_id,inputs:{message:'no portal identity'},
    });
    await new WorkflowOrchestrator({} as ExecutionContext,env).run({
      payload:{run_id:noCredential.run_id},
    } as WorkflowEvent<{run_id:string}>,{
      do:async(_name:unknown,_options:unknown,fn:()=>Promise<unknown>)=>fn(),
    } as unknown as WorkflowStep);
    const rejected=await call('workflow_result',{run_id:noCredential.run_id});
    assert.equal(rejected.status,'failed');
    assert.equal(rejected.steps[0].status,'failed');
    assert.equal(toolCalls,1,'missing portal credentials cannot reach target');
    env.MCP_PORTAL_CLIENT_SECRET=PORTAL_SECRET;

  }finally{
    await client.close();
  }
});
