import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkflowService,type Env} from '../src/store.ts';
import {validateWorkflowTarget} from '../src/tools.ts';

const validDefinition=JSON.stringify({
  version:1,name:'Inline preview',
  steps:[{id:'emit',uses:'result.emit',with:{data:{message:'ok'}}}],
});

test('inline validation uses published compiler but never touches D1',async()=>{
  const db={prepare(){throw Error('D1 read/write must not occur');},
            batch(){throw Error('D1 write must not occur');}};
  const service=new WorkflowService({DB:db} as unknown as Env);
  const result=await validateWorkflowTarget(service,{definition:validDefinition});
  assert.equal(result.valid,true);
  assert.equal('steps' in result ? result.steps : undefined,1);
  assert.match(String('digest' in result ? result.digest : ''),/^[0-9a-f]{64}$/);
  assert.deepEqual(result.issues,[]);
});

test('unknown capability returns stable structured issue without D1',async()=>{
  const db={prepare(){throw Error('unexpected D1 access');}};
  const service=new WorkflowService({DB:db} as unknown as Env);
  const invalid=JSON.stringify({version:1,name:'Invalid',
    steps:[{id:'run',uses:'shell',with:{}}]});
  const result=await validateWorkflowTarget(service,{definition:invalid});
  assert.equal(result.valid,false);
  assert.deepEqual(result.issues[0].code,'unsupported_capability');
  assert.equal(result.issues[0].path,'/steps/0/uses');
  assert.ok(result.issues[0].message);
  assert.ok(result.issues[0].suggestion);
});

test('validation target is an exclusive choice',async()=>{
  let called=0;
  const service={
    async validate(){called++;return {valid:true};},
    async validateDefinition(){called++;return {valid:true};},
  } as unknown as WorkflowService;
  const both=await validateWorkflowTarget(service,{
    workflow_id:'00000000-0000-4000-8000-000000000001',
    revision:1,definition:validDefinition,
  });
  assert.equal(both.valid,false);
  assert.equal(both.issues[0].code,'invalid_validate_target');
  assert.equal(called,0);
  assert.equal((await validateWorkflowTarget(service,{})).valid,false);
  assert.equal(called,0);
  assert.equal((await validateWorkflowTarget(service,{workflow_id:'00000000-0000-4000-8000-000000000001'})).valid,false);
  assert.equal((await validateWorkflowTarget(service,{revision:1})).valid,false);
  assert.equal(called,0);
  assert.equal((await validateWorkflowTarget(service,{workflow_id:'00000000-0000-4000-8000-000000000001',revision:1})).valid,true);
  assert.equal(called,1);
});

test('diagnostics locate unsupported trigger, Action and step field without leaking input',async()=>{
  const service=new WorkflowService({DB:{
    prepare(){throw Error('validation must not touch D1');},
  }} as unknown as Env);
  const base={version:1,name:'Inspect',steps:[{
    id:'one',uses:'result.emit',with:{data:'ok'},
  }]};
  for(const [definition,expectedCode,expectedPath] of [
    [{...base,triggers:[{type:'cron',expression:'* * * * *'}]},'unsupported_field','/triggers'],
    [{...base,steps:[{id:'one',uses:'shell',with:{}}]},'unsupported_capability','/steps/0/uses'],
    [{...base,steps:[{...base.steps[0],repeat:{times:2}}]},'unsupported_field','/steps/0/repeat'],
    [{...base,inputs:Object.fromEntries(Array.from({length:33},(_,i)=>['key'+i,i]))},
      'too_many_inputs','/inputs'],
  ] as const){
    const response=await validateWorkflowTarget(service,{definition:JSON.stringify(definition)});
    assert.equal(response.valid,false);
    assert.equal(response.issues[0].code,expectedCode);
    assert.equal(response.issues[0].path,expectedPath);
    assert.ok(response.issues[0].suggestion);
  }
  const secretKey='MySensitiveCallerTokenShouldStaySecret';
  const rejected=await validateWorkflowTarget(service,{definition:JSON.stringify({...base,[secretKey]:'secret-value'})});
  assert.equal(rejected.valid,false);
  assert.equal(rejected.issues[0].code,'unsupported_field');
  assert.equal(rejected.issues[0].path,'/');
  assert.equal(JSON.stringify(rejected).includes(secretKey),false);
  assert.equal(JSON.stringify(rejected).includes('secret-value'),false);
  const syntax=await validateWorkflowTarget(service,{definition:'name: [broken'});
  assert.equal(syntax.valid,false);
  assert.equal(syntax.issues[0].code,'invalid_yaml_or_json');
  assert.equal(syntax.issues[0].path,'/');
});

test('MCP field errors include stable paths while inline validation stays D1-free',async()=>{
  const service=new WorkflowService({DB:{
    prepare(){throw Error('inline validation touched D1');},
  }} as unknown as Env);
  const base={version:1,name:'Read',steps:[{
    id:'read',uses:'mcp.call',with:{
      endpoint:'https://mcp.lirtual.dpdns.org/mcp',
      tool:'ima_list_notebooks',scope:'read',arguments:{limit:1},
      input_schema:{type:'object',properties:{limit:{type:'number'}}},
    },
  }]};
  for(const [property,value,code,path] of [
    ['endpoint','http://localhost/mcp','invalid_endpoint','/steps/0/with/endpoint'],
    ['tool','invalid tool!','invalid_tool','/steps/0/with/tool'],
    ['scope','write','unsupported_operation_scope','/steps/0/with/scope'],
  ] as const){
    const malformed={...base,steps:[{...base.steps[0],
      with:{...base.steps[0].with,[property]:value}}]};
    const result=await validateWorkflowTarget(service,{definition:JSON.stringify(malformed)});
    assert.equal(result.valid,false);
    assert.equal(result.issues[0].code,code);
    assert.equal(result.issues[0].path,path);
  }
});
