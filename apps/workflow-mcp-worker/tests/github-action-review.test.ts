import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedGitHubAction, assertReviewedGitHubAction, isPublishedGitHubActionApproved } from '../src/github-action-review.ts';
import type { GitHubActionSource } from '../src/github-action-discovery.ts';

const source: GitHubActionSource = {
  repository:'lirtual/github-actions',repositoryId:123,workflowId:456,
  workflowPath:'.github/workflows/linux.yml',commitSha:'a'.repeat(40),
  contract:{name:'Linux',type:'session',inputs:{
    duration_minutes:{type:'number',required:false,default:10},
  }},
};
const allow = JSON.stringify([{repository:source.repository,repositoryId:source.repositoryId,commitSha:source.commitSha}]);

test('repository enrollment is stable while each reviewed publication pins a new commit',async()=>{
  const current={...source,commitSha:'c'.repeat(40)};
  const reviewed=await reviewedGitHubAction(current);
  assert.deepEqual({...await assertReviewedGitHubAction(reviewed,current,allow,{duration_minutes:5})},
    {duration_minutes:'5'});
  await assert.rejects(assertReviewedGitHubAction(reviewed,source,allow,{}),/review_changed/);
});
test('review identity verifies repository and native contract, returning only validated inputs',async()=>{
  const reviewed = await reviewedGitHubAction(source);
  assert.equal(reviewed.contractDigest.length,64);
  assert.deepEqual({...await assertReviewedGitHubAction(reviewed,source,allow,{duration_minutes:5})},{duration_minutes:'5'});
});
test('changed revision, workflow, native contract or repository approval are rejected',async()=>{
  const reviewed = await reviewedGitHubAction(source);
  await assert.rejects(assertReviewedGitHubAction(reviewed,source,undefined,{}),/not_approved/);
  await assert.rejects(assertReviewedGitHubAction(reviewed,{...source,commitSha:'b'.repeat(40)},allow,{}),/review_changed/);
  await assert.rejects(assertReviewedGitHubAction(reviewed,{...source,workflowId:777},allow,{}),/review_changed/);
  await assert.rejects(assertReviewedGitHubAction(reviewed,{...source,contract:{...source.contract,name:'Changed'}},allow,{}),/review_changed/);
});
test('review cannot override protected identity or exceed session duration',async()=>{
  const reviewed = await reviewedGitHubAction(source);
  await assert.rejects(assertReviewedGitHubAction(reviewed,source,allow,{attempt_id:'forged'}),/unknown_input/);
  await assert.rejects(assertReviewedGitHubAction(reviewed,source,allow,{duration_minutes:331}),/invalid_duration/);
});

test('runtime authorization needs exact grant from immutable Published Plan',async()=>{
  const reviewed=await reviewedGitHubAction(source);
  assert.equal(isPublishedGitHubActionApproved(undefined,reviewed),false);
  assert.equal(isPublishedGitHubActionApproved([],reviewed),false);
  assert.equal(isPublishedGitHubActionApproved([reviewed],reviewed),true);
  assert.equal(isPublishedGitHubActionApproved([reviewed],{...reviewed,commitSha:'b'.repeat(40)}),false);
  assert.equal(isPublishedGitHubActionApproved([reviewed],{...reviewed,contractDigest:'0'.repeat(64)}),false);
  assert.equal(isPublishedGitHubActionApproved([reviewed],{...reviewed,workflowId:789}),false);
});
