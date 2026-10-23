import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,SignJWT} from 'jose';
import {verifyAndClaimPinnedGitHubAction} from '../src/github-action-oidc-claim.ts';

const attemptId='11111111-1111-4111-8111-111111111111';
const sha='a'.repeat(40);
const action={repository:'lirtual/session-actions',repositoryId:123,workflowId:12,
 workflowPath:'.github/workflows/linux.yml',commitSha:sha,type:'session',contractDigest:'b'.repeat(64)};
const plan={github_execution_approved:true,github_action_approvals:[action],
 steps:[{id:'linux',uses:'github.run',with:{capability:'github.action',action:{...action,inputs:{duration_minutes:5}}}}]};
const audience='workflow-github-action-claim';
const base={repository:'lirtual/session-actions',repository_id:'123',
 workflow_ref:'lirtual/session-actions/.github/workflows/linux.yml@refs/heads/main',
 ref:'refs/heads/main',sha,event_name:'workflow_dispatch',run_id:'42',run_attempt:'1'};
const row={run_id:'run',step_id:'linux',state:'confirmed',capability_id:'github.action',
 repository:'lirtual/session-actions',repository_id:'123',
 workflow_ref:base.workflow_ref,ref:base.ref,
 candidate_run_id:42,candidate_run_attempt:1,
 owner_run_id:null,owner_run_attempt:null,run_outcome:'running',plan:JSON.stringify(plan)};
function db(value:typeof row|null){
 let writes=0;
 return {db:{prepare:(sql:string)=>({bind:(..._args:unknown[])=>({
  first:async()=>value,
  run:async()=>{writes++;assert.match(sql,/state='confirmed'/);return {meta:{changes:1}};},
 })})} as any,writes:()=>writes};
}
test('valid signed exact physical GitHub candidate acquires D1 owner once',async()=>{
 const {privateKey,publicKey}=await generateKeyPair('RS256');
 const make=async(fields:Record<string,unknown>)=>new SignJWT(fields)
  .setProtectedHeader({alg:'RS256'}).setIssuer('https://token.actions.githubusercontent.com')
  .setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const signed=await make(base);
 const good=db(row);
 assert.equal(await verifyAndClaimPinnedGitHubAction(good.db,attemptId,signed,audience,publicKey),true);
 assert.equal(good.writes(),1);
 for(const field of ['sha','run_id','repository_id','workflow_ref']){
  const wrong=db(row);
  const changed=await make({...base,[field]:'different'});
  assert.equal(await verifyAndClaimPinnedGitHubAction(wrong.db,attemptId,changed,audience,publicKey),false);
  assert.equal(wrong.writes(),0);
 }
 const unapproved=db({...row,plan:JSON.stringify({...plan,github_action_approvals:[]})});
 assert.equal(await verifyAndClaimPinnedGitHubAction(unapproved.db,attemptId,signed,audience,publicKey),false);
});
test('terminal parent and unconfirmed Attempt are refused before signing verification',async()=>{
 const invalid=db({...row,run_outcome:'cancelled'});
 assert.equal(await verifyAndClaimPinnedGitHubAction(invalid.db,attemptId,'invalid',audience),false);
 assert.equal(invalid.writes(),0);
});
