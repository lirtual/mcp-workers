import {validateForeachTaskInputTemplate} from '../src/github-action-inputs.ts';
import {checkedFrozenTaskInputs,reviewedForeachTaskContract,frozenTaskInputDigest} from '../src/github-action-foreach-inputs.ts';
import {reviewedGitHubAction} from '../src/github-action-review.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePlan,publishedGitHubActionStep } from '../src/plan.ts';

const action={
  repository:'lirtual/session-actions',repositoryId:123,workflowId:456,
  workflowPath:'.github/workflows/linux.yml',commitSha:'a'.repeat(40),
  type:'session',contractDigest:'b'.repeat(64),ref:'refs/tags/test-v1',inputs:{duration_minutes:5},
};
const definition=(a:unknown)=>JSON.stringify({version:1,name:'Session action',steps:[{
  id:'start',uses:'github.run',with:{capability:'github.action',action:a},
}]});
test('new Action Draft retains a literal pinned source; does not grant execution',async()=>{
  const {plan}=await compilePlan(definition(action));
  assert.deepEqual(plan.steps[0].with.action,action);
  assert.equal(plan.github_execution_approved,undefined);
});
test('rejects missing and dynamic immutable Action identities',async()=>{
  await assert.rejects(compilePlan(definition({...action,commitSha:'main'})),/invalid_github_action/);
  await assert.rejects(compilePlan(definition({...action,workflowPath:'../escape.yml'})),/invalid_github_action/);
  await assert.rejects(compilePlan(definition({...action,repository:'${{ inputs.repo }}'})),/invalid_github_action/);
  await assert.rejects(compilePlan(definition({...action,extra:true})),/unsupported_field/);
  await assert.rejects(compilePlan(definition({...action,ref:'refs/heads/main'})),/invalid_github_action/);
  await assert.rejects(compilePlan(definition({...action,ref:'refs/tags/../bad'})),/invalid_github_action/);
});
test('unsupported GitHub capabilities remain rejected',async()=>{
  await assert.rejects(compilePlan(JSON.stringify({version:1,name:'Unsafe',steps:[{
    id:'start',uses:'github.run',with:{capability:'github.shell'},
  }]})),/unsupported_github_capability/);
});

test('bounded GitHub Task foreach pins one immutable reviewed template per child',async()=>{
 const task={...action,type:'task' as const,inputs:{outcome:'success'}};
 const source={version:1,name:'Task dynamic iteration',inputs:{items:['x','y']},steps:[
  {id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:3,
   template:{steps:[{id:'verify',uses:'github.run',
     if:{ne:[{ref:'item.value'},'skip']},
     with:{capability:'github.action',action:task}}]}},
  {id:'done',needs:['each'],uses:'result.emit',with:{data:'ok'}},
 ]};
 const {plan,digest}=await compilePlan(source);
 assert.equal(plan.steps.length,2);
 assert.equal(digest,(await compilePlan(JSON.stringify(source))).digest);
 for(let i=0;i<3;i++){
  const name='each_'+i+'_verify';
  const step=publishedGitHubActionStep(plan,name);
  assert.equal(step?.uses,'github.run');
  assert.equal(step?.id,name);
  assert.deepEqual(step?.with.action,task);
 }
 for(const id of ['each_3_verify','each_03_verify','each_0_notverify','each_0_verify_',
  'each','done','each_-1_verify','each_0_verify__proto__'])
  assert.equal(publishedGitHubActionStep(plan,id),undefined,id);
 for(const invalid of [
   {...task,type:'session'},
   {...task,inputs:{outcome:{ref:'inputs.items'}}},
   {...task,inputs:{outcome:{ref:'item.not_allowed'}}},
   {...task,ref:'refs/heads/main'},
 ]){
  const bad=structuredClone(source);
  bad.steps[0]!.template!.steps[0]!.with.action=invalid as typeof task;
  await assert.rejects(()=>compilePlan(bad));
 }
 const oversized=structuredClone(source);
 oversized.steps[0]!.max_items=9;
 await assert.rejects(()=>compilePlan(oversized));
});

