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


test('bounded foreach reserves every possible child identity and validates declared inputs',async()=>{
  const definition={version:1,name:'Dynamic snapshot',inputs:{items:['a','b']},steps:[
    {id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:4,
      template:{steps:[{id:'emit',uses:'result.emit',
        with:{data:{index:{ref:'item.index'},value:{ref:'item.value'}}}}]}},
    {id:'done',needs:['each'],uses:'result.emit',with:{data:{ref:'steps.each.output'}}},
  ]};
  const {plan,digest}=await compilePlan(definition);
  assert.equal(plan.steps.length,2);
  assert.equal(plan.steps.find(s=>s.id==='each')?.uses,'flow.foreach');
  assert.deepEqual(plan.steps.find(s=>s.id==='each')?.with.items,{ref:'inputs.items'});
  assert.equal(digest,(await compilePlan(JSON.stringify(definition))).digest);
  assert.match(digest,/^[a-f0-9]{64}$/);
});

test('bounded foreach rejects unbounded, unsafe, colliding or unauthorized expansion',async()=>{
  const child={id:'emit',uses:'result.emit',with:{data:{ref:'item.value'}}};
  const one=(args:Record<string,unknown>={})=>({version:1,name:'Fail closed',
    inputs:{items:[1,2]},steps:[{id:'each',flow:'foreach',items:{ref:'inputs.items'},
      max_items:2,template:{steps:[child]},...args}]});
  for(const max_items of [0,9,2.5,'2',null,{ref:'inputs.limit'}]){
    await assert.rejects(()=>compilePlan(one({max_items})),
      (e:unknown)=>e instanceof PlanError&&e.path==='/steps/0/max_items');
  }
  for(const args of [
    {items:{ref:'item.value'}},
    {items:{ref:'inputs.items',extra:true}},
    {items:['a']},
    {template:{steps:[child,child]}},
    {template:{steps:[{...child,uses:'mcp.call'}]}},
    {template:{steps:[{...child,uses:'github.run'}]}},
    {template:{steps:[{...child,with:{data:{ref:'item.secret'}}}]}},
    {template:{steps:[{...child,with:{data:{ref:'steps.not_a_dependency.output'}}}]}},
    {template:{steps:[{...child,with:{data:{ref:'item.index.sub'}}}]}},
  ])await assert.rejects(()=>compilePlan(one(args)),PlanError);
  await assert.rejects(()=>compilePlan({...one({max_items:3}),steps:[
    ...one({max_items:3}).steps,
    {id:'each_2_emit',uses:'result.emit',with:{data:'collision'}},
  ]}),PlanError);
  const full=Array.from({length:4},(_,i)=>({id:'set'+i,flow:'foreach',
    items:{ref:'inputs.items'},max_items:7,template:{steps:[child]}}));
  assert.equal((await compilePlan({...one(),steps:full})).plan.steps.length,4);
  await assert.rejects(()=>compilePlan({...one(),steps:[...full,
    {id:'fifth',uses:'result.emit',with:{data:1}}]}),
    (e:unknown)=>e instanceof PlanError&&e.message==='invalid_step_count');
});


test('foreach invalid references point at source or template instead of leaking payloads',async()=>{
  const root={version:1,name:'Precise foreach issue',inputs:{values:['x']}};
  for(const [items,data,expected] of [
    [{ref:'steps.undeclared.output'},{ref:'item.value'},'/steps/0/items/ref'],
    [{ref:'inputs.values'},{ref:'steps.undeclared.output'},'/steps/0/template/steps/0/with/data/ref'],
    [{ref:'inputs.values'},{ref:'item.secret'},'/steps/0/template/steps/0/with/data/ref'],
  ] as const){
    await assert.rejects(()=>compilePlan({...root,steps:[
      {id:'each',flow:'foreach',items,max_items:2,
        template:{steps:[{id:'emit',uses:'result.emit',with:{data}}]}},
    ]}),(e:unknown)=>e instanceof PlanError&&e.path===expected);
  }
});


test('source cannot spoof internal flow.foreach opcode to bypass template and budget checks',async()=>{
  for(const max_items of [1,8,999999]){
    await assert.rejects(()=>compilePlan({version:1,name:'No direct internal opcode',
      inputs:{items:['x']},steps:[{id:'each',uses:'flow.foreach',needs:[],
        with:{items:{ref:'inputs.items'},max_items,
          template:{id:'evil',uses:'mcp.call',with:{arguments:{command:'unsafe'}}}}}]}),
      (e:unknown)=>e instanceof PlanError&&
        e.message==='unsupported_capability'&&e.path==='/steps/0/uses');
  }
});


