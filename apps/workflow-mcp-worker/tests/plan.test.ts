import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePlan, evaluateExpression, evaluateArguments, evaluateCondition, canonicalJsonString, PlanError, toolSchemaDigest } from '../src/plan.ts';
import { capabilityCatalog, GITHUB_CAPABILITY_ID, LIMITS, supportedCapabilityExamples, workflowCapabilities } from '../src/capabilities.ts';
import { REGISTERED_GITHUB_ACTION, registeredGithubPin } from '../src/github-registry.ts';

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
      {id:'read',uses:'mcp.call',with:{endpoint:'https://test-mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',input_schema:{type:'object',properties:{}},arguments:argumentsValue}}
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

test('supported capability examples compile through the real plan compiler', async () => {
  const seen = new Set<string>();
  let sawCheck = false;
  let sawRegistered = false;
  assert.ok(supportedCapabilityExamples.length >= 3);
  for (const example of supportedCapabilityExamples) {
    assert.equal(JSON.stringify(example).includes('schema_digest'), false);
    assert.equal(JSON.stringify(example).includes('"write"'), false);
    const compiled = await compilePlan(example);
    assert.match(compiled.digest, /^[0-9a-f]{64}$/);
    assert.equal(compiled.plan.version, 1);
    assert.ok(compiled.plan.steps.length >= 1);
    for (const step of compiled.plan.steps) seen.add(step.uses);
    const github = compiled.plan.steps.find(step => step.uses === 'github.run');
    if (github?.with.capability === GITHUB_CAPABILITY_ID) {
      assert.deepEqual(github.with, {capability: 'github.workflow.check'});
      sawCheck = true;
    }
    if (github?.with.capability === REGISTERED_GITHUB_ACTION.id) {
      assert.equal(registeredGithubPin(github.with.registry), true);
      assert.deepEqual(Object.keys(github.with).sort(), ['capability', 'inputs', 'registry']);
      assert.equal(JSON.stringify(github.with).includes('token'), false);
      sawRegistered = true;
    }
  }
  assert.equal(sawCheck && sawRegistered, true);
  assert.deepEqual([...seen].sort(), ['flow.repeat', 'github.run', 'mcp.call', 'result.emit']);
});

test('an unchanged manual definition keeps its published plan digest', async () => {
  const compiled = await compilePlan(JSON.stringify(one));
  assert.equal(compiled.digest, '6cefd7cf044a155631149e7c23cd12ce30b39f31296e5a5b02647efa3a1e6c0f');
  assert.equal('triggers' in compiled.plan, false);
});

test('approved webhook and GitHub event triggers compile, and illegal trigger input does not', async () => {
  const webhook = {
    version: 1, name: 'On hook',
    triggers: [{id: 'hook', type: 'webhook', source: 'approved-webhook', event: 'submitted'}],
    steps: [{id: 'emit', uses: 'result.emit', with: {data: {ref: 'inputs.event'}}}],
  };
  const github = {
    version: 1, name: 'On push',
    triggers: [{id: 'gh', type: 'github_event', repository: 'example/workflow', events: ['push', 'issues']}],
    steps: [{id: 'emit', uses: 'result.emit', with: {data: {ref: 'inputs.payload'}}}],
  };
  const compiled = await compilePlan(webhook);
  assert.deepEqual(compiled.plan.triggers, webhook.triggers);
  const reordered = await compilePlan({
    ...github,
    triggers: [{events: ['issues', 'push'], repository: 'example/workflow', type: 'github_event', id: 'gh'}],
  });
  assert.equal(reordered.digest, (await compilePlan(github)).digest);
  assert.deepEqual(capabilityCatalog().filter(entry => entry.status === 'supported').map(entry => entry.id).filter(id => id.startsWith('trigger.')),
    ['trigger.manual', 'trigger.webhook', 'trigger.github_event']);
  const rejected: Array<{definition: unknown; code: string; path: string}> = [
    {definition: {...webhook, triggers: [{id: 'hook', type: 'webhook', source: 'approved-webhook', event: 'submitted', secret: 'hidden-secret-value'}]}, code: 'unsupported_field', path: '/triggers/0/secret'},
    {definition: {...github, triggers: [{id: 'gh', type: 'github_event', repository: 'example/workflow', events: ['workflow_run']}]}, code: 'unsupported_github_event', path: '/triggers/0/events/0'},
    {definition: {...github, triggers: [{id: 'gh', type: 'github_event', repository: 'https://github.com/example/workflow', events: ['push']}]}, code: 'invalid_repository', path: '/triggers/0/repository'},
    {definition: {version: 1, name: 'Cron', cron: '*/5 * * * *', steps: webhook.steps}, code: 'unsupported_field', path: '/cron'},
  ];
  for (const probe of rejected) {
    await assert.rejects(() => compilePlan(probe.definition), (error: unknown) => {
      assert.ok(error instanceof PlanError);
      assert.equal(error.message.split(':')[0], probe.code);
      assert.equal(error.path, probe.path);
      assert.equal(JSON.stringify(error).includes('hidden-secret-value'), false);
      return true;
    });
  }
});

