import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectSessionJobStart, resolveSessionDeadline} from '../src/session-device-admission.ts';

const action = {
  repository:'lirtual/github-actions',repositoryId:1430925009,
  workflowId:111,workflowPath:'.github/workflows/ubuntu.yml',
  commitSha:'a'.repeat(40),type:'session' as const,contractDigest:'b'.repeat(64),
};
const job={id:7,run_id:123,head_sha:action.commitSha,name:'session',
  workflow_name:'ubuntu',status:'in_progress',started_at:'2026-10-30T00:00:00Z'};
const reply=(jobs:unknown[],total_count=jobs.length)=>new Response(JSON.stringify({total_count,jobs}),{status:200});
const http=(jobs:unknown[],total?:number)=>async (request:Request)=>{
  assert.equal(new URL(request.url).pathname,
    '/repos/lirtual/github-actions/actions/runs/123/attempts/2/jobs');
  assert.equal(request.headers.get('redirect'),null);
  return reply(jobs,total);
};
test('exact reviewed physical Attempt yields immutable GitHub job start',async()=>{
  const result=await inspectSessionJobStart(action,123,2,'server-token',http([job]),Date.parse('2026-10-30T00:30:00Z'));
  assert.equal(result,Date.parse('2026-10-30T00:00:00Z'));
});
test('job identity, uniqueness, status and timestamp ambiguity deny',async()=>{
  const now=Date.parse('2026-10-30T00:30:00Z');
  for(const [jobs,total] of [
    [[{...job,head_sha:'f'.repeat(40)}],1],[[{...job,name:'build'}],1],
    [[{...job,status:'completed'}],1],[[{...job,workflow_name:'windows'}],1],
    [[{...job,started_at:'2026-10-30T01:00:00Z'}],1],
    [[{...job,started_at:'garbage'}],1],[[{...job,run_id:124}],1],
    [[job,job],2],[[job],2], [[],0]
  ] as [unknown[],number][]) {
    assert.equal(await inspectSessionJobStart(action,123,2,'server-token',http(jobs,total),now),null);
  }
});
test('renamed repository is required; legacy name and wrong immutable repository ID fail closed',async()=>{
  let requests=0;
  const blockedHttp=async()=>{requests++;return reply([job]);};
  const now=Date.parse('2026-10-30T00:30:00Z');
  for(const invalid of [
    {...action,repository:'lirtual/session-actions'},
    {...action,repositoryId:123},
  ]) {
    assert.equal(await inspectSessionJobStart(invalid,123,2,'server-token',blockedHttp,now),null);
  }
  assert.equal(requests,0,'unapproved identity must not call GitHub');
});
test('unknown GitHub response and missing token fail closed',async()=>{
  assert.equal(await inspectSessionJobStart(action,123,2,'',http([job])),null);
  assert.equal(await inspectSessionJobStart(action,123,2,'server-token',async()=>{throw Error('timeout')}),null);
  assert.equal(await inspectSessionJobStart(action,123,2,'server-token',async()=>new Response('bad',{status:503})),null);
});
test('only explicit immutable or bound duration creates a deadline',()=>{
  const started=Date.parse('2026-10-30T00:00:00Z');
  assert.equal(resolveSessionDeadline({duration_mode:'explicit',duration_minutes:1},{}, {},started),started+60_000);
  assert.equal(resolveSessionDeadline({duration_mode:'explicit',duration_minutes:300},{}, {},started),started+300*60_000);
  assert.equal(resolveSessionDeadline({duration_mode:'explicit',duration_minutes:{ref:'inputs.duration_minutes'}},
    {duration_minutes:300},{duration_minutes:9},started),started+9*60_000);
  assert.equal(resolveSessionDeadline({duration_mode:'repository',duration_minutes:1},{}, {},started),null);
  assert.equal(resolveSessionDeadline({duration_mode:'repository',duration_minutes:300},{},{},started,4),started+4*60_000);
  assert.equal(resolveSessionDeadline({duration_mode:'repository',duration_minutes:300},{},{},started,301),null);
  assert.equal(resolveSessionDeadline({duration_mode:'explicit',duration_minutes:15},{},{},started,30),null);
  assert.equal(resolveSessionDeadline({duration_mode:'explicit',duration_minutes:{ref:'inputs.duration_minutes'}},
    {duration_minutes:300},{duration_minutes:301},started),null);
  assert.equal(resolveSessionDeadline({duration_minutes:0},{}, {},started),null);
  assert.equal(resolveSessionDeadline({duration_minutes:30},{}, {},NaN),null);
});

