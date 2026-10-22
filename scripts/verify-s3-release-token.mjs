// Production S3 read/denied-ref credential gate. This never dispatches a Job.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const API='https://api.github.com/repos/lirtual/mcp-workers';
const WORKFLOW=API+'/actions/workflows/workflow-s3-executor.yml';
const REPO_ID=1414936394;

export async function verifyS3ReleaseToken(token,request=fetch,nonce=randomUUID()){
  assert.ok(typeof token==='string' && token.length>=20 && token.length<=512 &&
    !/\s/.test(token),'s3_release_credential_invalid');
  assert.match(nonce,/^[0-9a-f-]{36}$/i,'s3_probe_nonce_invalid');
  const headers={
    accept:'application/vnd.github+json',
    authorization:'Bearer '+token,
    'content-type':'application/json',
    'user-agent':'mcp-workers-s3-release-preflight',
    'x-github-api-version':'2026-03-10',
  };
  const get=async url=>request(new Request(url,{
    headers,redirect:'manual',signal:AbortSignal.timeout(15000),
  }));
  // Never log a response body, user info, header, URL query or token.
  const repo=await get(API);
  assert.equal(repo.status,200,'s3_repo_access_denied');
  const repoInfo=await repo.json();
  assert.equal(repoInfo?.id,REPO_ID,'s3_repository_identity_mismatch');
  assert.equal(repoInfo?.full_name,'lirtual/mcp-workers','s3_repository_identity_mismatch');
  const workflow=await get(WORKFLOW);
  assert.equal(workflow.status,200,'s3_workflow_access_denied');
  const info=await workflow.json();
  assert.equal(info?.path,'.github/workflows/workflow-s3-executor.yml',
    's3_executor_not_registered');
  assert.equal(info?.state,'active','s3_executor_inactive');
  // This branch does not exist; a successful dispatch must never be sent.
  const invalidRef='s3-release-probe-absent-'+nonce;
  const response=await request(new Request(WORKFLOW+'/dispatches',{
    method:'POST',headers,redirect:'manual',signal:AbortSignal.timeout(15000),
    body:JSON.stringify({ref:invalidRef,return_run_details:true,inputs:{
      attempt_id:nonce,dispatch_id:nonce,capability_id:'heavy.github.echo',
    }}),
  }));
  assert.equal(response.status,422,'s3_dispatch_authority_unconfirmed');
  assert.ok(response.headers.get('x-github-request-id'),
    's3_dispatch_response_unverified');
  return true;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  verifyS3ReleaseToken(process.env.S3_GITHUB_TOKEN)
    .then(()=>console.log('S3_GITHUB_TOKEN_READ_AND_DENIED_DISPATCH_OK'))
    .catch(error=>{
      // Only our fixed local assertion codes can appear, never API content.
      const allowed=/^(s3_[a-z_]+)$/;
      const code=String(error?.message||'');
      console.error('S3_GITHUB_TOKEN_PREFLIGHT_FAILED',
        allowed.test(code)?code:'s3_unavailable');
      process.exitCode=1;
    });
}
