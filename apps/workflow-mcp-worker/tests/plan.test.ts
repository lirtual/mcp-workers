import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePlan, evaluateExpression, evaluateArguments, evaluateCondition, canonicalJsonString, PlanError, toolSchemaDigest } from '../src/plan.ts';

const one = {
  version: 1, name: 'Inspect', steps: [
    { id: 'read', uses: 'result.emit', with: { data: { ref: 'inputs.subject' } } },
    { id: 'report', needs: ['read'], uses: 'result.emit',
      if: { eq: [{ ref: 'steps.read.status' }, 'succeeded'] },
      with: { data: { ref: 'steps.read.output' } } },
  ],
};

test('Workflow compiles deterministic DAG from JSON or YAML with matching digest', async () => {
  const json = await compilePlan(JSON.stringify(one));
  const yaml = await compilePlan(`version: 1
name: Inspect
steps:
  - id: read
    uses: result.emit
    with:
      data: {ref: inputs.subject}
  - id: report
    needs: [read]
    uses: result.emit
    if: {eq: [{ref: steps.read.status}, succeeded]}
    with:
      data: {ref: steps.read.output}
`);
  assert.equal(json.digest, yaml.digest);
  assert.equal(json.plan.steps.length, 2);
  assert.equal(json.plan.steps[1].needs[0], 'read');
  assert.deepEqual(evaluateArguments(json.plan.steps[0].with.data, {inputs: {subject:'hello'}, steps:{}}), 'hello');
  assert.equal(evaluateExpression(json.plan.steps[1].if, {inputs:{}, steps:{read:{status:'succeeded'}}}), true);
});

test('independent DAG Step order is canonical and locale-independent', async () => {
  const definition={version:1,name:'Ordering',steps:[
    {id:'a',uses:'result.emit',with:{data:'a'}},
    {id:'Z',uses:'result.emit',with:{data:'Z'}}
  ]};
  const compiled=await compilePlan(definition);
  assert.deepEqual(compiled.plan.steps.map(s=>s.id),['Z','a']);
  const reversed=await compilePlan({...definition,steps:[...definition.steps].reverse()});
  assert.equal(compiled.digest,reversed.digest);
});

