import test from 'node:test';
import assert from 'node:assert/strict';
import {readWorkflowGitHubExecutor,isCurrentWorkflowGitHubAction} from '../src/workflow-github-executor.ts';
const current={repository:'alternate-owner/executor',repositoryId:88801,ciWorkflowId:7701};
test('deployed executor has one exact verified name, ID and CI ID',()=>{
  const identity=readWorkflowGitHubExecutor(JSON.stringify(current));
  assert.deepEqual(identity,current);
  assert.equal(isCurrentWorkflowGitHubAction(identity,{repository:current.repository,repositoryId:88801}),true);
  assert.equal(isCurrentWorkflowGitHubAction(identity,{repository:'lirtual/github-actions',repositoryId:1430925009}),false);
  assert.equal(isCurrentWorkflowGitHubAction(identity,{repository:current.repository,repositoryId:1430925009}),false);
});
test('untrusted or missing release identity cannot authorize a new executor',()=>{
  for(const bad of [undefined,'','{}','[]','[]\n',JSON.stringify({...current,repository:'x/y/z'}),
    JSON.stringify({...current,repositoryId:0}),
    JSON.stringify({...current,ciWorkflowId:-1}),
    JSON.stringify({...current,extra:'x'}),
    JSON.stringify({repository:'x/y',repositoryId:10})]){
    const parsed=readWorkflowGitHubExecutor(bad);
    assert.equal(parsed,null);
    assert.equal(isCurrentWorkflowGitHubAction(parsed,{repository:'x/y',repositoryId:10}),false);
  }
});
