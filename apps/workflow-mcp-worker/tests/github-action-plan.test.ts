import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePlan } from '../src/plan.ts';

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
