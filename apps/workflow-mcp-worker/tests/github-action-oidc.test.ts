import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPinnedActionRunIdentity } from '../src/github-dispatch.ts';

const expected = {
  repository:'lirtual/session-actions',repositoryId:'123456',
  workflowRef:'lirtual/session-actions/.github/workflows/linux.yml@refs/tags/reviewed',
  ref:'refs/tags/reviewed',commitSha:'a'.repeat(40),runId:12345,runAttempt:1,
};
const verified = {
  repository:expected.repository,repository_id:expected.repositoryId,
  workflow_ref:expected.workflowRef,ref:expected.ref,sha:expected.commitSha,
  run_id:'12345',run_attempt:'1',event_name:'workflow_dispatch',
};
test('accepts fully pinned GitHub-signed Action run identity',()=>{
  assert.equal(matchPinnedActionRunIdentity(verified,expected),true);
});
test('rejects a changed SHA, repository identity, run attempt or event',()=>{
  for(const claims of [
    {...verified,sha:'b'.repeat(40)},
    {...verified,repository_id:'654321'},
    {...verified,run_attempt:'2'},
    {...verified,run_id:'99999'},
    {...verified,event_name:'workflow_run'},
    {...verified,workflow_ref:'lirtual/session-actions/.github/workflows/other.yml@refs/tags/reviewed'},
  ]) assert.equal(matchPinnedActionRunIdentity(claims,expected),false);
});
test('rejects invalid expected pinned SHA and repository ID',()=>{
  assert.equal(matchPinnedActionRunIdentity(verified,{...expected,commitSha:'main'}),false);
  assert.equal(matchPinnedActionRunIdentity(verified,{...expected,repositoryId:'abc'}),false);
});
