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
   {...task,type:'session'},{...task,inputs:{outcome:{ref:'item.value'}}},
   {...task,inputs:{outcome:{ref:'inputs.items'}}},
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
