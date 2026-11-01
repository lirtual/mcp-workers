import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkflowService,type Env} from '../src/store.ts';
import {validateWorkflowTarget} from '../src/tools.ts';
import {cloudflareActionManifest} from '../src/cloudflare-action-contract.ts';

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
    [{...base,triggers:[{type:'webhook',token_sha256:'invalid'}]},'invalid_webhook_token_hash','/triggers/0/token_sha256'],
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
    ['scope','write','unreviewed_write_operation','/steps/0/with'],
  ] as const){
    const malformed={...base,steps:[{...base.steps[0],
      with:{...base.steps[0].with,[property]:value}}]};
    const result=await validateWorkflowTarget(service,{definition:JSON.stringify(malformed)});
    assert.equal(result.valid,false);
    assert.equal(result.issues[0].code,code);
    assert.equal(result.issues[0].path,path);
  }
});

test('nested references pinpoint safe fields without reflecting private argument names or values',async()=>{
  const service=new WorkflowService({DB:{
    prepare(){throw Error('inline validation touched D1');},
  }} as unknown as Env);
  for(const [definition,expectedPath] of [
    [{version:1,name:'Unknown dependency',steps:[
      {id:'one',uses:'result.emit',with:{data:{ref:'steps.missing.output'}}},
    ]},'/steps/0/with/data/ref'],
    [{version:1,name:'Broken conditional',steps:[
      {id:'one',uses:'result.emit',if:{and:[true,{eq:[{ref:'steps.secret.output'},'ok']} ]},with:{data:'ok'}},
    ]},'/steps/0/if/and/1/eq/0/ref'],
    [{version:1,name:'Malformed reference',steps:[
      {id:'one',uses:'result.emit',with:{data:{ref:'bad token'}}},
    ]},'/steps/0/with/data/ref'],
  ] as const){
    const answer=await validateWorkflowTarget(service,{definition:JSON.stringify(definition)});
    assert.equal(answer.valid,false);
    assert.equal(answer.issues[0].path,expectedPath);
    assert.ok(['invalid_reference','invalid_step_reference'].includes(answer.issues[0].code));
  }
  const privateField='DoNotExposePrivateAccountNumber';
  const privateValue='DoNotExposeRawSecretValue';
  const answer=await validateWorkflowTarget(service,{definition:JSON.stringify({
    version:1,name:'Private fields',steps:[{
      id:'one',uses:'result.emit',with:{data:{[privateField]:{ref:privateValue}}},
    }],
  })});
  assert.equal(answer.valid,false);
  assert.equal(answer.issues[0].path,'/steps/0/with/data/ref');
  assert.equal(JSON.stringify(answer).includes(privateField),false);
  assert.equal(JSON.stringify(answer).includes(privateValue),false);
});


test('inline validation rejects proven missing literal output fields at the consumer reference',async()=>{
  const service=new WorkflowService({DB:{prepare(){throw Error('no D1 reads or writes');}}} as unknown as Env);
  const steps=[
    {id:'source',uses:'result.emit',with:{data:{answer:42,nested:{label:'yes'}}}},
    {id:'consumer',needs:['source'],uses:'result.emit',with:{data:{ref:'steps.source.output.field_that_does_not_exist'}}},
  ];
  const validate=async()=>validateWorkflowTarget(service,{definition:JSON.stringify({version:1,name:'Static references',steps})});
  let response=await validate();
  assert.equal(response.valid,false);
  assert.equal(response.issues[0].code,'unknown_output_field');
  assert.equal(response.issues[0].path,'/steps/1/with/data/ref');
  assert.ok(response.issues[0].suggestion);
  steps[1]!.with.data={ref:'steps.source.output.nested.label'};
  response=await validate();
  assert.equal(response.valid,true);
  steps[1]!.with.data={ref:'steps.source.output.nested.absent'};
  response=await validate();
  assert.equal(response.issues[0].code,'unknown_output_field');
});

