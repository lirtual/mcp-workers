import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPersistedGitHubActionAttempt } from '../src/github-action-attempt-inspection.ts';
import type { ReviewedGitHubAction } from '../src/github-action-review.ts';

const attempt='11111111-1111-4111-8111-111111111111';
const grant:ReviewedGitHubAction={repository:'lirtual/github-actions',repositoryId:12,workflowId:34,
 workflowPath:'.github/workflows/linux.yml',commitSha:'a'.repeat(40),type:'session',contractDigest:'b'.repeat(64)};
const plan={github_execution_approved:true,github_action_approvals:[grant],
 steps:[{id:'start',uses:'github.run',with:{capability:'github.action',action:{...grant,ref:'refs/tags/test-v1',inputs:{duration_minutes:5}}}}]};
const row={attempt_id:attempt,run_id:'run',step_id:'start',state:'confirmed',capability_id:'github.action',
 owner_run_id:null as number|null,owner_run_attempt:null as number|null,
 repository:grant.repository,repository_id:String(grant.repositoryId),
 workflow_ref:grant.repository+'/'+grant.workflowPath+'@refs/tags/test-v1',ref:'refs/tags/test-v1',
 candidate_run_id:99,candidate_run_attempt:1,plan:JSON.stringify(plan),run_outcome:'running'};
function db(data:(Omit<typeof row,'candidate_run_id'> & {candidate_run_id:number|null})|null){
 return {prepare:(sql:string)=>({bind:(...args:string[])=>({first:async()=>{
  if(sql.includes('FROM session_executions')){
   assert.deepEqual(args,[row.run_id,row.step_id]);
   return null; // No live Session can extend a completed parent.
  }
  assert.deepEqual(args,[attempt]);
  return data;
 }})})} as any;
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
  {...row,capability_id:'github.workflow.check'},
  {...row,state:'claimed',owner_run_id:100,owner_run_attempt:1},
  {...row,state:'claimed',owner_run_id:99,owner_run_attempt:2},
  {...row,state:'succeeded',owner_run_id:null,owner_run_attempt:null},
  {...row,state:'succeeded',owner_run_id:100,owner_run_attempt:1},
  {...row,state:'succeeded',owner_run_id:99,owner_run_attempt:2},
  {...row,repository:'attacker/other'},
  {...row,repository_id:'999'},
  {...row,workflow_ref:'lirtual/github-actions/.github/workflows/other.yml@refs/heads/main'},
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

test('already-settled Task remains inspectable after external physical reconciliation',async()=>{
 const data={...row,state:'succeeded',owner_run_id:99,owner_run_attempt:1};
 const observed=await inspectPersistedGitHubActionAttempt(db(data),attempt,'token',
   async()=>({state:'completed',conclusion:'success'}));
 assert.deepEqual(observed,{state:'completed',conclusion:'success'});
});
test('claimed owner with exact candidate may be inspected',async()=>{
 const data={...row,state:'claimed',owner_run_id:99,owner_run_attempt:1};
 assert.deepEqual(await inspectPersistedGitHubActionAttempt(db(data),attempt,'token',async()=>({state:'running'})),{state:'running'});
});
