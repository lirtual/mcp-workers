import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toolSchemaDigest } from '../src/plan.ts';
import {cloudflareActionManifest,canonical} from '../src/cloudflare-action-contract.ts';
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
    url:'data:text/javascript,export class WorkflowEntrypoint { constructor(ctx,env){this.env=env;} }; export class WorkerEntrypoint { constructor(ctx,env){this.env=env;} }',
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
  for(const name of ['0001_s1.sql','0014_workflow_deletion.sql','0016_portal_connection_revocation.sql','0017_http_connection_auth.sql','0002_native_complete_seen.sql','0011_awaited_child_capacity.sql',
     '0013_cloudflare_action_invocations.sql','0018_cloudflare_action_migration_fence.sql'])
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
    WORKFLOW_MCP_PORTAL_CLIENT_ID:PORTAL_ID,
    WORKFLOW_MCP_PORTAL_CLIENT_SECRET:PORTAL_SECRET,
    WORKFLOW_MCP_PORTAL_ENDPOINT:TRUSTED,
    DB:{prepare,async batch(items:{run:()=>Promise<unknown>}[]){return Promise.all(items.map(s=>s.run()));}},
    WORKFLOW:{async create(){},async get(){return {async status(){return {status:'running'};}};}},
  } as unknown as Env;
  let internetCalls=0,toolCalls=0;
  let portalListing:'reviewed'|'read_duplicate'|'write_drift'|'write_only'='reviewed';
  const previousFetch=globalThis.fetch;
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    internetCalls++;
    assert.equal(request.url,TRUSTED);
    assert.equal(request.redirect,'manual');
    assert.equal(request.headers.get('authorization'),null,'incoming Portal token must not leak');
    assert.equal(request.headers.get('cf-access-client-id'),PORTAL_ID);
    assert.equal(request.headers.get('cf-access-client-secret'),PORTAL_SECRET);
    let rpc:{method:string;id?:string|number}|undefined;
    if(request.method==='POST'){
      rpc=await request.clone().json() as {method:string;id?:string|number};
      if(rpc.method==='tools/call')toolCalls++;
    }
    if(rpc?.method!=='tools/list')return readonlyWorker.fetch(request);
    // Model a real MCP tools/list from the approved Portal using the same
    // transport and auth seam; no tools/call is ever made by discovery.
    const body:{jsonrpc:string;id:string|number|undefined;result:{tools:any[]}}={
      jsonrpc:'2.0',id:rpc.id,result:{tools:[{name:'echo',inputSchema:INPUT_SCHEMA,
        annotations:{readOnlyHint:true,destructiveHint:false}}]},
    };
    const read={name:'ima_list_notebooks',
      inputSchema:{type:'object',properties:{limit:{type:'integer'}},required:[]},
      annotations:{readOnlyHint:true,destructiveHint:false}};
    const write={name:'ima_create_note',
      inputSchema:{type:'object',properties:{content:{type:'string',minLength:1}},required:['content']},
      annotations:{readOnlyHint:false,destructiveHint:false}};
    const untrusted={name:'admin_delete_everything',inputSchema:{type:'object',
      properties:{}},annotations:{readOnlyHint:true,destructiveHint:false}};
    if(body.result?.tools){
      body.result.tools.push(...(portalListing==='write_only'?[]:[read]),
        ...(portalListing==='read_duplicate'?[structuredClone(read)]:[]),
        portalListing==='write_drift'?{...write,inputSchema:{
          ...write.inputSchema,properties:{content:{type:'string'}}}}:write,
        untrusted);
    }
    return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
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
    assert.equal(listed.tools.length,17,'#860 removes public Capabilities');
    assert.equal(listed.tools.some(x=>x.name==='workflow_capabilities'),false);
    assert.equal(listed.tools.some(x=>x.name==='workflow_approval'),false);
    const publisher=listed.tools.find(x=>x.name==='workflow_publish')!;
    const publishSchema=(publisher.inputSchema as any).properties;
    for(const retired of ['approved_actions','approved_cloudflare_actions',
      'approved_children','approve_cloudflare_execution','approve_heavy_execution'])
      assert.equal(Object.hasOwn(publishSchema,retired),false,retired);
    assert.ok(publishSchema.approved_operations,'external MCP targets keep independent grants');

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
    const definition={version:1,name:'Trusted owner-scoped test',inputs:{message:'draft-only-private-literal'},steps:[{
      id:'lookup',uses:'mcp.call',with:{
        endpoint:TRUSTED,tool:'echo',scope:'read',input_schema:INPUT_SCHEMA,
        arguments:{value:{ref:'inputs.message'}},
      },
    }]};
    // The public authenticated MCP seam validates without creating a Draft,
    // publishing a grant, dispatching a GitHub job or mutating D1.
    const countBefore=(sqlite.prepare('SELECT count(*) AS n FROM workflows').get() as {n:number}).n;
    const actions=await call('workflow_action_list',{});
    assert.deepEqual(actions.actions,[]);
    assert.equal(internetCalls,0,'ordinary Action discovery never contacts Portal');
    const portal=await call('workflow_action_list',{source:'portal'});
    assert.equal(portal.source,'portal_mcp');
    assert.equal(portal.read.availability,'verified_contract');
    assert.equal(portal.write.availability,'verified_contract');
    assert.deepEqual(portal.read.tools.map((x:any)=>x.tool),['ima_list_notebooks']);
    assert.deepEqual(portal.write.tools.map((x:any)=>x.tool),['ima_create_note']);
    for(const scoped of [...portal.read.tools,...portal.write.tools]){
      assert.equal(scoped.endpoint,TRUSTED);
      assert.match(scoped.schema_digest,/^[a-f0-9]{64}$/);
      assert.equal(scoped.availability,'discovered_not_executed');
    }
    assert.equal(JSON.stringify(portal).includes(PORTAL_SECRET),false);
    assert.equal(JSON.stringify(portal).includes('admin_delete_everything'),false);
    portalListing='write_only';
    const onlyWrite=await call('workflow_action_list',{source:'portal'});
    assert.equal(onlyWrite.read.availability,'not_authorized');
    assert.equal(onlyWrite.write.availability,'verified_contract');
    portalListing='read_duplicate';
    const duplicate=await call('workflow_action_list',{source:'portal'});
    assert.equal(duplicate.read.availability,'not_authorized');
    assert.equal(duplicate.write.availability,'verified_contract');
    portalListing='write_drift';
    const drifted=await call('workflow_action_list',{source:'portal'});
    assert.equal(drifted.read.availability,'verified_contract');
    assert.equal(drifted.write.availability,'not_authorized');
    portalListing='reviewed';
    assert.equal(toolCalls,0,'discovery must not execute Portal tools');
    const beforeRevocation=internetCalls;
    await call('workflow_connection_revoke',{});
    const revokedCatalog=await call('workflow_action_list',{source:'portal'});
    assert.equal(revokedCatalog.availability,'revoked');
    assert.equal(revokedCatalog.read.availability,'revoked');
    assert.equal(revokedCatalog.write.availability,'revoked');
    assert.equal(internetCalls,beforeRevocation,'revoked discovery cannot contact Portal');
    await call('workflow_connection_enable',{});
    assert.equal((sqlite.prepare('SELECT count(*) AS n FROM workflows').get() as {n:number}).n,countBefore);
    const portalDiscoveryCalls=internetCalls;
    const inline=await call('workflow_validate',{definition:JSON.stringify(definition)});
    assert.equal(inline.valid,true);
    assert.deepEqual(inline.required_approvals,[{
      endpoint:TRUSTED,tool:'echo',scope:'read',schema_digest:DIGEST,
    }]);
    const inlineRejected=await call('workflow_validate',{definition:JSON.stringify({
      version:1,name:'Invalid',steps:[{id:'run',uses:'shell',with:{}}],
    })});
    assert.equal(inlineRejected.valid,false);
    assert.equal(inlineRejected.issues[0].code,'unsupported_capability');
    assert.equal(inlineRejected.issues[0].path,'/steps/0/uses');
    const mixed=await call('workflow_validate',{
      workflow_id:'00000000-0000-4000-8000-000000000001',
      revision:1,definition:JSON.stringify(definition),
    });
    assert.equal(mixed.valid,false);
    assert.equal(mixed.issues[0].code,'invalid_validate_target');
    assert.equal((sqlite.prepare('SELECT count(*) AS n FROM workflows').get() as {n:number}).n,countBefore);
    assert.equal(internetCalls,portalDiscoveryCalls);
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
    assert.equal(internetCalls,portalDiscoveryCalls);

    const published=await call('workflow_publish',{...base,approved_operations:[grant],accept_target_risks:true});
    const plan=JSON.parse((sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?')
      .get(published.published_version_id) as {plan:string}).plan);
    assert.equal(plan.mcp_target_risks_accepted,true);
    assert.deepEqual(plan.mcp_approvals,[grant]);
    const publishedView=await call('workflow_get',{workflow_id:created.workflow_id});
    assert.equal(publishedView.published_run_interface.published_version_id,published.published_version_id);
    assert.equal(publishedView.published_run_interface.inputs.message.type,'not_declared');
    assert.equal(publishedView.published_run_interface.inputs.message.default,'not_declared');
    assert.equal(JSON.stringify(publishedView.published_run_interface).includes('draft-only-private-literal'),false);
    const draftOnly=structuredClone(definition);
    draftOnly.name='New unpublished draft';
    draftOnly.inputs.message='different-UNPUBLISHED-sensitive-value';
    await call('workflow_update',{workflow_id:created.workflow_id,
      expected_revision:1,definition:JSON.stringify(draftOnly)});
    const stillPublished=await call('workflow_get',{workflow_id:created.workflow_id});
    assert.equal(stillPublished.draft_revision,2);
    assert.equal(stillPublished.published_run_interface.published_version_id,
      published.published_version_id);
    assert.equal(JSON.stringify(stillPublished.published_run_interface)
      .includes('different-UNPUBLISHED-sensitive-value'),false);
    const badVersion='11111111-1111-4111-8111-111111111111';
    await call('workflow_run',{workflow_id:created.workflow_id,inputs:{message:'no dispatch'},
      expected_published_version_id:badVersion},'published_version_changed');
    assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM runs').get() as {n:number}).n,0);

    const run=await call('workflow_run',{
      workflow_id:created.workflow_id,inputs:{message:'approved trusted echo'},
      idempotency_key:'trusted-owner-e2e-'+created.workflow_id,
      expected_published_version_id:published.published_version_id,
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
    const next=await call('workflow_publish',{workflow_id:created.workflow_id,
      expected_revision:2,approved_operations:[grant],accept_target_risks:true});
    assert.notEqual(next.published_version_id,published.published_version_id);
    await call('workflow_run',{workflow_id:created.workflow_id,
      inputs:{message:'stale checked version'},idempotency_key:'stale-checked',
      expected_published_version_id:published.published_version_id},
      'published_version_changed');
    assert.equal(toolCalls,1,'stale version cannot call Portal');
    assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM runs').get() as {n:number}).n,1);
    const newer=await call('workflow_get',{workflow_id:created.workflow_id});
    assert.equal(newer.published_run_interface.published_version_id,next.published_version_id);

    // An environment pointing to any unapproved Portal must not execute
    // an approved Plan or leak the production Portal credentials.
    env.WORKFLOW_MCP_PORTAL_ENDPOINT='https://untrusted.example.org/mcp';
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
    env.WORKFLOW_MCP_PORTAL_ENDPOINT=TRUSTED;

    // A missing outbound Portal secret must fail without sending any requests.
    env.WORKFLOW_MCP_PORTAL_CLIENT_SECRET=undefined;
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
    env.WORKFLOW_MCP_PORTAL_CLIENT_SECRET=PORTAL_SECRET;

    // A generic public approval shape is only an input envelope, not a grant.
    // Publish must match the already-reviewed Provider manifest and live binding.
    const bark=await cloudflareActionManifest('bark');
    const deployment='44444444-4444-4444-8444-444444444444';
    let barkSends=0;
    env.ACTIONS_DEPLOYMENT_ID=deployment;
    env.ACTIONS={
      getContract:async(_action_id:string)=>({deployment_id:deployment,contract_digest:bark.contract_digest}),
      execute:async()=>{barkSends++;throw Error('must_not_send');},
    } as any;
    const barkDefinition={version:1,name:'Reviewed Bark publish boundary',steps:[
      {id:'source',uses:'result.emit',with:{data:{id:42}}},
      {id:'notify',uses:'action.run',needs:['source'],with:{
        executor:'cloudflare',provider:'bark',action:'bark.send_notification',
        contract_digest:bark.contract_digest,
        input:{notification:{body:{ref:'steps.source.output'},title:'Done'}},
      }},
    ]};
    const checked=await call('workflow_validate',{definition:JSON.stringify(barkDefinition)});
    assert.equal(checked.valid,true);
    const draft=await call('workflow_create',{definition:JSON.stringify(barkDefinition)});
    const target={workflow_id:draft.workflow_id,expected_revision:1};
    const barkGrant={executor:'cloudflare',provider:'bark',action:'bark.send_notification',
      contract_digest:bark.contract_digest,deployment_id:deployment};
    // Caller cannot invent or widen Action grants by submitting the retired fields.
    const forged=await client.callTool({name:'workflow_publish',arguments:{
      ...target,approve_cloudflare_execution:true,approved_cloudflare_actions:[barkGrant],
    }});
    assert.equal(forged.isError,true,'retired manual-grant parameters are rejected');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_versions').get()?.n,2);
    const barkPublished=await call('workflow_publish',target);
    const frozen=JSON.parse((sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?')
      .get(barkPublished.published_version_id) as {plan:string}).plan);
    assert.deepEqual(frozen.cloudflare_action_approvals,[barkGrant]);
    assert.equal(barkSends,0,'Publish must never send a notification');


    // Spec #775: actual public MCP -> Action list -> Validate -> Publish -> Run
    // -> Result with a NEW Cloudflare JSON Action, no Consumer-specific branch.
    const jsonManifest={
      executor:'cloudflare',provider:'json',action:'json.report',version:1,
      source_repository:'lirtual/cloudflare-actions',service:'cloudflare-actions',
      entrypoint:'ActionsEntrypoint',side_effect:'none',
      input_schema:{type:'object',additionalProperties:false,
        required:['message'],properties:{message:{type:'string',maxLength:100}}},
      output_schema:{type:'object',additionalProperties:false,
        required:['status','report_id'],properties:{
          status:{enum:['accepted','rejected','unknown']},report_id:{type:'string',maxLength:64}}},
    };
    const jsonHash=await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(JSON.stringify(canonical(jsonManifest))));
    const jsonDigest=Array.from(new Uint8Array(jsonHash),b=>b.toString(16).padStart(2,'0')).join('');
    const jsonDeployment='55555555-5555-4555-8555-555555555555';
    let jsonCalls=0;
    env.ACTIONS={
      listActions:async()=>[{action_id:'json.report'}],
      getContract:async()=>({manifest:jsonManifest,contract_digest:jsonDigest,
        deployment_id:jsonDeployment}),
      execute:async(action_id:string,invocation:any)=>{
        assert.equal(action_id,'json.report');
        assert.equal(invocation.message,'report-body');
        assert.equal(invocation.deployment_id,jsonDeployment);
        jsonCalls++;
        return {status:'accepted',input_digest:invocation.input_digest,report_id:'report-42'};
      },
    } as any;
    const catalog=await call('workflow_action_list',{});
    assert.deepEqual(catalog.actions.map((action:any)=>action.action_id),['json.report']);
    const jsonDefinition={version:1,name:'new-json-action',steps:[
      {id:'report',uses:'action.run',with:{action_id:'json.report',
        input:{message:{ref:'inputs.message'}}}},
      {id:'emit',uses:'result.emit',needs:['report'],
        with:{data:{ref:'steps.report.output.report_id'}}},
    ]};
    const validated=await call('workflow_validate',{definition:JSON.stringify(jsonDefinition)});
    assert.equal(validated.valid,true,JSON.stringify(validated));
    const jsonDraft=await call('workflow_create',{definition:JSON.stringify(jsonDefinition)});
    const jsonPublished=await call('workflow_publish',{
      workflow_id:jsonDraft.workflow_id,expected_revision:1,
    });
    const bound=JSON.parse((sqlite.prepare('SELECT plan FROM workflow_versions WHERE id=?')
      .get(jsonPublished.published_version_id) as {plan:string}).plan);
    assert.equal(bound.cloudflare_action_approvals[0].contract_digest,jsonDigest);
    assert.equal(jsonCalls,0,'Publish never invokes Provider effects');
    const jsonRun=await call('workflow_run',{workflow_id:jsonDraft.workflow_id,
      inputs:{message:'report-body'}});
    await new WorkflowOrchestrator({} as ExecutionContext,env).run({
      payload:{run_id:jsonRun.run_id},
    } as WorkflowEvent<{run_id:string}>, {
      do:async(_name:unknown,_options:unknown,fn:()=>Promise<unknown>)=>fn(),
    } as unknown as WorkflowStep);
    const jsonResult=await call('workflow_result',{run_id:jsonRun.run_id});
    assert.equal(jsonResult.status,'succeeded',JSON.stringify(jsonResult));
    assert.equal(jsonResult.result,'report-42');
    assert.equal(jsonCalls,1);
    assert.equal((sqlite.prepare('SELECT count(*) AS n FROM cloudflare_action_invocations WHERE run_id=?')
      .get(jsonRun.run_id) as {n:number}).n,1);

    // A reviewed Provider may describe a new write Action, but cannot grant
    // itself permission to perform that write through the public Publish API.
    const privilegedManifest={...jsonManifest,action:'json.privileged',
      side_effect:'alter_production_database',auto_grant_reviewed:true};
    const privilegedHash=await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(JSON.stringify(canonical(privilegedManifest))));
    const privilegedDigest=Array.from(new Uint8Array(privilegedHash),
      b=>b.toString(16).padStart(2,'0')).join('');
    let privilegedCalls=0;
    env.ACTIONS={
      listActions:async()=>[{action_id:'json.privileged'}],
      getContract:async()=>({manifest:privilegedManifest,contract_digest:privilegedDigest,
        deployment_id:jsonDeployment}),
      execute:async()=>{privilegedCalls++;throw Error('must_not_execute');},
    } as any;
    const privilegedDefinition=JSON.stringify({version:1,name:'privileged',steps:[
      {id:'privileged',uses:'action.run',with:{action_id:'json.privileged',
        input:{message:'never execute'}}},
    ]});
    const privilegedValidation=await call('workflow_validate',{definition:privilegedDefinition});
    assert.equal(privilegedValidation.valid,true);
    const privilegedDraft=await call('workflow_create',{definition:privilegedDefinition});
    const denied=await client.callTool({name:'workflow_publish',arguments:{
      workflow_id:privilegedDraft.workflow_id,expected_revision:1,
    }});
    assert.equal(denied.isError,true,'new write effects cannot auto-authorize');
    const denialText=denied.content?.find(item=>item.type==='text');
    assert.match(denialText?.text??'',/cloudflare_action_explicit_authorization_required/);
    assert.equal(privilegedCalls,0);
    assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_versions WHERE workflow_id=?')
      .get(privilegedDraft.workflow_id) as {n:number}).n,0);

  }finally{
    await client.close();
  }
});