test('numeric comparison rejects proven incompatible output type, but unknown output remains allowed',async()=>{
  const service=new WorkflowService({DB:{prepare(){throw Error('no D1 access');}}} as unknown as Env);
  const source:{id:string;uses:string;with:{data:unknown}}={id:'source',uses:'result.emit',with:{data:{answer:'text'}}};
  const consumer={id:'consumer',needs:['source'],uses:'result.emit',
    if:{gt:[{ref:'steps.source.output.answer'},0]},with:{data:'ok'}};
  const validate=(steps:unknown[])=>validateWorkflowTarget(service,{definition:JSON.stringify({version:1,name:'Types',steps})});
  let response=await validate([source,consumer]);
  assert.equal(response.valid,false);
  assert.equal(response.issues[0].code,'incompatible_output_type');
  assert.equal(response.issues[0].path,'/steps/1/if/gt/0/ref');
  source.with.data={answer:12};
  assert.equal((await validate([source,consumer])).valid,true);
  source.with.data='text';
  consumer.if.gt[0]={ref:'steps.source.output'};
  assert.equal((await validate([source,consumer])).issues[0].code,'incompatible_output_type');
  source.with.data={ref:'inputs.dynamic'};
  assert.equal((await validate([source,consumer])).valid,true);
});


test('reviewed closed Cloudflare output schema rejects undeclared fields but accepts declared ones',async()=>{
 const service=new WorkflowService({DB:{prepare(){throw Error('no D1 access');}}} as unknown as Env);
 const {contract_digest}=await cloudflareActionManifest('unified-generic');
 const source={id:'notify',uses:'action.run',with:{executor:'cloudflare',provider:'weixin',
   action:'weixin.send_text',contract_digest,input:{text:'reviewed'}}};
 const output={id:'done',needs:['notify'],uses:'result.emit',with:{data:{ref:'steps.notify.output.unknown_key'}}};
 const validate=()=>validateWorkflowTarget(service,{definition:JSON.stringify({version:1,name:'Reviewed contract',steps:[source,output]})});
 const rejected=await validate();
 assert.equal(rejected.valid,false);
 assert.equal(rejected.issues[0].code,'unknown_output_field');
 output.with.data.ref='steps.notify.output.status';
 assert.equal((await validate()).valid,true);
});

test('untrusted MCP declared output and runtime inputs cannot be claimed as statically closed',async()=>{
 const service=new WorkflowService({DB:{prepare(){throw Error('no D1 access');}}} as unknown as Env);
 const definition={version:1,name:'Unknown outputs',steps:[
   {id:'call',uses:'mcp.call',with:{endpoint:'https://mcp.lirtual.dpdns.org/mcp',
     tool:'ima_list_notebooks',scope:'read',arguments:{},input_schema:{type:'object'},
     output_schema:{type:'object',additionalProperties:false,properties:{known:{type:'string'}}}}},
   {id:'done',uses:'result.emit',needs:['call'],with:{data:{ref:'steps.call.output.other'}}},
 ]};
 assert.equal((await validateWorkflowTarget(service,{definition:JSON.stringify(definition)})).valid,true);
});


test('static output reference failures never echo arbitrary user object keys',async()=>{
 const service=new WorkflowService({DB:{prepare(){throw Error('no D1 access');}}} as unknown as Env);
 const key='PRIVATE_Access_Token_123';
 const result=await validateWorkflowTarget(service,{definition:JSON.stringify({version:1,name:'Safe errors',steps:[
   {id:'source',uses:'result.emit',with:{data:{ok:true}}},
   {id:'done',uses:'result.emit',needs:['source'],with:{data:{[key]:{ref:'steps.source.output.no_such_field'}}}},
 ]})});
 assert.equal(result.issues[0].code,'unknown_output_field');
 assert.equal(result.issues[0].path,'/steps/1/with/data/ref');
 assert.equal(JSON.stringify(result).includes(key),false);
});