test('bounded MCP read foreach pins its child tool contract and item expressions',async()=>{
  const source={version:1,name:'Readonly dynamic map',inputs:{items:['one','two']},steps:[
    {id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
      template:{steps:[{id:'read',uses:'mcp.call',with:{
        endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',
        input_schema:{type:'object',properties:{value:{type:'string'}}},
        arguments:{value:{ref:'item.value'}},
      }}]}},
    {id:'done',needs:['each'],uses:'result.emit',with:{data:{ref:'steps.each.output'}}},
  ]};
  const {plan,digest}=await compilePlan(source);
  const child=plan.steps.find(s=>s.id==='each')?.with.template as {
    id:string;uses:string;with:{schema_digest:string;arguments:unknown};
  };
  assert.equal(child.id,'read');
  assert.equal(child.uses,'mcp.call');
  assert.match(child.with.schema_digest,/^[a-f0-9]{64}$/);
  assert.deepEqual(child.with.arguments,{value:{ref:'item.value'}});
  assert.equal(digest,(await compilePlan(JSON.stringify(source))).digest);
  for(const invalid of [
    {scope:'write'},
    {endpoint:'http://127.0.0.1/mcp'},
    {arguments:{value:{ref:'item.unauthorized'}}},
    {arguments:{value:{ref:'steps.not_declared.output'}}},
  ]){
    const bad=structuredClone(source);
    Object.assign(bad.steps[0]!.template!.steps[0]!.with,invalid);
    await assert.rejects(()=>compilePlan(bad),PlanError);
  }
  const bad=structuredClone(source);
  bad.steps[0]!.template!.steps[0]!.uses='github.run';
  await assert.rejects(()=>compilePlan(bad),PlanError);
});

test('bounded pure multi-step foreach reserves child IDs and checks local output references',async()=>{
  const source={version:1,name:'Pure per-item pipeline',inputs:{items:['A','B']},steps:[
    {id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:3,
      template:{steps:[
        {id:'prepare',uses:'result.emit',with:{data:{value:{ref:'item.value'},index:{ref:'item.index'}}}},
        {id:'finish',uses:'result.emit',if:{eq:[{ref:'steps.prepare.status'},'succeeded']},
          with:{data:{ref:'steps.prepare.output.value'}}},
      ]}},
    {id:'done',needs:['each'],uses:'result.emit',with:{data:{ref:'steps.each.output'}}},
  ]};
  const compiled=await compilePlan(source);
  const each=compiled.plan.steps.find(s=>s.id==='each');
  assert.equal(each?.uses,'flow.foreach');
  assert.equal((each?.with.templates as unknown[]).length,2);
  assert.match(compiled.digest,/^[a-f0-9]{64}$/);
  assert.equal(compiled.digest,(await compilePlan(JSON.stringify(source))).digest);
  const collision=structuredClone(source);
  collision.steps.push({id:'each_1_finish',uses:'result.emit',with:{data:'collision'}} as never);
  await assert.rejects(()=>compilePlan(collision),
    e=>e instanceof PlanError&&e.message==='invalid_step_id');
  const forward=structuredClone(source);
  forward.steps[0]!.template!.steps[0]!.with.data={ref:'steps.finish.output'};
  await assert.rejects(()=>compilePlan(forward),
    e=>e instanceof PlanError&&e.path==='/steps/0/template/steps/0/with/data/ref');
  const crossItem=structuredClone(source);
  crossItem.steps[0]!.template!.steps[1]!.with.data={ref:'steps.each_0_prepare.output'};
  await assert.rejects(()=>compilePlan(crossItem),PlanError);
});

test('multi-step foreach rejects unreviewed external children, nested templates and global budget bypass',async()=>{
  const emit=(id:string)=>({id,uses:'result.emit',with:{data:{ref:'item.value'}}});
  const make=(children:unknown[],max_items=2)=>({version:1,name:'Guarded stages',
    inputs:{items:['a','b']},steps:[{id:'each',flow:'foreach',items:{ref:'inputs.items'},
      max_items,template:{steps:children}}]});
  for(const children of [
    [emit('a'),emit('a')],
    [emit('a'),{...emit('b'),uses:'mcp.call'}],
    [emit('a'),{...emit('b'),uses:'github.run'}],
    [emit('a'),{...emit('b'),flow:'foreach'}],
    [emit('a'),emit('b'),emit('c'),emit('d'),emit('e')],
  ])await assert.rejects(()=>compilePlan(make(children)),PlanError);
  await assert.rejects(()=>compilePlan(make([emit('a'),emit('b'),emit('c'),emit('d')],8)),
    e=>e instanceof PlanError&&e.message==='invalid_step_count'&&e.path==='/steps');
  const exact=await compilePlan(make([emit('a'),emit('b'),emit('c')],8));
  assert.equal(exact.plan.steps.length,1);
  assert.equal((exact.plan.steps[0]!.with.templates as unknown[]).length,3);
});