test('Workflow readonly MCP arguments must be an object before Publish', async () => {
  for(const argumentsValue of [null,42,'not an object',['list']]) {
    const definition={version:1,name:'Invalid MCP args',steps:[
      {id:'read',uses:'mcp.call',with:{endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',input_schema:{type:'object',properties:{}},arguments:argumentsValue}}
    ]};
    await assert.rejects(()=>compilePlan(definition),PlanError);
  }
});

test('Workflow validation refuses arbitrary code, dynamic networks, missing refs and cycles', async () => {
  for (const definition of [
    {...one, steps:[{id:'x',uses:'shell.run',with:{command:'rm -rf /'}}]},
    {...one, steps:[{id:'x',uses:'mcp.call',with:{endpoint:'https://evil.test/mcp'}}]},
    {...one, steps:[{id:'x',uses:'result.emit',needs:['missing'],with:{data:1}}]},
    {...one, steps:[{id:'x',uses:'result.emit',needs:['y'],with:{data:1}},
                       {id:'y',uses:'result.emit',needs:['x'],with:{data:1}}]},
    {...one, steps:[{id:'x',uses:'result.emit',with:{data:{eval:'process.exit()'}}}]},
  ]) {
    await assert.rejects(() => compilePlan(definition), PlanError);
  }
});

test('Workflow rejects duplicate YAML keys, unknown executable fields and oversized DAG', async () => {
  await assert.rejects(() => compilePlan('version: 1\nversion: 2\nsteps: []'), PlanError);
  await assert.rejects(() => compilePlan({...one, javascript:'unsafe'}), PlanError);
  await assert.rejects(() => compilePlan({...one, steps:Array.from({length:33},(_,i)=>({id:'step'+i,uses:'result.emit',with:{data:i}}))}), PlanError);
});


test('Workflow canonical JSON uses locale-independent key ordering for version and Run hashes', () => {
  assert.equal(canonicalJsonString({a:1,B:2}),'{"B":2,"a":1}');
});

test('Workflow published Plan rejects non-finite YAML numbers rather than converting them to null', async () => {
  for (const scalar of ['.nan', '.inf', '-.inf']) {
    await assert.rejects(() => compilePlan(`version: 1\nname: Non-finite\nsteps:\n  - id: result\n    uses: result.emit\n    with:\n      data: ${scalar}\n`), PlanError);
  }
  await assert.rejects(() => compilePlan({version:1,name:'Input',inputs:{limit:Infinity},steps:[{id:'result',uses:'result.emit',with:{data:'ok'}}]}),PlanError);
});

test('Workflow conditions reject string truthiness and require boolean runtime values', async () => {
  await assert.rejects(()=>compilePlan({version:1,name:'Condition',steps:[{id:'emit',uses:'result.emit',if:'false',with:{data:'must not execute'}}]}),PlanError);
  assert.throws(()=>evaluateCondition({ref:'inputs.flag'},{inputs:{flag:'false'},steps:{}}),PlanError);
});

test('Workflow references cannot read inherited Object prototype values', async () => {
  const plan=await compilePlan({version:1,name:'Own input only',steps:[{id:'x',uses:'result.emit',with:{data:{ref:'inputs.toString'}}}]});
  assert.equal(evaluateArguments(plan.plan.steps[0].with.data,{inputs:{},steps:{}}),undefined);
});

test('Workflow rejects reserved Step names that could masquerade as completed dependencies', async () => {
  await assert.rejects(()=>compilePlan({version:1,name:'Reserved Step',steps:[
    {id:'constructor',uses:'result.emit',with:{data:'unsafe'}},
    {id:'result',needs:['constructor'],uses:'result.emit',with:{data:'downstream'}}
  ]}),PlanError);
});

test('Workflow refuses prototype traversal in expression references', async () => {
  await assert.rejects(() => compilePlan({...one, steps:[
    {id:'x', uses:'result.emit', with:{data:{ref:'inputs.constructor'}}},
  ]}), PlanError);
});

test('MCP public read-only MCP plans pin canonical endpoint, tool and scope',async()=>{
  const step={id:'lookup',uses:'mcp.call',with:{
    endpoint:'https://public.example.org/mcp',tool:'search',scope:'read',
    input_schema:{type:'object',properties:{query:{type:'string'}}},
    arguments:{url:'https://example.org/page',query:{ref:'inputs.query'}},
  }};
  const {plan}=await compilePlan({version:1,name:'MCP candidate',steps:[step]});
  assert.equal(plan.steps[0].uses,'mcp.call');
  assert.equal((plan.steps[0].with.arguments as Record<string,unknown>).url,'https://example.org/page');
  assert.deepEqual(evaluateArguments(plan.steps[0].with.arguments,{inputs:{query:'q'},steps:{}}),
    {url:'https://example.org/page',query:'q'});
});

test('MCP compiler blocks dynamic targets, writes, malformed target grants and executable control fields',async()=>{
  const base={id:'lookup',uses:'mcp.call',with:{
    endpoint:'https://public.example.org/mcp',tool:'search',scope:'read',
    input_schema:{type:'object',properties:{query:{type:'string'}}},
    arguments:{query:'q'},
  }};
  for(const bad of [
    {endpoint:{ref:'inputs.url'}},
    {endpoint:'http://public.example.org/mcp'},
    {endpoint:'https://127.0.0.1/mcp'},
    {endpoint:'https://public.example.org/mcp#fragment'},
    {scope:'write'},
    {scope:'read',command:'do-anything'},
    {tool:'unsafe tool name'},
    {arguments:null},
    {arguments:{constructor:'bad'}},
  ]) {
    await assert.rejects(()=>compilePlan({version:1,name:'MCP bad',steps:[
      {...base,with:{...base.with,...bad}},
    ]}),PlanError);
  }
});

test('MCP tool contract fingerprint ignores JSON key ordering but detects schema drift',async()=>{
  const original={type:'object',properties:{value:{type:'string',maxLength:4096}},required:['value']};
  const reordered={required:['value'],properties:{value:{maxLength:4096,type:'string'}},type:'object'};
  assert.equal(await toolSchemaDigest(original),await toolSchemaDigest(reordered));
  assert.notEqual(await toolSchemaDigest(original),await toolSchemaDigest({
    ...original,properties:{value:{type:'string',maxLength:4095}},
  }));
  assert.notEqual(await toolSchemaDigest(original),await toolSchemaDigest(original,{type:'object'}));
});

test('MCP contract requires bounded, concrete JSON Schema; no user-supplied digest',async()=>{
  const step={id:'read',uses:'mcp.call',with:{
    endpoint:'https://public.example.org/mcp',tool:'echo',scope:'read',
    input_schema:{type:'object',properties:{value:{type:'string'}}},
    arguments:{value:'safe'},
  }};
  const plan={version:1,name:'MCP fingerprint required',steps:[step]};
  const compiled=await compilePlan(plan);
  const fingerprint=await toolSchemaDigest(step.with.input_schema);
  assert.equal(compiled.plan.steps[0].with.schema_digest,fingerprint);
  for(const extra of [
    {input_schema:undefined},
    {input_schema:'not-an-object'},
    {input_schema:{}},
    {input_schema:{type:'array'}},
    {input_schema:{type:'object',description:'x'.repeat(9000)}},
    {output_schema:{}},
    {output_schema:{type:'array'}},
    {output_schema:'not-an-object'},
    {schema_digest:'0'.repeat(64)},
  ])await assert.rejects(()=>compilePlan({...plan,steps:[{
    ...step,with:{...step.with,...extra},
  }]}),PlanError);
});


test('GitHub only compiles a fixed registered capability without dynamic shell, repo, or token',async()=>{
  const compiled=await compilePlan({version:1,name:'GitHub echo',steps:[
    {id:'heavy',uses:'github.run',with:{capability:'github.workflow.check'}},
    {id:'out',needs:['heavy'],uses:'result.emit',with:{data:{ref:'steps.heavy.output'}}},
  ]});
  assert.equal(compiled.plan.steps[0].uses,'github.run');
  assert.deepEqual(compiled.plan.steps[0].with,{capability:'github.workflow.check'});
  for(const extra of [
    {capability:'shell.exec'},
    {capability:'github.workflow.check',repository:'attacker/other'},
    {capability:'github.workflow.check',workflow:'other.yml'},
    {capability:'github.workflow.check',token:{ref:'inputs.token'}},
    {capability:'github.workflow.check',command:'pwd'},
    {capability:'github.workflow.check',arguments:{value:'unsafe'}},
  ]) await assert.rejects(()=>compilePlan({version:1,name:'GitHub invalid',steps:[
    {id:'heavy',uses:'github.run',with:extra},
  ]}),PlanError);
});