test('foreach Task accepts exact current-item refs with immutable reviewed identity',async()=>{
 const task={...action,type:'task' as const,inputs:{outcome:{ref:'item.value'}}};
 const definition={version:1,name:'Dynamic Task inputs',inputs:{items:['success','failure']},
  steps:[{id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
   template:{steps:[{id:'task',uses:'github.run',with:{capability:'github.action',action:task}}]}}]};
 const {plan,digest}=await compilePlan(definition);
 assert.equal(digest,(await compilePlan(JSON.stringify(definition))).digest);
 assert.deepEqual((publishedGitHubActionStep(plan,'each_0_task')!.with.action as typeof task).inputs,
  {outcome:{ref:'item.value'}});
 for(const bad of [{ref:'item.value.__proto__'},{ref:'steps.other.output'},
  {ref:'item.index.other'}, {and:[{ref:'item.value'}]},['success']]){
  const cloned=structuredClone(definition);
  cloned.steps[0]!.template.steps[0]!.with.action.inputs={outcome:bad} as never;
  await assert.rejects(()=>compilePlan(cloned),/unsupported_foreach_inputs|invalid_reference/);
 }
});

test('source-reviewed types, choice membership and required fields apply before any Task POST',()=>{
 const contract={name:'Pinned Task',type:'task' as const,inputs:{
  outcome:{type:'choice' as const,required:true,options:['success','failure'],default:'success'},
  enabled:{type:'boolean' as const,required:false,default:false},
  attempts:{type:'number' as const,required:false,default:1},
 }};
 const template={outcome:{ref:'item.value.outcome'},enabled:{ref:'item.value.enabled'},
  attempts:{ref:'item.index'}};
 assert.ok(validateForeachTaskInputTemplate(contract,template));
 assert.deepEqual({...checkedFrozenTaskInputs(contract,
  {outcome:'success',enabled:true,attempts:2})},
  {outcome:'success',enabled:'true',attempts:'2'});
 for(const values of [
  {outcome:'unknown',enabled:true,attempts:1},
  {outcome:'success',enabled:'true',attempts:1},
  {outcome:'success',enabled:true,attempts:'1'},
  {outcome:'success',enabled:true,attempts:null},
  {outcome:'success',enabled:true,attempts:1,attempt_id:'forged'},
 ])assert.throws(()=>checkedFrozenTaskInputs(contract,values));
 assert.throws(()=>validateForeachTaskInputTemplate(contract,
  {outcome:{ref:'inputs.other'}}));
 assert.throws(()=>validateForeachTaskInputTemplate(contract,
  {outcome:{eq:[{ref:'item.value'},'success']}}));
});

test('Published Task input contract must hash exactly to reviewed grant',async()=>{
 const contract={name:'Pinned task',type:'task' as const,inputs:{
  outcome:{type:'choice' as const,required:true,options:['success','failure'],default:'success'},
 }};
 const identity={repository:'lirtual/session-actions',repositoryId:123,workflowId:456,
  workflowPath:'.github/workflows/task.yml',commitSha:'a'.repeat(40)};
 const reviewed=await reviewedGitHubAction({...identity,contract});
 const definition={version:1,name:'reviewed dynamic',steps:[
  {id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
   template:{steps:[{id:'task',uses:'github.run',
    with:{capability:'github.action',action:{...reviewed,ref:'refs/tags/test-v1',
     inputs:{outcome:{ref:'item.value'}}}}}]}}]};
 const plan=(await compilePlan(definition)).plan;
 plan.github_execution_approved=true;plan.github_action_approvals=[reviewed];
 plan.github_dynamic_input_contracts={each:contract};
 const controller=plan.steps.find(s=>s.id==='each')!;
 assert.deepEqual(await reviewedForeachTaskContract(plan,controller),contract);
 plan.github_dynamic_input_contracts={each:{...contract,name:'different source'}};
 await assert.rejects(()=>reviewedForeachTaskContract(plan,controller),/contract_changed/);
 assert.match(await frozenTaskInputDigest({outcome:'success'}),/^[0-9a-f]{64}$/);
 assert.notEqual(await frozenTaskInputDigest({outcome:'success'}),
   await frozenTaskInputDigest({outcome:'failure'}));
});

