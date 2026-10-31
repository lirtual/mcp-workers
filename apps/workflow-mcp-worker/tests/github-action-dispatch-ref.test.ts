import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyActionDispatchRef} from '../src/github-action-dispatch-ref.ts';
import type {ReviewedGitHubAction} from '../src/github-action-review.ts';
const action:ReviewedGitHubAction={repository:'lirtual/github-actions',repositoryId:123,workflowId:5,workflowPath:'.github/workflows/linux.yml',commitSha:'a'.repeat(40),type:'session',contractDigest:'b'.repeat(64)};
test('approved ref must resolve to reviewed SHA, without redirect or mutation',async()=>{
 let calls=0;
 const result=await verifyActionDispatchRef(action,'refs/heads/main','token',async req=>{
  calls++;assert.equal(req.method,'GET');assert.equal(req.redirect,'manual');
  assert.equal(new URL(req.url).pathname,'/repos/lirtual/github-actions/git/ref/heads/main');
  return Response.json({ref:'refs/heads/main',object:{type:'commit',sha:action.commitSha}});
 });
 assert.deepEqual(result,{ref:'refs/heads/main',sha:action.commitSha});assert.equal(calls,1);
});
test('moved branch or annotated tag does not authorize dispatch',async()=>{
 for(const object of [{type:'commit',sha:'c'.repeat(40)},{type:'tag',sha:action.commitSha}]){
  await assert.rejects(verifyActionDispatchRef(action,'refs/tags/release','token',
   async()=>Response.json({ref:'refs/tags/release',object})),/github_action_ref_mismatch/);
 }
});
test('errors and invalid refs fail closed without retry',async()=>{
 await assert.rejects(verifyActionDispatchRef(action,'refs/heads/../other','token'),/ref_invalid/);
 let count=0;
 await assert.rejects(verifyActionDispatchRef(action,'refs/heads/main','token',async()=>{
  count++;return new Response('missing',{status:404});
 }),/ref_unconfirmed/);
 assert.equal(count,1);
});
