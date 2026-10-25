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
  assert.equal(result.issues[0].path,'/steps');
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
