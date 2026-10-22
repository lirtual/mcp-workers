import test from 'node:test';
import assert from 'node:assert/strict';
import { handleGithubCallbackRequest } from '../src/github-ingress.ts';
import type { Env } from '../src/store.ts';

const url='https://workflow.example.org/github/claim';
const base={
  GITHUB_EXECUTOR_REPOSITORY:'lirtual/mcp-workers',
  GITHUB_EXECUTOR_REPOSITORY_ID:'123456',
  GITHUB_EXECUTOR_REF:'refs/heads/main',
  GITHUB_EXECUTOR_AUDIENCE:'workflow-github-claim:production',
  DB:{} as D1Database,WORKFLOW:{} as Env['WORKFLOW'],
} as Env;

test('GitHub ingress rejects malformed claims without contacting the database',async()=>{
  const fetchCalls=0;
  const response=await handleGithubCallbackRequest(new Request(url,{method:'POST',
    headers:{authorization:'Bearer forged'},body:JSON.stringify({attemptId:'a'})}),base);
  assert.equal(response.status,400);
  assert.equal(fetchCalls,0);
});

test('GitHub ingress requires pinned identity configuration and GitHub OIDC bearer',async()=>{
  const configured={...base,GITHUB_EXECUTION_ENABLED:'true'};
  const noId=await handleGithubCallbackRequest(new Request(url,{method:'POST'}),{
    ...configured,GITHUB_EXECUTOR_REPOSITORY:undefined,
  });
  assert.equal(noId.status,503);
  assert.equal((await handleGithubCallbackRequest(new Request(url,{method:'GET'}),configured)).status,405);
  assert.equal((await handleGithubCallbackRequest(new Request(url,{method:'POST'}),configured)).status,401);
  assert.equal((await handleGithubCallbackRequest(new Request(url,{method:'POST',
    headers:{authorization:'Bearer not-a-github-token'},
    body:JSON.stringify({attemptId:'not-uuid'})}),configured)).status,400);
});

test('GitHub ingress rejects oversized and unrecognized requests without touching database',async()=>{
  const configured={...base,GITHUB_EXECUTION_ENABLED:'true'};
  const token='Bearer test-only-not-real';
  const oversized=await handleGithubCallbackRequest(new Request(url,{
    method:'POST',headers:{authorization:token,'content-length':'9000'},body:'{}',
  }),configured);
  assert.equal(oversized.status,413);
  const malformed=await handleGithubCallbackRequest(new Request(url,{
    method:'POST',headers:{authorization:token},body:'{not-json',
  }),configured);
  assert.equal(malformed.status,400);
  assert.equal((await handleGithubCallbackRequest(new Request('https://workflow.example.org/github/other',{
    method:'POST',headers:{authorization:token},body:'{}',
  }),configured)).status,404);
});

test('GitHub callbacks pin an in-flight job to its original D1 ref across Worker release changes',async()=>{
  const { resolveRegisteredGithubIdentity }=await import('../src/github-ingress.ts');
  const repo='lirtual/mcp-workers',repositoryId='123456';
  const issuedRef='refs/heads/release-old';
  const persisted={repository:repo,repository_id:repositoryId,ref:issuedRef,
    workflow_ref:repo+'/.github/workflows/workflow-github-executor.yml@'+issuedRef,
    state:'claimed',run_outcome:'running'};
  const sqls:string[]=[];
  const db={
    prepare(sql:string){
      sqls.push(sql);
      return {bind:(id:string)=>({
        first:async()=>id==='b6835141-0b3a-4fcb-a9ae-b4b75bfae93c'?persisted:null,
      })};
    },
  } as unknown as D1Database;
  const config={...base,DB:db,
    GITHUB_EXECUTOR_REPOSITORY:repo,GITHUB_EXECUTOR_REPOSITORY_ID:repositoryId,
    GITHUB_EXECUTOR_REF:'refs/heads/release-new',
    GITHUB_EXECUTOR_AUDIENCE:'workflow-github-claim:test'};
  const registered=await resolveRegisteredGithubIdentity(config,'b6835141-0b3a-4fcb-a9ae-b4b75bfae93c');
  assert.deepEqual(registered,{
    repository:repo,repositoryId,ref:issuedRef,
    workflowRef:persisted.workflow_ref,audience:'workflow-github-claim:test',
  });
  assert.ok(sqls[0].includes('step_attempts'));
  assert.ok(sqls[0].includes('runs'));
  assert.equal((await resolveRegisteredGithubIdentity({
    ...config,GITHUB_EXECUTOR_REPOSITORY_ID:'654321',
  },'b6835141-0b3a-4fcb-a9ae-b4b75bfae93c')),null);
  assert.equal((await resolveRegisteredGithubIdentity(config,'invalid-id')),null);
});