test('unimplemented capabilities stay unsupported and the compiler reports a precise path', async () => {
  for (const entry of capabilityCatalog()) {
    if (entry.status === 'unsupported') assert.equal(JSON.stringify(entry).includes('example'), false);
    else assert.equal(entry.status, 'supported');
  }
  const unsupported = capabilityCatalog().filter(entry => entry.status === 'unsupported').map(entry => entry.id);
  assert.deepEqual(unsupported, [
    'trigger.cron',
    'action.http', 'action.mcp.write', 'action.shell',
    'flow.foreach', 'flow.while', 'flow.nesting', 'flow.dynamic_expansion', 'flow.wait', 'flow.child_workflow', 'flow.saga',
  ]);
  const step = (extra: Record<string, unknown>) => ({version: 1, name: 'Probe', steps: [{id: 'a', uses: 'result.emit', with: {data: 1}, ...extra}]});
  const probes: Array<{definition: unknown; code: string; path: string; suggestion?: RegExp}> = [
    {definition: {version: 1, name: 'Cron', cron: '* * * * *', steps: [{id: 'a', uses: 'result.emit', with: {data: 1}}]}, code: 'unsupported_field', path: '/cron'},
    {definition: {version: 1, name: 'Hook', webhook: 'https://hooks.example/in', steps: [{id: 'a', uses: 'result.emit', with: {data: 1}}]}, code: 'unsupported_field', path: '/webhook'},
    {definition: {version: 1, name: 'Event', trigger: {github: 'push'}, steps: [{id: 'a', uses: 'result.emit', with: {data: 1}}]}, code: 'unsupported_field', path: '/trigger'},
    {definition: {version: 1, name: 'Shell', steps: [{id: 'a', uses: 'shell.run', with: {command: 'pwd'}}]}, code: 'unsupported_capability', path: '/steps/0/uses'},
    {definition: {version: 1, name: 'HTTP', steps: [{id: 'a', uses: 'http.request', with: {url: 'https://example.com'}}]}, code: 'unsupported_capability', path: '/steps/0/uses'},
    {definition: {version: 1, name: 'Write', steps: [{id: 'a', uses: 'mcp.call', with: {endpoint: 'https://mcp.lirtual.dpdns.org/mcp', tool: 'echo', scope: 'write', input_schema: {type: 'object'}, arguments: {}}}]}, code: 'unsupported_operation_scope', path: '/steps/0/with/scope', suggestion: /read/},
    {definition: step({foreach: 'inputs.items'}), code: 'unsupported_field', path: '/steps/0/foreach'},
    {definition: step({while: true}), code: 'unsupported_field', path: '/steps/0/while'},
    {definition: {version: 1, name: 'Child', steps: [{id: 'a', uses: 'workflow.call', with: {workflow_id: 'child'}}]}, code: 'unsupported_capability', path: '/steps/0/uses'},
    {definition: {version: 1, name: 'Saga', saga: {}, steps: [{id: 'a', uses: 'result.emit', with: {data: 1}}]}, code: 'unsupported_field', path: '/saga'},
    {definition: {version: 1, name: 'Ref', steps: [{id: 'a', uses: 'result.emit', with: {data: {ref: 'nope'}}}]}, code: 'invalid_reference', path: '/steps/0/with/data/ref'},
    {definition: {version: 1, name: 'Wave', steps: Array.from({length: 9}, (_, i) => ({id: 's' + i, uses: 'result.emit', with: {data: i}}))}, code: 'excessive_parallelism', path: '/steps'},
  ];
  for (const probe of probes) {
    await assert.rejects(() => compilePlan(probe.definition), (error: unknown) => {
      assert.ok(error instanceof PlanError);
      assert.equal(error.message.split(':')[0], probe.code);
      assert.equal(error.path, probe.path);
      if (probe.suggestion) assert.match(error.suggestion ?? '', probe.suggestion);
      assert.doesNotMatch(error.suggestion ?? '', /write|shell|secret|token|skip/i);
      return true;
    });
  }
});

