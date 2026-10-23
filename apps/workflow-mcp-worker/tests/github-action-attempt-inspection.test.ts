import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPersistedGitHubActionAttempt } from '../src/github-action-attempt-inspection.ts';
import type { ReviewedGitHubAction } from '../src/github-action-review.ts';

const attempt='11111111-1111-4111-8111-111111111111';
const grant:ReviewedGitHubAction={repository:'lirtual/session-actions',repositoryId:12,workflowId:34,
 workflowPath:'.github/workflows/linux.yml',commitSha:'a'.repeat(40),type:'session',contractDigest:'b'.repeat(64)};
const plan={github_execution_approved:true,github_action_approvals:[grant],
 steps:[{id:'start',uses:'github.run',with:{capability:'github.action',action:{...grant,inputs:{duration_minutes:5}}}}]};
const row={attempt_id:attempt,run_id:'run',step_id:'start',state:'confirmed',
 candidate_run_id:99,candidate_run_attempt:1,plan:JSON.stringify(plan),run_outcome:'running'};
function db(data:typeof row|null){
 return {prepare:(_sql:string)=>({bind:(id:string)=>({first:async()=>{assert.equal(id,attempt);return data;}})})} as any;
}
const result={state:'running'} as const;
test('reads durable candidate and exactly approved immutable published grant',async()=>{
 let calls=0;
 const inspected=await inspectPersistedGitHubActionAttempt(db(row),attempt,'token',async(action,id,attemptNum)=>{
  calls++;assert.deepEqual(action,grant);assert.equal(id,99);assert.equal(attemptNum,1);return result;
 });
 assert.deepEqual(inspected,result);assert.equal(calls,1);
});
test('rejects missing candidate, missing publication approval and terminal Run before network',async()=>{
 for(const changed of [
  {...row,state:'created'},
  {...row,candidate_run_id:null},
  {...row,run_outcome:'cancelled'},
  {...row,plan:JSON.stringify({...plan,github_action_approvals:[]})},
  {...row,plan:JSON.stringify({...plan,github_execution_approved:false})},
  {...row,plan:'broken'},
 ]){
  const inspected=await inspectPersistedGitHubActionAttempt(db(changed),attempt,'token',async()=>{throw Error('must not inspect');});
  assert.deepEqual(inspected,{state:'unknown'});
 }
});
