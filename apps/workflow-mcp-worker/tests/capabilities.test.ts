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
  assert.equal(catalog.get('trigger.cron')?.availability,'supported');
  assert.equal(catalog.get('trigger.webhook')?.availability,'supported');
  assert.equal(catalog.get('trigger.github_event')?.availability,'unavailable');
  for(const id of ['flow.loop','flow.saga']){
    assert.equal(catalog.get(id)?.availability,'unsupported',id);
  }
  assert.equal(catalog.get('flow.child')?.availability,'supported_with_grant');
  assert.equal(catalog.get('flow.wait')?.availability,'supported');
  const wait=(await workflowCapabilities(env,'flow.wait')) as {example:{definition:unknown;digest:string};wait_policy:{native_checkpoint:string;total_budget_seconds:number}};
  assert.equal(wait.wait_policy.native_checkpoint,'step.sleep');
  assert.equal(wait.wait_policy.total_budget_seconds,PLAN_LIMITS.maxWaitSeconds);
  assert.equal((await compilePlan(wait.example.definition)).digest,wait.example.digest);
  assert.equal((overview.expression_rules as {supported_wait:string}).supported_wait.includes('flow: wait'),true);
  const childDetails=await workflowCapabilities(env,'flow.child');
  assert.equal(childDetails.availability,'supported_with_grant');
  assert.match(String(childDetails.description),/approved_children/);
  assert.match(String(childDetails.description),/non-recursive/);
  const rules=overview.expression_rules as {supported_child:string;unsupported:string[]};
  assert.match(rules.supported_child,/flow: child/);
  assert.match(rules.supported_child,/approved_children/);
  assert.equal(rules.unsupported.includes('child_workflow'),false);
  const childGrant=childDetails.grant as {required:string[];note:string};
  assert.deepEqual(childGrant.required,['approved_children']);
  assert.match(childGrant.note,/illustrative/);
  const example=childDetails.example as {definition:unknown;digest:string;validation:string};
  assert.equal(example.validation,'compiler_valid_only');
  assert.equal((await compilePlan(example.definition)).digest,example.digest);
  assert.equal(catalog.get('flow.branch_join')?.availability,'supported');
  assert.equal(catalog.get('flow.repeat')?.availability,'supported');
  assert.equal(catalog.get('flow.foreach_emit')?.availability,'supported');
  assert.equal(catalog.get('flow.foreach_multi_emit')?.availability,'supported');
  assert.equal(catalog.get('flow.foreach_mcp_read')?.availability,'unavailable');
   assert.equal(catalog.get('flow.foreach_multi_mcp_read')?.availability,'unavailable');
  assert.equal(catalog.get('flow.foreach_github_task')?.availability,'unavailable');
   assert.equal(catalog.get('flow.foreach_emit_task_emit')?.availability,'unavailable');
  assert.equal(PLAN_LIMITS.maxRepeat,8);
  assert.equal(catalog.get('action.github.run')?.availability,'unavailable');
  assert.equal(catalog.get('action.mcp.call')?.availability,'unavailable');
  assert.equal(JSON.stringify(overview).includes('test-only-secret'),false);
  assert.equal((overview.tools as Record<string,string>).validate,'workflow_validate');
});