test('strict three-stage emit Task emit reserves exact identities and preserves literal grants',async()=>{
 const task={...action,type:'task' as const,inputs:{outcome:'success'}};
 const source={version:1,name:'Fixed reviewed Task pipeline',inputs:{items:['a','b']},
  steps:[{id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
   template:{steps:[
    {id:'prepare',uses:'result.emit',with:{data:{ref:'item.value'}}},
    {id:'verify',uses:'github.run',with:{capability:'github.action',action:task}},
    {id:'finish',uses:'result.emit',with:{data:{ref:'steps.verify.output'}}},
   ]}},
   {id:'done',uses:'result.emit',needs:['each'],with:{data:{ref:'steps.each.output'}}}]};
 const {plan,digest}=await compilePlan(source);
 assert.equal(digest,(await compilePlan(JSON.stringify(source))).digest);
 const each=plan.steps.find(s=>s.id==='each')!;
 assert.equal((each.with.templates as unknown[]).length,3);
 for(const i of [0,1]){
  const found=publishedGitHubActionStep(plan,'each_'+i+'_verify');
  assert.equal(found?.uses,'github.run');
  assert.deepEqual(found?.with.action,task);
 }
 for(const id of ['each_0_prepare','each_0_finish','each_2_verify',
  'each_0_verify_extra','each_0_verify_','done'])
  assert.equal(publishedGitHubActionStep(plan,id),undefined,id);
 for(const mutate of [
  (v:any)=>{v.steps[0].template.steps[1].with.action.type='session';},
  (v:any)=>{v.steps[0].template.steps[1].with.action.inputs={outcome:{ref:'item.value'}};},
  (v:any)=>{v.steps[0].template.steps[0]=structuredClone(v.steps[0].template.steps[1]);},
  (v:any)=>{v.steps[0].template.steps[2]=structuredClone(v.steps[0].template.steps[1]);},
  (v:any)=>{v.steps[0].template.steps.splice(1,0,v.steps[0].template.steps[1]);},
  (v:any)=>{v.steps[0].template.steps[1].with.capability='github.shell';},
 ]){
  const bad=structuredClone(source);mutate(bad);
  await assert.rejects(()=>compilePlan(bad));
 }
 const budget=structuredClone(source);
 budget.steps[0]!.max_items=8;
 budget.steps.push({...structuredClone(source.steps[0]!),id:'again'} as never);
 await assert.rejects(()=>compilePlan(budget),/invalid_step_count/);
});

test('mixed ordered read-only MCP and one literal Task compile with exact pinned child IDs',async()=>{
 const task={...action,type:'task' as const,inputs:{outcome:'success'}};
 const read={id:'read',uses:'mcp.call',with:{
  endpoint:'https://mcp.lirtual.dpdns.org/mcp',tool:'echo',scope:'read',
  input_schema:{type:'object',properties:{value:{type:'string'}}},
  arguments:{value:{ref:'item.value'}},
 }};
 const source={version:1,name:'Mixed approved external sequence',inputs:{items:['a','b']},
  steps:[{id:'each',flow:'foreach',items:{ref:'inputs.items'},max_items:2,
   template:{steps:[
    {id:'prepare',uses:'result.emit',with:{data:{ref:'item.value'}}},
    read,
    {id:'verify',uses:'github.run',with:{capability:'github.action',action:task}},
    {id:'finish',uses:'result.emit',with:{data:{ref:'steps.verify.output'}}},
   ]}}]};
 const {plan}=await compilePlan(source);
 assert.deepEqual((plan.steps[0]!.with.templates as Array<{uses:string}>).map(x=>x.uses),
  ['result.emit','mcp.call','github.run','result.emit']);
 assert.equal(publishedGitHubActionStep(plan,'each_1_verify')?.uses,'github.run');
 assert.equal(publishedGitHubActionStep(plan,'each_1_read'),undefined);
 const taskFirst=structuredClone(source);
 taskFirst.steps[0]!.template.steps=[
  taskFirst.steps[0]!.template.steps[2]!,
  taskFirst.steps[0]!.template.steps[3]!,
 ] as never;
 assert.equal(publishedGitHubActionStep((await compilePlan(taskFirst)).plan,'each_0_verify')?.uses,'github.run');
 const forbidden=structuredClone(source);
 forbidden.steps[0]!.template.steps[1]=structuredClone(forbidden.steps[0]!.template.steps[2]);
 await assert.rejects(()=>compilePlan(forbidden),/unsupported_foreach_action/);
 const writes=structuredClone(source);
 writes.steps[0]!.template.steps[1]!.with.scope='write';
 await assert.rejects(()=>compilePlan(writes),/unsupported_operation_scope/);
 const dynamic=structuredClone(source);
 dynamic.steps[0]!.template.steps[2]!.with.action.inputs={outcome:{ref:'item.value'}};
 await assert.rejects(()=>compilePlan(dynamic),/unsupported_foreach_inputs/);
});
