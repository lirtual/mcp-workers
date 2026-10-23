import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectGitHubActionRun } from '../src/github-action-run-inspection.ts';
import type { ReviewedGitHubAction } from '../src/github-action-review.ts';
const action:ReviewedGitHubAction={repository:'lirtual/session-actions',repositoryId:123,workflowId:3,workflowPath:'.github/workflows/linux.yml',commitSha:'a'.repeat(40),type:'session',contractDigest:'b'.repeat(64)};
const physical={id:999,run_attempt:1,repository:{id:123,full_name:action.repository},path:action.workflowPath,head_sha:action.commitSha,event:'workflow_dispatch',status:'completed',conclusion:'success'};
test('reads pinned physical GitHub Run and confirms real terminal success',async()=>{
 let requests=0;
 const result=await inspectGitHubActionRun(action,999,1,'test',async req=>{
  requests++;
  assert.equal(new URL(req.url).pathname,'/repos/lirtual/session-actions/actions/runs/999');
  assert.equal(req.method,'GET'); assert.equal(req.redirect,'manual');
  return Response.json(physical);
 });
 assert.deepEqual(result,{state:'completed',conclusion:'success'}); assert.equal(requests,1);
});
test('GitHub uncertainty never becomes success or triggers automatic retry',async()=>{
 for(const http of [async()=>new Response('',{status:403}),async()=>{throw Error('network');},async()=>new Response('{broken')]){
  let requests=0;
  const result=await inspectGitHubActionRun(action,999,1,'test',async(req)=>{requests++;return http();});
  assert.deepEqual(result,{state:'unknown'}); assert.equal(requests,1);
 }
});
test('readback rejects mismatched physical identity and rerun',async()=>{
 const result=await inspectGitHubActionRun(action,999,1,'test',async()=>Response.json({...physical,run_attempt:2}));
 assert.deepEqual(result,{state:'identity_mismatch'});
});
test('never queries GitHub with invalid run ID or missing credential',async()=>{
 await assert.rejects(inspectGitHubActionRun(action,0,1,'token'),/inspection_invalid/);
 await assert.rejects(inspectGitHubActionRun(action,999,1,''),/inspection_invalid/);
});