test('every advertised compiler example really compiles and has a matching digest',async()=>{
  for(const id of ['trigger.manual','trigger.cron','trigger.webhook','trigger.github_event','action.result.emit','action.mcp.call',
    'flow.static_dag','flow.condition','flow.branch_join','flow.repeat','flow.child','flow.wait','flow.foreach_emit','flow.foreach_multi_emit','flow.foreach_mcp_read','flow.foreach_multi_mcp_read']){
    const result=await workflowCapabilities(['action.mcp.call','flow.foreach_mcp_read','flow.foreach_multi_mcp_read'].includes(id)?portalEnv:env,id,
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
test('advertised skip-tolerant join matches compiler and keeps fail-closed semantics',async()=>{
  const field=WORKFLOW_DEFINITION_SCHEMA.properties.steps.items.properties.needs_policy;
  assert.deepEqual(field.enum,['all_succeeded','allow_skipped']);
  const detail=await workflowCapabilities(env,'flow.branch_join');
  assert.equal(detail.availability,'supported');
  const sample=(detail.example as {definition:{steps:Array<{needs_policy?:string}>}}).definition;
  assert.equal(sample.steps.find(s=>s.needs_policy==='allow_skipped')?.needs_policy,'allow_skipped');
  const rules=(await workflowCapabilities(env)).expression_rules as {needs_policy:string};
  assert.match(rules.needs_policy,/failed or indeterminate/);
  assert.match(rules.needs_policy,/at least one succeeded/);
});

test('literal repeat discovery is compiler-backed and explicitly bounded',async()=>{
  const schema=WORKFLOW_DEFINITION_SCHEMA.properties.steps.items;
  assert.deepEqual(schema.oneOf.map(x=>x.required),[
    ['uses','with'],['flow','times','template'],
    ['flow','duration_seconds'],['flow','workflow_id','version_id','inputs'],
    ['flow','items','max_items','template'],
  ]);
  assert.equal(schema.properties.times.maximum,PLAN_LIMITS.maxRepeat);
  assert.equal(schema.properties.duration_seconds.maximum,PLAN_LIMITS.maxWaitSeconds);
  assert.equal(schema.properties.max_items.maximum,PLAN_LIMITS.maxForeachItems);
  assert.ok(schema.oneOf[0].not.anyOf.some(x=>x.required.includes('flow')));
  assert.ok(schema.oneOf[1].not.anyOf.some(x=>x.required.includes('uses')));
  const detail=await workflowCapabilities(env,'flow.repeat');
  assert.equal(detail.availability,'supported');
  const example=detail.example as {definition:unknown;digest:string};
  const compiled=await compilePlan(example.definition);
  assert.equal(compiled.plan.steps.length,3);
  assert.equal(compiled.digest,example.digest);
});

test('dynamic foreach discovery exposes narrow result-only native snapshot contract',async()=>{
  const detail=await workflowCapabilities(env,'flow.foreach_emit');
  assert.equal(detail.availability,'supported');
  const sample=detail.example as {definition:unknown;digest:string};
  assert.equal((await compilePlan(sample.definition)).digest,sample.digest);
  assert.equal((await compilePlan(sample.definition)).plan.steps.length,2);
  assert.equal((detail.template_policy as {allowed_action:string}).allowed_action,'result.emit');
  assert.equal(PLAN_LIMITS.maxForeachItems,8);
});

test('read-only dynamic foreach discovery uses the exact compiler and Portal grant',async()=>{
  const detail=await workflowCapabilities(portalEnv,'flow.foreach_mcp_read',
    async()=>({availability:'verified_contract',tools:[{
      tool:'ima_list_notebooks',endpoint:PRODUCTION_PORTAL_ENDPOINT,scope:'read',
      input_schema:{type:'object',properties:{limit:{type:'number'}}},
      schema_digest:'a'.repeat(64),arguments:{limit:1},availability:'discovered_not_executed',
    }]}));
  assert.equal(detail.availability,'verified_contract');
  const {definition,digest}=detail.example as {definition:unknown;digest:string};
  const {plan,digest:compiled}=await compilePlan(definition);
  assert.equal(compiled,digest);
  assert.equal(plan.steps[0].uses,'flow.foreach');
  assert.equal((detail.template_policy as {scope:string}).scope,'read');
  assert.deepEqual((detail.template_policy as {unsupported:string[]}).unsupported,
    ['github.run','nested templates','write-scope tools']);
});

test('multi-step read-only MCP capability is compiler-backed and requires exact grant',async()=>{
 const detail=await workflowCapabilities(portalEnv,'flow.foreach_multi_mcp_read',
  async()=>({availability:'verified_contract',tools:[{
   tool:'ima_list_notebooks',endpoint:PRODUCTION_PORTAL_ENDPOINT,scope:'read',
   input_schema:{type:'object',properties:{limit:{type:'number'}}},
   schema_digest:'a'.repeat(64),arguments:{limit:1},availability:'discovered_not_executed',
  }]}));
 assert.equal(detail.availability,'verified_contract');
 const example=detail.example as {definition:unknown;digest:string};
 const {plan,digest}=await compilePlan(example.definition);
 assert.equal(digest,example.digest);
 const children=plan.steps.find(x=>x.id==='each')?.with.templates as
  Array<{uses:string;with?:{schema_digest?:string}}>;
 assert.deepEqual(children.map(x=>x.uses),['result.emit','mcp.call']);
 assert.match(children[1]!.with?.schema_digest??'',/^[a-f0-9]{64}$/);
 assert.deepEqual((detail.template_policy as {allowed_actions:string[]}).allowed_actions,
  ['result.emit','mcp.call']);
 const schemas=WORKFLOW_DEFINITION_SCHEMA.properties.steps.items.properties.template.oneOf[1].properties.steps;
 assert.ok(schemas,'multi-step schema missing');
 assert.ok(schemas.allOf.some(x=>
  x.if.minItems===2&&x.then.anyOf[0]?.items?.properties.uses.enum?.includes('mcp.call')));
});

test('GitHub Task dynamic template schema and capability remain scoped',async()=>{
 const detail=await workflowCapabilities(env,'flow.foreach_github_task');
 assert.equal(detail.availability,'no_verified_published_task');
 assert.equal((detail.template_policy as {allowed_action:string}).allowed_action,'github.run');
 assert.ok((detail.template_policy as {inputs:string}).inputs.includes('item.value'));
 const schema=WORKFLOW_DEFINITION_SCHEMA.properties.steps.items.properties.template as
   {oneOf:Array<{properties?:{steps?:{items?:{
     properties?:{uses?:{enum?:string[]}},allOf?:Array<{if?:{properties?:{uses?:{const?:string}}}}>
   }}}}>};
 const items=schema.oneOf[1]?.properties?.steps?.items;
 assert.ok(items,'Foreach schema must have exactly one child template branch');
 assert.ok(items.properties?.uses?.enum?.includes('github.run'));
 assert.ok(items.allOf?.some(x=>x.if?.properties?.uses?.const==='github.run'));
});

test('Agent-readable Action schemas document required executable parameters',()=>{
  assert.deepEqual(WORKFLOW_ACTION_WITH_SCHEMAS['mcp.call'].required,
    ['endpoint','tool','scope','arguments','input_schema']);
  assert.deepEqual(WORKFLOW_ACTION_WITH_SCHEMAS['github.run'].required,
    ['capability','action']);
});

test('awaited-child capability distinguishes valid flow syntax from legacy unsupported fields',async()=>{
  const detail=await workflowCapabilities(env,'flow.child');
  const {definition}=detail.example as {definition:Record<string,unknown>};
  const compiled=await compilePlan(definition);
  assert.equal(compiled.plan.steps[0]?.uses,'flow.child');
  await assert.rejects(
    compilePlan({...definition,child_workflow:'legacy'}),
    (err:unknown)=>err instanceof PlanError && err.message.includes('unsupported_field:child_workflow'),
  );
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

test('multi-emit foreach discovery exposes only sequential pure Actions',async()=>{
  const detail=await workflowCapabilities(env,'flow.foreach_multi_emit');
  assert.equal(detail.availability,'supported');
  const example=detail.example as {definition:unknown;digest:string};
  const {plan,digest}=await compilePlan(example.definition);
  assert.equal(digest,example.digest);
  assert.equal((plan.steps.find(s=>s.id==='each')?.with.templates as unknown[]).length,2);
  const rules=detail.template_policy as {external_actions:string;max_steps:number};
  assert.equal(rules.external_actions,'unsupported');
  assert.equal(rules.max_steps,PLAN_LIMITS.maxForeachTemplateSteps);
  const schema=WORKFLOW_DEFINITION_SCHEMA.properties.steps.items.properties.template.oneOf[1].properties.steps;
  assert.ok(schema,'multi-foreach JSON Schema must be declared');
  assert.equal(schema.maxItems,4);
  assert.ok(schema.allOf.some(rule=>rule.if.minItems===2&&
    rule.then.anyOf[0]?.items?.properties.uses.enum?.includes('result.emit')));
});

test('staged Task Foreach self-description reflects only one literal approved Task',async()=>{
 const detail=await workflowCapabilities(env,'flow.foreach_emit_task_emit');
 assert.equal(detail.availability,'no_verified_published_task');
 const policy=detail.template_policy as {stages:string[];github_task_count:number;github_inputs:string};
 assert.deepEqual(policy.stages,['result.emit','github.run','result.emit']);
 assert.equal(policy.github_task_count,1);
 assert.equal(policy.github_inputs,'literal_only');
});

test('ordered mixed Task discovery enforces one literal Task and read-only MCP',async()=>{
 const detail=await workflowCapabilities(env,'flow.foreach_mixed_task');
 assert.equal(detail.availability,'no_verified_published_task');
 const rules=detail.template_policy as {
  github_task_count:number;github_inputs:string;mcp_scope:string;max_steps:number;
 };
 assert.equal(rules.github_task_count,1);
 assert.equal(rules.github_inputs,'literal_only');
 assert.equal(rules.mcp_scope,'read');
 assert.equal(rules.max_steps,PLAN_LIMITS.maxForeachTemplateSteps);
 const schema=WORKFLOW_DEFINITION_SCHEMA.properties.steps.items.properties.template.oneOf[1].properties.steps;
 assert.ok(schema);
 assert.ok(schema.allOf.some(rule=>rule.if.minItems===2&&
  rule.then.anyOf[1]?.maxContains===1));
});
