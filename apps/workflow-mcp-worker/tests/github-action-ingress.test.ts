import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,SignJWT} from 'jose';
import {handleGithubActionClaimRequest} from '../src/github-action-ingress.ts';
import type {Env} from '../src/store.ts';

const url='https://workflow.example.org/github/action/claim';
const attemptId='11111111-1111-4111-8111-111111111111';
const audience='workflow-github-action:production';
const ref='refs/tags/test-v1';
const sha='a'.repeat(40);
const repo='lirtual/session-actions';
const workflowRef=repo+'/.github/workflows/linux.yml@'+ref;
const action={repository:repo,repositoryId:123,workflowId:45,
 workflowPath:'.github/workflows/linux.yml',commitSha:sha,
 type:'session',contractDigest:'b'.repeat(64)};
const plan={github_execution_approved:true,github_action_approvals:[action],
 steps:[{id:'linux',uses:'github.run',with:{capability:'github.action',action:{...action,ref,inputs:{duration_minutes:5}}}}]};
const claims={repository:repo,repository_id:'123',workflow_ref:workflowRef,
 ref,sha,run_id:'42',run_attempt:'1',event_name:'workflow_dispatch'};
const row={run_id:'run',step_id:'linux',state:'confirmed',capability_id:'github.action',
 repository:repo,repository_id:'123',workflow_ref:workflowRef,ref,
 candidate_run_id:42,candidate_run_attempt:1,
 owner_run_id:null,owner_run_attempt:null,run_outcome:'running',plan:JSON.stringify(plan)};
function setup(state=row){
 let calls=0,writes=0;
 const database={prepare:(_sql:string)=>({bind:(..._args:unknown[])=>({
  first:async()=>{calls++;return state;},
  run:async()=>{writes++;return {meta:{changes:1}};},
 })})} as unknown as D1Database;
 return {env:{DB:database,GITHUB_ACTION_OIDC_AUDIENCE:audience} as Env,
  calls:()=>calls,writes:()=>writes};
}
const request=(token:string,body:string=JSON.stringify({attemptId}))=>
 new Request(url,{method:'POST',headers:{authorization:'Bearer '+token},body});

test('isolated Action route requires configured server audience and strict request shape',async()=>{
 const fixture=setup();
 assert.equal((await handleGithubActionClaimRequest(new Request(url,{method:'GET'}),fixture.env)).status,405);
 assert.equal((await handleGithubActionClaimRequest(new Request(url,{method:'POST'}),{
  ...fixture.env,GITHUB_ACTION_OIDC_AUDIENCE:undefined,
 })).status,503);
 assert.equal((await handleGithubActionClaimRequest(new Request(url,{method:'POST'}),fixture.env)).status,401);
 assert.equal((await handleGithubActionClaimRequest(request('x',JSON.stringify({
  attemptId,repository:repo,
 })),fixture.env)).status,400);
 assert.equal((await handleGithubActionClaimRequest(request('x','x'.repeat(8193)),fixture.env)).status,413);
 // The declared length is not trusted; the streamed bytes enforce the cap.
 const undeclared=new Request(url,{method:'POST',
  headers:{authorization:'Bearer x','content-length':'1'},body:'x'.repeat(8193)});
 assert.equal((await handleGithubActionClaimRequest(undeclared,fixture.env)).status,413);
 assert.equal((await handleGithubActionClaimRequest(new Request(
  'https://workflow.example.org/github/claim',{method:'POST'},
 ),fixture.env)).status,404);
 assert.equal((await handleGithubActionClaimRequest(new Request(
  'https://workflow.example.org/github/action/result',{
   method:'POST',headers:{authorization:'Bearer x'},body:JSON.stringify({attemptId})
  }),fixture.env)).status,400);
 assert.equal((await handleGithubActionClaimRequest(new Request(
  'https://workflow.example.org/github/action/result',{
   method:'POST',headers:{authorization:'Bearer x'},body:JSON.stringify({attemptId,result:{large:'a'.repeat(6000)}})
  }),fixture.env)).status,400);
 assert.equal(fixture.calls(),0);
});
test('a signed pinned GitHub OIDC job can claim exactly its D1 candidate',async()=>{
 const {privateKey,publicKey}=await generateKeyPair('RS256');
 const make=async(payload:Record<string,unknown>,aud=audience)=>
  new SignJWT(payload).setProtectedHeader({alg:'RS256'})
  .setIssuer('https://token.actions.githubusercontent.com')
  .setAudience(aud).setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const signed=await make(claims);
 const good=setup();
 const accepted=await handleGithubActionClaimRequest(request(signed),good.env,publicKey);
 assert.equal(accepted.status,200);
 assert.deepEqual(await accepted.json(),{result:'claimed'});
 assert.equal(good.writes(),1);
 for(const [payload,aud] of [
  [{...claims,sha:'c'.repeat(40)},audience],
  [{...claims,run_id:'43'},audience],
  [claims,'workflow-github-other:production'],
 ] as [Record<string,unknown>,string][]){
  const f=setup();
  const invalid=await handleGithubActionClaimRequest(request(await make(payload,aud)),f.env,publicKey);
  assert.equal(invalid.status,403);
  assert.equal(f.writes(),0);
 }
 const wrongApproval=setup({...row,plan:JSON.stringify({...plan,github_action_approvals:[]})});
 assert.equal((await handleGithubActionClaimRequest(request(signed),wrongApproval.env,publicKey)).status,403);
 assert.equal(wrongApproval.writes(),0);
});
