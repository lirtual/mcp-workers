import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchReviewedGitHubAction} from '../src/github-action-dispatch.ts';
import type {ReviewedGitHubAction} from '../src/github-action-review.ts';
const action:ReviewedGitHubAction={repository:'lirtual/github-actions',repositoryId:12,workflowId:34,workflowPath:'.github/workflows/linux.yml',commitSha:'a'.repeat(40),type:'session',contractDigest:'b'.repeat(64)};
const attempt={attemptId:'11111111-1111-4111-8111-111111111111',dispatchId:'22222222-2222-4222-8222-222222222222'};
const valid=()=>Response.json({ref:'refs/heads/main',object:{type:'commit',sha:action.commitSha}});
test('ref verification precedes one single dispatch with server identity',async()=>{
 const requests:Request[]=[];
 const outcome=await dispatchReviewedGitHubAction(action,'refs/heads/main','token',attempt,{duration_minutes:'5'},async req=>{
  requests.push(req);
  if(req.method==='GET')return valid();
  const payload=await req.json() as any;
  assert.equal(payload.ref,'main');
  assert.equal(payload.inputs.capability_id,'github.action');
  assert.equal(payload.inputs.duration_minutes,'5');
  assert.equal(payload.inputs.attempt_id,attempt.attemptId);
  return Response.json({workflow_run_id:91});
 });
 assert.deepEqual(outcome,{status:'confirmed',runId:91,runAttempt:1});
 assert.deepEqual(requests.map(r=>r.method),['GET','POST']);
});
test('ref drift prevents any POST',async()=>{
 let count=0;
 await assert.rejects(dispatchReviewedGitHubAction(action,'refs/heads/main','token',attempt,{},async()=>{
  count++;return Response.json({ref:'refs/heads/main',object:{type:'commit',sha:'c'.repeat(40)}});
 }),/github_action_ref_mismatch/);
 assert.equal(count,1);
});
test('network ambiguity after POST is never automatically retried',async()=>{
 let count=0;
 const result=await dispatchReviewedGitHubAction(action,'refs/heads/main','token',attempt,{},async req=>{
  count++;if(req.method==='GET')return valid();throw Error('timeout');
 });
 assert.deepEqual(result,{status:'dispatch_unknown'});assert.equal(count,2);
});
test('reserved caller input and invalid IDs reject before network',async()=>{
 for(const inputs of [{attempt_id:'forged'},{workflow_secret:'x'}] as Record<string,string>[]){
  await assert.rejects(dispatchReviewedGitHubAction(action,'refs/heads/main','token',attempt,inputs),/dispatch_invalid/);
 }
});
