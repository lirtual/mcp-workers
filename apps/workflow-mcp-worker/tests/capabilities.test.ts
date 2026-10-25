import test from 'node:test';
import assert from 'node:assert/strict';
import {compilePlan,PlanError,SUPPORTED_STEP_USES,PLAN_LIMITS} from '../src/plan.ts';
import {workflowCapabilities,WORKFLOW_DEFINITION_SCHEMA,reviewedPortalTools,WORKFLOW_ACTION_WITH_SCHEMAS} from '../src/capabilities.ts';
import {PRODUCTION_PORTAL_ENDPOINT} from '../src/mcp-public-fetch.ts';

const env={GITHUB_ACTION_APPROVED_REPOSITORIES:undefined,WORKFLOW_GITHUB_DISPATCH_TOKEN:undefined,
  MCP_PORTAL_ENDPOINT:undefined,MCP_PORTAL_CLIENT_ID:undefined,MCP_PORTAL_CLIENT_SECRET:undefined};
const portalEnv={...env,MCP_PORTAL_ENDPOINT:PRODUCTION_PORTAL_ENDPOINT,
  MCP_PORTAL_CLIENT_ID:'test-only-id',MCP_PORTAL_CLIENT_SECRET:'test-only-secret'};

test('overview matches the compiler, exposes only truthful ingress and needs no D1',async()=>{
  const overview=await workflowCapabilities(env);
  assert.deepEqual(overview.definition_schema,WORKFLOW_DEFINITION_SCHEMA);
  assert.deepEqual(WORKFLOW_DEFINITION_SCHEMA.properties.steps.items.properties.uses.enum,
    [...SUPPORTED_STEP_USES]);
  assert.deepEqual(overview.limits,PLAN_LIMITS);
  const catalog=new Map((overview.capability_ids as Array<{id:string;availability:string}>).map(x=>[x.id,x]));
  assert.equal(catalog.get('trigger.manual')?.availability,'supported');
  for(const id of ['trigger.cron','trigger.webhook','trigger.github_event',
    'flow.loop','flow.child','flow.saga']){
    assert.equal(catalog.get(id)?.availability,'unsupported',id);
  }
  assert.equal(catalog.get('action.github.run')?.availability,'unavailable');
  assert.equal(catalog.get('action.mcp.call')?.availability,'unavailable');
  assert.equal(JSON.stringify(overview).includes('test-only-secret'),false);
  assert.equal((overview.tools as Record<string,string>).validate,'workflow_validate');
});

test('every advertised compiler example really compiles and has a matching digest',async()=>{
  for(const id of ['trigger.manual','action.result.emit','action.mcp.call',
    'flow.static_dag','flow.condition']){
    const result=await workflowCapabilities(id==='action.mcp.call'?portalEnv:env,id,
      async()=>({availability:'verified_contract',tools:[{
        tool:'ima_list_notebooks',endpoint:PRODUCTION_PORTAL_ENDPOINT,scope:'read',
        input_schema:{type:'object',properties:{limit:{type:'number'}}},
        schema_digest:'a'.repeat(64),arguments:{limit:1},availability:'discovered_not_executed',
      }]}));
    assert.equal(result.availability==='unknown',false,id);
    if(!('example' in result)||!result.example)throw Error('missing example:'+id);
    const {definition,digest,validation}=result.example as {
      definition:unknown;digest:string;validation:string;
    };
    assert.equal(validation,'compiler_valid_only');
    assert.equal((await compilePlan(definition)).digest,digest);
  }
});

test('only source-reviewed Portal tools with bounded actual schemas are returned',async()=>{
  const valid={name:'ima_list_notebooks',inputSchema:{type:'object',
    properties:{limit:{type:'number'},cursor:{type:'string'}}},
    annotations:{readOnlyHint:true,destructiveHint:false}};
  const result=await reviewedPortalTools([
    valid,
    {...valid,name:'arbitrary_but_readonly'},
    {...valid,name:'ima_create_note'},
  ]);
  for(const unsafe of [
    {...valid,annotations:{readOnlyHint:false}},
    {...valid,inputSchema:{type:'object',properties:{command:{type:'string'}}}},
    {...valid,inputSchema:{type:'object',properties:{limit:{type:'string'}}}},
  ]) assert.deepEqual(await reviewedPortalTools([unsafe]),[]);
  assert.equal(result.length,1);
  assert.deepEqual(await reviewedPortalTools([valid,valid]),[]);
  assert.equal(result[0].tool,'ima_list_notebooks');
  assert.match(result[0].schema_digest,/^[0-9a-f]{64}$/);
  assert.equal(result[0].availability,'discovered_not_executed');
});
test('Agent-readable Action schemas document required executable parameters',()=>{
  assert.deepEqual(WORKFLOW_ACTION_WITH_SCHEMAS['mcp.call'].required,
    ['endpoint','tool','scope','arguments','input_schema']);
  assert.deepEqual(WORKFLOW_ACTION_WITH_SCHEMAS['github.run'].required,
    ['capability','action']);
});

test('unsupported features are rejected by the same production compiler',async()=>{
  for(const forbidden of [
    {version:1,name:'Cron',triggers:[{id:'timer',type:'cron',expression:'* * * * *'}],
      steps:[{id:'one',uses:'result.emit',with:{data:'no'}}]},
    {version:1,name:'Loop',steps:[{id:'one',uses:'result.emit',
      repeat:{times:3},with:{data:'no'}}]},
    {version:1,name:'Child',steps:[{id:'one',uses:'workflow.call',with:{workflow_id:'none'}}]},
  ]){
    await assert.rejects(compilePlan(forbidden),PlanError);
  }
});

test('GitHub detail reuses existing allowlist and does not need token for empty list',async()=>{
  const detail=await workflowCapabilities(env,'action.github.run');
  assert.deepEqual(detail.discovered_actions,[]);
  assert.equal(detail.availability,'unavailable');
  assert.equal((await workflowCapabilities(env,'action.mcp.call')).availability,'unavailable');
  const unknown=await workflowCapabilities(env,'legacy.tsrv');
  assert.equal(unknown.availability,'unknown');
});
