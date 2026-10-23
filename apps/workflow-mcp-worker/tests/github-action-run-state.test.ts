import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileGitHubPhysicalRun } from '../src/github-action-run-state.ts';
import type { ReviewedGitHubAction } from '../src/github-action-review.ts';

const action: ReviewedGitHubAction = {
  repository:'lirtual/session-actions',repositoryId:123,workflowId:14,
  workflowPath:'.github/workflows/linux.yml',commitSha:'a'.repeat(40),
  type:'session',contractDigest:'b'.repeat(64),
};
const ref='refs/tags/test-v1';
const physical = {
  id:999,workflow_id:action.workflowId,run_attempt:1,repository:{id:123,full_name:action.repository},
  path:action.workflowPath+'@test-v1',head_sha:action.commitSha,event:'workflow_dispatch',
  status:'in_progress',conclusion:null,
};
test('dispatch ACK and active GitHub Run do not imply terminal success',()=>{
  assert.deepEqual(reconcileGitHubPhysicalRun(action,999,1,physical,ref),{state:'running'});
  assert.deepEqual(reconcileGitHubPhysicalRun(action,999,1,{...physical,status:'queued'},ref),{state:'queued'});
  assert.deepEqual(reconcileGitHubPhysicalRun(action,999,1,{...physical,status:'completed',conclusion:'success'},ref),
    {state:'completed',conclusion:'success'});
});
test('cancel requires GitHub terminal confirmation',()=>{
  assert.deepEqual(reconcileGitHubPhysicalRun(action,999,1,{...physical,status:'in_progress'},ref),{state:'running'});
  assert.deepEqual(reconcileGitHubPhysicalRun(action,999,1,{...physical,status:'completed',conclusion:'cancelled'},ref),
    {state:'completed',conclusion:'cancelled'});
  assert.deepEqual(reconcileGitHubPhysicalRun(action,999,1,{...physical,status:'completed',conclusion:null},ref),
    {state:'unknown'});
});
test('rejects any physical run identity drift, rerun or unrelated event',()=>{
  for(const changed of [
    {...physical,id:1000},{...physical,run_attempt:2},{...physical,workflow_id:999},
    {...physical,head_sha:'c'.repeat(40)},{...physical,path:'.github/workflows/other.yml@tag'},
    {...physical,path:action.workflowPath+'@another-tag'},
    {...physical,repository:{id:999,full_name:action.repository}},
    {...physical,event:'push'},
  ]) assert.deepEqual(reconcileGitHubPhysicalRun(action,999,1,changed,ref),{state:'identity_mismatch'});
});

test('GitHub REST path must name the same reviewed tag, never a bare or foreign workflow',()=>{
 for(const path of [action.workflowPath,action.workflowPath+'@main',action.workflowPath+'@other-v1'])
  assert.deepEqual(reconcileGitHubPhysicalRun(action,999,1,{...physical,path},ref),{state:'identity_mismatch'});
 assert.deepEqual(reconcileGitHubPhysicalRun(action,999,1,{...physical,path:action.workflowPath+'@'+ref},ref),{state:'running'});
});
