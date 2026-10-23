import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileGitHubPhysicalRun } from '../src/github-action-run-state.ts';
import type { ReviewedGitHubAction } from '../src/github-action-review.ts';

const action: ReviewedGitHubAction = {
  repository:'lirtual/session-actions',repositoryId:123,workflowId:14,
  workflowPath:'.github/workflows/linux.yml',commitSha:'a'.repeat(40),
  type:'session',contractDigest:'b'.repeat(64),
};
const physical = {
  id:999,run_attempt:1,repository:{id:123,full_name:action.repository},
  path:action.workflowPath,head_sha:action.commitSha,event:'workflow_dispatch',
  status:'in_progress',conclusion:null,
};
test('dispatch ACK and active GitHub Run do not imply terminal success',()=>{
  assert.deepEqual(reconcileGitHubPhysicalRun(action,999,1,physical),{state:'running'});
  assert.deepEqual(reconcileGitHubPhysicalRun(action,999,1,{...physical,status:'queued'}),{state:'queued'});
  assert.deepEqual(reconcileGitHubPhysicalRun(action,999,1,{...physical,status:'completed',conclusion:'success'}),
    {state:'completed',conclusion:'success'});
});
test('cancel requires GitHub terminal confirmation',()=>{
  assert.deepEqual(reconcileGitHubPhysicalRun(action,999,1,{...physical,status:'in_progress'}),{state:'running'});
  assert.deepEqual(reconcileGitHubPhysicalRun(action,999,1,{...physical,status:'completed',conclusion:'cancelled'}),
    {state:'completed',conclusion:'cancelled'});
  assert.deepEqual(reconcileGitHubPhysicalRun(action,999,1,{...physical,status:'completed',conclusion:null}),
    {state:'unknown'});
});
test('rejects any physical run identity drift, rerun or unrelated event',()=>{
  for(const changed of [
    {...physical,id:1000},{...physical,run_attempt:2},
    {...physical,head_sha:'c'.repeat(40)},{...physical,path:'.github/workflows/other.yml'},
    {...physical,repository:{id:999,full_name:action.repository}},
    {...physical,event:'push'},
  ]) assert.deepEqual(reconcileGitHubPhysicalRun(action,999,1,changed),{state:'identity_mismatch'});
});