test('GitHub callback identity refuses inactive and unregistered workflow families after ref changes',async()=>{
  const {resolveRegisteredGithubIdentity}=await import('../src/github-ingress.ts');
  const repo='lirtual/mcp-workers',ref='refs/heads/release-old';
  const baseRow={repository:repo,repository_id:'123456',ref,
    workflow_ref:repo+'/.github/workflows/workflow-github-executor.yml@'+ref,
    state:'claimed',run_outcome:'running'};
  let row={...baseRow};
  const db={
    prepare:()=>({bind:()=>({first:async()=>row})}),
  } as unknown as D1Database;
  const config={...base,DB:db,
    GITHUB_EXECUTOR_REPOSITORY:repo,GITHUB_EXECUTOR_REPOSITORY_ID:'123456',
    GITHUB_EXECUTOR_REF:'refs/heads/release-new'};
  for(const mutation of [
    {run_outcome:'cancelled'},{state:'created'},
    {workflow_ref:repo+'/.github/workflows/ci.yml@'+ref},
    {repository:'attacker/other'},
    {ref:'refs/heads/../../bad'},
  ]){
    row={...baseRow,...mutation};
    assert.equal(await resolveRegisteredGithubIdentity(config,'b6835141-0b3a-4fcb-a9ae-b4b75bfae93c'),null);
  }
});

test('GitHub test-only ci.yml executor remains isolated from production callback identity',async()=>{
  const {resolveRegisteredGithubIdentity}=await import('../src/github-ingress.ts');
  const repo='lirtual/mcp-workers',ref='refs/heads/wip/workflow-github-executor';
  const oldRow={repository:repo,repository_id:'123456',ref,
    workflow_ref:repo+'/.github/workflows/ci.yml@'+ref,
    state:'claimed',run_outcome:'running'};
  const db={prepare:()=>({bind:()=>({first:async()=>oldRow})})} as unknown as D1Database;
  const prod={...base,DB:db,
    GITHUB_EXECUTOR_REPOSITORY:repo,GITHUB_EXECUTOR_REPOSITORY_ID:'123456',
    GITHUB_EXECUTOR_REF:'refs/heads/main'};
  const id='b6835141-0b3a-4fcb-a9ae-b4b75bfae93c';
  assert.equal(await resolveRegisteredGithubIdentity(prod,id),null);
  assert.deepEqual(await resolveRegisteredGithubIdentity({
    ...prod,GITHUB_EXECUTOR_REF:ref,
    GITHUB_TEST_WORKER_NAME:'workflow-github-plan-abcdef0123',
  },id),{
    repository:repo,repositoryId:'123456',ref,
    workflowRef:oldRow.workflow_ref,
    audience:prod.GITHUB_EXECUTOR_AUDIENCE,
  });
  assert.equal(await resolveRegisteredGithubIdentity({
    ...prod,GITHUB_EXECUTOR_REF:ref,
    GITHUB_TEST_WORKER_NAME:'workflow-github-plan-abcdef0123',
    GITHUB_TEST_DEDICATED_EXECUTOR:'true',
  },id),null);
});