const boundedRepeat = {
  version: 1,
  name: 'Bounded loop',
  steps: [
    {id: 'seed', uses: 'result.emit', with: {data: 'seed'}},
    {id: 'grow', needs: ['seed'], uses: 'result.emit',
      repeat: {times: 3, until: {eq: [{ref: 'loop.index'}, 2]}},
      if: {lt: [{ref: 'loop.index'}, 2]},
      with: {data: {
        index: {ref: 'loop.index'},
        seed: {ref: 'steps.seed.output'},
        prev: {ref: 'steps.grow.output'},
      }}},
  ],
};

test('an existing static plan keeps its canonical digest', async () => {
  const compiled = await compilePlan(JSON.stringify(one));
  assert.equal(compiled.digest, '6cefd7cf044a155631149e7c23cd12ce30b39f31296e5a5b02647efa3a1e6c0f');
  assert.equal(compiled.plan.steps.some(step => step.uses === 'flow.repeat' || step.repeat !== undefined), false);
});

test('bounded repeat publishes the compiler budgets and compiles to a closed loop step', async () => {
  const detail = workflowCapabilities({}, 'flow.repeat');
  assert.equal(detail.status, 'supported');
  if (!('limits' in detail) || !detail.limits || !('max_iterations' in detail.limits) || !('example' in detail))
    throw new Error('flow.repeat detail missing');
  assert.equal(detail.limits.max_iterations, LIMITS.maxLoopIterations);
  assert.equal(detail.limits.max_expanded_steps, LIMITS.maxExpandedSteps);
  assert.equal(detail.limits.max_parallel_steps, LIMITS.maxParallel);
  assert.equal(detail.limits.max_loop_depth, LIMITS.maxLoopDepth);
  assert.equal(detail.limits.max_loop_deadline_ms, LIMITS.maxLoopDeadlineMs);
  assert.equal(LIMITS.maxExpandedSteps <= LIMITS.maxSteps, true);
  const fromCatalog = await compilePlan(detail.example);
  const compiled = await compilePlan(boundedRepeat);
  assert.equal(compiled.digest, fromCatalog.digest);
  assert.deepEqual(compiled.plan.steps.map(step => step.uses), ['result.emit', 'flow.repeat']);
  const grow = compiled.plan.steps[1];
  assert.equal(grow.repeat?.times, 3);
  assert.equal(grow.body?.uses, 'result.emit');
  assert.equal('data' in grow.with, false);
  assert.equal(compiled.plan.steps.length, 2);
  const maxed = structuredClone(boundedRepeat);
  const repeated = maxed.steps[1];
  if (!repeated?.repeat) throw new Error('repeat missing');
  repeated.repeat.times = LIMITS.maxLoopIterations;
  assert.equal((await compilePlan(maxed)).plan.steps[1]?.repeat?.times, LIMITS.maxLoopIterations);
});

