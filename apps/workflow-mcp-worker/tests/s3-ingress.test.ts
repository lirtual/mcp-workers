import test from 'node:test';
import assert from 'node:assert/strict';
import { handleGithubCallbackRequest } from '../src/s3-github-ingress.ts';
import type { Env } from '../src/store.ts';

const url='https://workflow.example.org/s3/claim';
const base={
  S3_GITHUB_REPOSITORY:'lirtual/mcp-workers',
  S3_GITHUB_REPOSITORY_ID:'123456',
  S3_GITHUB_REF:'refs/heads/main',
  S3_GITHUB_AUDIENCE:'workflow-s3-claim:production',
  DB:{} as D1Database,WORKFLOW:{} as Env['WORKFLOW'],
} as Env;

test('S3 ingress cannot become reachable until explicitly enabled',async()=>{
  const fetchCalls=0;
  const response=await handleGithubCallbackRequest(new Request(url,{method:'POST',
    headers:{authorization:'Bearer forged'},body:JSON.stringify({attemptId:'a'})}),base);
  assert.equal(response.status,404);
  assert.equal(fetchCalls,0);
});

test('S3 ingress requires pinned identity configuration and GitHub OIDC bearer',async()=>{
  const configured={...base,S3_ENABLED:'true'};
  const noId=await handleGithubCallbackRequest(new Request(url,{method:'POST'}),{
    ...configured,S3_GITHUB_REPOSITORY:undefined,
  });
  assert.equal(noId.status,503);
  assert.equal((await handleGithubCallbackRequest(new Request(url,{method:'GET'}),configured)).status,405);
  assert.equal((await handleGithubCallbackRequest(new Request(url,{method:'POST'}),configured)).status,401);
  assert.equal((await handleGithubCallbackRequest(new Request(url,{method:'POST',
    headers:{authorization:'Bearer not-a-github-token'},
    body:JSON.stringify({attemptId:'not-uuid'})}),configured)).status,400);
});

test('S3 ingress rejects oversized and unrecognized requests without touching database',async()=>{
  const configured={...base,S3_ENABLED:'true'};
  const token='Bearer test-only-not-real';
  const oversized=await handleGithubCallbackRequest(new Request(url,{
    method:'POST',headers:{authorization:token,'content-length':'9000'},body:'{}',
  }),configured);
  assert.equal(oversized.status,413);
  const malformed=await handleGithubCallbackRequest(new Request(url,{
    method:'POST',headers:{authorization:token},body:'{not-json',
  }),configured);
  assert.equal(malformed.status,400);
  assert.equal((await handleGithubCallbackRequest(new Request('https://workflow.example.org/s3/other',{
    method:'POST',headers:{authorization:token},body:'{}',
  }),configured)).status,404);
});
