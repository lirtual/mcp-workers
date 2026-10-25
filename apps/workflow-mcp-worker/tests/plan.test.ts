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


test('retired fixed GitHub Workflow Check and arbitrary commands fail closed',async()=>{
  for(const capability of ['github.workflow.check','shell.exec',null])
    await assert.rejects(()=>compilePlan({version:1,name:'Invalid GitHub capability',steps:[
      {id:'heavy',uses:'github.run',with:{capability}},
    ]}),PlanError);
});


test('skip-tolerant join is explicit, compiler-pinned, and keeps default Plan digests',async()=>{
  const base={version:1,name:'Join contract',steps:[
    {id:'left',uses:'result.emit',with:{data:'left'}},
    {id:'join',needs:['left'],uses:'result.emit',with:{data:'joined'}},
  ]};
  const original=await compilePlan(base);
  const explicitDefault=await compilePlan({...base,steps:[
    base.steps[0],{...base.steps[1],needs_policy:'all_succeeded'},
  ]});
  assert.equal(original.digest,explicitDefault.digest,'default semantics must not republish old Plans');
  assert.equal(original.plan.steps[1].needs_policy,undefined);
  const skipAllowed=await compilePlan({...base,steps:[
    base.steps[0],{...base.steps[1],needs_policy:'allow_skipped'},
  ]});
  assert.notEqual(skipAllowed.digest,original.digest);
  assert.equal(skipAllowed.plan.steps[1].needs_policy,'allow_skipped');
  for(const value of ['ignore_failure','all_done',true,42,null]) {
    await assert.rejects(()=>compilePlan({...base,steps:[
      base.steps[0],{...base.steps[1],needs_policy:value},
    ]}),error=>error instanceof PlanError&&error.path==='/steps/1/needs_policy');
  }
  await assert.rejects(()=>compilePlan({version:1,name:'No dependencies',
    steps:[{id:'join',uses:'result.emit',needs_policy:'allow_skipped',with:{data:1}}]}),
    error=>error instanceof PlanError&&error.path==='/steps/0/needs_policy');
});


test('literal bounded repeat expands deterministically to version-pinned sequential DAG',async()=>{
  const definition={version:1,name:'Repeat literal',inputs:{message:'same'},
    steps:[{id:'echo',flow:'repeat',times:3,
      template:{uses:'result.emit',with:{data:{ref:'inputs.message'}}}}]};
  const compiled=await compilePlan(definition);
  assert.deepEqual(compiled.plan.steps.map(s=>({id:s.id,needs:s.needs})),[
    {id:'echo_0',needs:[]},{id:'echo_1',needs:['echo_0']},
    {id:'echo_2',needs:['echo_1']},
  ]);
  const explicit=await compilePlan({version:1,name:'Repeat literal',inputs:{message:'same'},
    steps:[
      {id:'echo_0',uses:'result.emit',with:{data:{ref:'inputs.message'}}},
      {id:'echo_1',needs:['echo_0'],uses:'result.emit',with:{data:{ref:'inputs.message'}}},
      {id:'echo_2',needs:['echo_1'],uses:'result.emit',with:{data:{ref:'inputs.message'}}},
    ]});
  assert.equal(compiled.digest,explicit.digest,
    'repeat must have exactly the same immutable semantics as flattened Steps');
  assert.equal(compiled.digest,(await compilePlan(JSON.stringify(definition))).digest);
});

test('literal repeat fails closed on invalid times, nested flow, collisions and global step budget',async()=>{
  const one=(overrides:Record<string,unknown>={})=>({version:1,name:'Fixed repeat',
    steps:[{id:'loop',flow:'repeat',times:2,
      template:{uses:'result.emit',with:{data:'ok'}},...overrides}]});
  for(const times of [0,9,-1,1.5,'2',{ref:'inputs.times'},null]){
    await assert.rejects(()=>compilePlan(one({times})),
      e=>e instanceof PlanError&&e.path==='/steps/0/times');
  }
  for(const invalid of [
    {flow:'while'}, {script:'unsafe'}, {template:{flow:'repeat',times:2}},
    {template:{uses:'result.emit',with:{data:'ok'},needs:['other']}},
  ])await assert.rejects(()=>compilePlan(one(invalid)),PlanError);
  await assert.rejects(()=>compilePlan({...one(),steps:[
    ...one().steps,{id:'loop_0',uses:'result.emit',with:{data:0}},
  ]}),PlanError,'generated and manually defined ids must not collide');
  await assert.rejects(()=>compilePlan({...one(),steps:[
    ...Array.from({length:5},(_,i)=>({
      id:'loop'+i,flow:'repeat',times:8,
      template:{uses:'result.emit',with:{data:i}},
    })),
  ]}),e=>e instanceof PlanError&&e.path==='/steps');
  const full=await compilePlan({...one(),steps:
    Array.from({length:4},(_,i)=>({id:'loop'+i,flow:'repeat',times:8,
      template:{uses:'result.emit',with:{data:i}}}))});
  assert.equal(full.plan.steps.length,32);
});

test('literal repeat still validates each expanded MCP step using existing operation contract',async()=>{
  await assert.rejects(()=>compilePlan({version:1,name:'Unsafe repeat',
    steps:[{id:'loop',flow:'repeat',times:3,template:{uses:'mcp.call',
      with:{endpoint:'https://evil.invalid/mcp',tool:'tool',scope:'write',
        input_schema:{type:'object'},arguments:{}}}}]}),PlanError);
});

test('ordinary Step after 32 expanded repeat Steps cannot bypass global budget',async()=>{
  const groups=Array.from({length:4},(_,i)=>({
    id:'group'+i,flow:'repeat',times:8,
    template:{uses:'result.emit',with:{data:i}},
  }));
  const base={version:1,name:'Enforce mixed flattened budget'};
  const exact=await compilePlan({...base,steps:groups});
  assert.equal(exact.plan.steps.length,32);
  for(const bad of [
    [...groups,{id:'additional',uses:'result.emit',with:{data:1}}],
    [...groups,{id:'additional',uses:'result.emit',
      needs:['group3_7'],with:{data:1}}],
  ])await assert.rejects(()=>compilePlan({...base,steps:bad}),
    (error:unknown)=>error instanceof PlanError &&
      error.message==='invalid_step_count'&&error.path==='/steps');
  const valid=await compilePlan({...base,steps:[
    ...groups.slice(0,3),
    {id:'extra',uses:'result.emit',with:{data:1}},
  ]});
  assert.equal(valid.plan.steps.length,25);
});