test('multi-step foreach compiles only pinned read-only MCP and earlier item output refs',async()=>{
 const mcp={endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',
   input_schema:{type:'object',properties:{value:{type:'string'}}},
   arguments:{value:{ref:'steps.prepare.output'}}};
 const source={version:1,name:'multi MCP read',inputs:{items:['a','b']},steps:[
  {id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
   template:{steps:[
     {id:'prepare',uses:'result.emit',with:{data:{ref:'item.value'}}},
     {id:'read',uses:'mcp.call',with:mcp},
     {id:'finish',uses:'result.emit',with:{data:{ref:'steps.read.output'}}},
   ]}},
  {id:'done',uses:'result.emit',needs:['each'],with:{data:{ref:'steps.each.output'}}},
 ]};
 const {plan,digest}=await compilePlan(source);
 assert.equal(digest,(await compilePlan(JSON.stringify(source))).digest);
 const each=plan.steps.find(x=>x.id==='each')!;
 assert.equal((each.with.templates as Array<{uses:string}>).length,3);
 const read=(each.with.templates as Array<{id:string;with:{schema_digest?:string}}>)[1];
 assert.equal(read?.id,'read');
 assert.match(read?.with.schema_digest??'',/^[a-f0-9]{64}$/);
 for(const edit of [
  {scope:'write'}, {tool:'invalid tool'}, {endpoint:'http://localhost/mcp'},
  {arguments:{value:{ref:'steps.finish.output'}}},
  {arguments:{value:{ref:'steps.each_0_prepare.output'}}},
 ]){
   const bad=structuredClone(source);
   Object.assign(bad.steps[0]!.template!.steps[1]!.with,edit);
   await assert.rejects(()=>compilePlan(bad),PlanError);
 }
 const noGithub=structuredClone(source);
 noGithub.steps[0]!.template!.steps[1]!.uses='github.run';
 await assert.rejects(()=>compilePlan(noGithub),PlanError);
 const overflow=structuredClone(source);
 overflow.steps[0]!.max_items=8;
 overflow.steps.push({...structuredClone(source.steps[0]!),id:'another'} as never);
 await assert.rejects(()=>compilePlan(overflow),
   (e:unknown)=>e instanceof PlanError&&e.message==='invalid_step_count');
});

test('single awaited child compiles with pinned UUID, safe frozen inputs and stable digest',async()=>{
  const child='11111111-1111-4111-8111-111111111111';
  const version='22222222-2222-4222-8222-222222222222';
  const source={version:1,name:'Call reviewed child',inputs:{value:'hello'},steps:[
    {id:'start',uses:'result.emit',with:{data:{ref:'inputs.value'}}},
    {id:'delegate',flow:'child',workflow_id:child,version_id:version,
     needs:['start'],inputs:{value:{ref:'steps.start.output'}}},
    {id:'done',uses:'result.emit',needs:['delegate'],
      with:{data:{ref:'steps.delegate.output'}}},
  ]};
  const compiled=await compilePlan(source);
  assert.equal(compiled.plan.steps.find(s=>s.id==='delegate')?.uses,'flow.child');
  assert.deepEqual(compiled.plan.steps.find(s=>s.id==='delegate')?.with,
    {workflow_id:child,version_id:version,inputs:{value:{ref:'steps.start.output'}}});
  assert.equal(compiled.digest,(await compilePlan(source)).digest);
});

test('child source rejects unpinned, recursive syntax, extra effects and direct opcode spoof',async()=>{
  const child='11111111-1111-4111-8111-111111111111';
  const version='22222222-2222-4222-8222-222222222222';
  const one={id:'call',flow:'child',workflow_id:child,version_id:version,inputs:{}};
  const root=(steps:unknown[])=>({version:1,name:'No unsafe child',steps});
  for(const steps of [
    [{...one,version_id:'moving'}],
    [{...one,inputs:null}],
    [{...one,inputs:{value:{ref:'steps.missing.output'}}}],
    [{...one,mode:'arbitrary'}],
    [one,{...one,id:'second'}],
    [{id:'forge',uses:'flow.child',with:{workflow_id:child,version_id:version,inputs:{}}}],
  ])await assert.rejects(()=>compilePlan(root(steps)),PlanError);
});