import {decideSessionAdmission} from '../src/session-device-authority.ts';
const attemptId='123e4567-e89b-42d3-a456-426614174000';
const baseRow={
  attempt_id:attemptId,run_id:'aabbcc',step_id:'start',state:'claimed',
  session_state:'ready',capability_id:'github.action',
  repository:action.repository,repository_id:String(action.repositoryId),
  workflow_ref:action.repository+'/'+action.workflowPath+'@refs/tags/v1',
  ref:'refs/tags/v1',candidate_run_id:123,candidate_run_attempt:2,
  owner_run_id:123,owner_run_attempt:2,
  plan:JSON.stringify({github_execution_approved:true,steps:[{id:'start',
    uses:'github.run',with:{capability:'github.action',action:{...action,ref:'refs/tags/v1',
      inputs:{duration_mode:'explicit',duration_minutes:20}}}}],
    github_action_approvals:[]}),
  run_inputs:JSON.stringify({}),run_outcome:'succeeded',rca_duration_minutes:null,
};
const fakeDb=(row:unknown)=>({prepare(_sql:string){return {
  bind(..._values:unknown[]){return {first:async()=>row};},
};}}) as any;
const goodServices={
  physical:async()=>({state:'running' as const}),
  jobStart:async()=>Date.now()-60_000,
  oidc:async()=>true,
  approval:()=>true,
};
const env=(row:unknown)=>({DB:fakeDb(row),
  WORKFLOW_GITHUB_DISPATCH_TOKEN:'server-token',
  GITHUB_ACTION_OIDC_AUDIENCE:'workflow-github-abcde'} as any);
test('current approved ready Session may admit, with a deadline fixed to the physical job start',async()=>{
  const decision=await decideSessionAdmission(env(baseRow),{attempt_id:attemptId,oidc_jwt:'signed'},goodServices);
  assert.equal(decision.allowed,true);
  if(decision.allowed) {
    assert.equal(decision.github_run_id,123);
    assert.ok(decision.expires_at>Date.now());
    assert.ok(decision.expires_at<=Date.now()+20*60_000);
  }
});
test('missing Ready, committed cancellation, physical termination and missing proof fail closed',async()=>{
  for(const row of [null,{...baseRow,session_state:'starting'},
    {...baseRow,state:'confirmed'}, {...baseRow,owner_run_attempt:3}]) {
    assert.deepEqual(await decideSessionAdmission(env(row),{attempt_id:attemptId},goodServices),{allowed:false});
  }
  assert.deepEqual(await decideSessionAdmission(env(baseRow),{attempt_id:attemptId,oidc_jwt:'bad'},
    {...goodServices,oidc:async()=>false}),{allowed:false});
  assert.deepEqual(await decideSessionAdmission(env(baseRow),{attempt_id:attemptId},
    {...goodServices,physical:async()=>({state:'completed' as const})}),{allowed:false});
});
test('legacy repository and altered immutable ID are never authorized for Session admission',async()=>{
  for(const changed of [
    {repository:'lirtual/session-actions'},
    {repositoryId:123},
  ]) {
    const plan=JSON.parse(baseRow.plan);
    Object.assign(plan.steps[0].with.action,changed);
    const result=await decideSessionAdmission(env({...baseRow,plan:JSON.stringify(plan)}),
      {attempt_id:attemptId,oidc_jwt:'signed'},goodServices);
    assert.deepEqual(result,{allowed:false});
  }
});
test('frozen signed Ready duration bounds repository-mode Session authorization',async()=>{
 const plan=JSON.parse(baseRow.plan);
 plan.steps[0].with.action.inputs.duration_mode='repository';
 plan.steps[0].with.action.inputs.duration_minutes=300;
 const current={...baseRow,plan:JSON.stringify(plan),rca_duration_minutes:3};
 const decision=await decideSessionAdmission(env(current),{attempt_id:attemptId},goodServices);
 assert.equal(decision.allowed,true);
 if(decision.allowed)assert.ok(decision.expires_at<=Date.now()+3*60_000);
 for(const frozen of [null,0,301]) {
  assert.deepEqual(await decideSessionAdmission(env({...current,rca_duration_minutes:frozen}),
    {attempt_id:attemptId},goodServices),{allowed:false});
 }
});
test('unknown repository runtime duration never grants rca',async()=>{
  const value=JSON.parse(baseRow.plan);
  value.steps[0].with.action.inputs.duration_mode='repository';
  const decision=await decideSessionAdmission(env({...baseRow,plan:JSON.stringify(value)}),
    {attempt_id:attemptId},goodServices);
  assert.deepEqual(decision,{allowed:false});
});