test('unbounded loops, dynamic expansion, nesting, and unsafe loop bodies fail validate', async () => {
  const loop = (repeat: unknown, uses = 'result.emit', input: Record<string, unknown> = {data: 1}) => ({
    version: 1, name: 'Loop', steps: [{id: 'a', uses, repeat, with: input}],
  });
  const probes: Array<{definition: unknown; code: string; path: string}> = [
    {definition: loop(true), code: 'unbounded_loop', path: '/steps/0/repeat'},
    {definition: loop({}), code: 'unbounded_loop', path: '/steps/0/repeat/times'},
    {definition: loop({times: 0}), code: 'unbounded_loop', path: '/steps/0/repeat/times'},
    {definition: loop({times: -1}), code: 'unbounded_loop', path: '/steps/0/repeat/times'},
    {definition: loop({times: 1.5}), code: 'unbounded_loop', path: '/steps/0/repeat/times'},
    {definition: loop({times: '3'}), code: 'unbounded_loop', path: '/steps/0/repeat/times'},
    {definition: loop({times: {ref: 'inputs.n'}}), code: 'dynamic_expansion', path: '/steps/0/repeat/times'},
    {definition: loop({times: 2, each: ['a', 'b']}), code: 'dynamic_expansion', path: '/steps/0/repeat/each'},
    {definition: loop({times: LIMITS.maxLoopIterations + 1}), code: 'loop_budget_exceeded', path: '/steps/0/repeat/times'},
    {definition: {version: 1, name: 'Wide', steps: Array.from({length: 5}, (_, i) => ({id: 's' + i, uses: 'result.emit', repeat: {times: 8}, with: {data: i}}))}, code: 'loop_budget_exceeded', path: '/steps'},
    {definition: loop({times: 1, steps: [{id: 'inner', uses: 'result.emit', with: {data: 1}}]}), code: 'loop_nesting_unsupported', path: '/steps/0/repeat/steps'},
    {definition: {version: 1, name: 'Nest', steps: [{id: 'a', uses: 'result.emit', steps: [], with: {data: 1}}]}, code: 'loop_nesting_unsupported', path: '/steps/0/steps'},
    {definition: loop({times: 1}, 'mcp.call', {endpoint: 'https://mcp.lirtual.dpdns.org/mcp', tool: 'echo', scope: 'read', input_schema: {type: 'object'}, arguments: {}}), code: 'unsafe_loop_body', path: '/steps/0/repeat'},
    {definition: loop({times: 1}, 'github.run', {capability: 'github.workflow.check'}), code: 'unsafe_loop_body', path: '/steps/0/repeat'},
    {definition: loop({times: 1, until: {eq: [{ref: 'loop.index'}, 0]}, wait: 1}), code: 'unsupported_field', path: '/steps/0/repeat/wait'},
    {definition: {version: 1, name: 'Self', steps: [{id: 'a', uses: 'result.emit', with: {data: {ref: 'steps.a.output'}}}]}, code: 'invalid_step_reference', path: '/steps/0/with/data/ref'},
    {definition: {version: 1, name: 'Index', steps: [{id: 'a', uses: 'result.emit', with: {data: {ref: 'loop.index'}}}]}, code: 'invalid_reference', path: '/steps/0/with/data/ref'},
  ];
  for (const probe of probes) {
    await assert.rejects(() => compilePlan(probe.definition), (error: unknown) => {
      assert.ok(error instanceof PlanError, probe.path);
      assert.equal(error.message.split(':')[0], probe.code, probe.path + ' ' + error.message);
      assert.equal(error.path, probe.path);
      assert.doesNotMatch(error.suggestion ?? '', /write|shell|secret|token|skip/i);
      return true;
    });
  }
  for (const id of ['flow.foreach', 'flow.while', 'flow.nesting', 'flow.dynamic_expansion', 'flow.wait', 'flow.child_workflow', 'flow.saga']) {
    const entry = workflowCapabilities({}, id);
    assert.equal(entry.status, 'unsupported', id);
    assert.equal('example' in entry, false, id);
  }
});