test('bounded durable waits compile to deterministic native steps with a total time budget',async()=>{
  const source={version:1,name:'Wait then emit',steps:[
    {id:'waitFirst',flow:'wait',duration_seconds:2},
    {id:'waitSecond',flow:'wait',duration_seconds:3,needs:['waitFirst']},
    {id:'done',uses:'result.emit',needs:['waitSecond'],with:{data:'ok'}},
  ]};
  const compiled=await compilePlan(source);
  assert.deepEqual(compiled.plan.steps.filter(s=>s.uses==='flow.wait').map(s=>s.with.duration_seconds),[2,3]);
  assert.equal((await compilePlan(source)).digest,compiled.digest);
  const root=(steps:unknown[])=>({version:1,name:'Invalid wait',steps});
  for(const value of [0,-1,1.5,301,'1',null,{ref:'inputs.seconds'},true]){
    await assert.rejects(()=>compilePlan(root([
      {id:'hold',flow:'wait',duration_seconds:value},
    ])),(err:unknown)=>err instanceof PlanError&&err.message==='invalid_wait_duration');
  }
  for(const invalid of [
    {duration_seconds:1,uses:'result.emit'},
    {duration_seconds:1,if:true},
    {duration_seconds:1,with:{data:'unsupported'}},
    {duration_seconds:1,cron:'* * * * *'},
  ]){
    await assert.rejects(()=>compilePlan(root([{id:'hold',flow:'wait',...invalid}])),PlanError);
  }
  await assert.rejects(()=>compilePlan(root([
    {id:'a',flow:'wait',duration_seconds:151},
    {id:'b',flow:'wait',duration_seconds:150,needs:['a']},
  ])),(err:unknown)=>err instanceof PlanError&&err.message==='wait_budget_exceeded');
  await assert.rejects(()=>compilePlan(root([
    {id:'forged',uses:'flow.wait',with:{duration_seconds:1}},
  ])),PlanError);
});


test('pure dynamic while/until compiles with strict iteration and graph budget',async()=>{
 const def=(flow:'while'|'until',max_iterations=4)=>({version:1,name:'Dynamic loop',
   inputs:{limit:2},steps:[
     {id:'before',uses:'result.emit',with:{data:'ok'}},
     {id:'loop',flow,needs:['before'],max_iterations,
       condition:{lt:[{ref:'item.index'},{ref:'inputs.limit'}]},
       template:{uses:'result.emit',with:{data:{ref:'item.index'}}}},
     {id:'done',uses:'result.emit',needs:['loop'],with:{data:{ref:'steps.loop.output.value'}}},
   ],
 });
 for(const flow of ['while','until'] as const){
   const {plan}=await compilePlan(def(flow));
   assert.equal(plan.steps.find(s=>s.id==='loop')?.uses,'flow.loop');
   assert.equal(plan.steps.length,3);
 }
 for(const max_iterations of [0,9,1.2,-1]){
   await assert.rejects(()=>compilePlan(def('while',max_iterations)),
     (e:unknown)=>e instanceof PlanError&&e.message==='invalid_loop_limit');
 }
 const over=Array.from({length:5},(_,i)=>({
   id:'loop'+i,flow:'until',max_iterations:8,condition:false,
   template:{uses:'result.emit',with:{data:0}},
 }));
 await assert.rejects(()=>compilePlan({version:1,name:'Budget',steps:over}),/invalid_step_count/);
 await assert.rejects(()=>compilePlan({version:1,name:'Invalid loop',steps:[{
   id:'loop',flow:'while',max_iterations:2,condition:{ref:'steps.other.output'},
   template:{uses:'result.emit',with:{data:0}},
 }]}),/invalid_step_reference/);
 await assert.rejects(()=>compilePlan({version:1,name:'Invalid loop',steps:[{
   id:'loop',flow:'while',max_iterations:2,condition:true,
   template:{uses:'result.emit',with:{data:0},approval:{required:true}},
 }]}),/unsupported_field/);
 await assert.rejects(()=>compilePlan({version:1,name:'Spoof loop',steps:[{
   id:'loop',uses:'flow.loop',with:{mode:'until',max_iterations:2,condition:true,template:{uses:'result.emit',with:{data:0}}},
 }]}),/unsupported_capability/);
});
