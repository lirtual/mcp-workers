// Production GitHub read/denied-ref credential gate. This never dispatches a Job.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const API='https://api.github.com/repos/lirtual/mcp-workers';
const WORKFLOW=API+'/actions/workflows/workflow-github-executor.yml';
const REPO_ID=1414936394;

export async function verifyS3ReleaseToken(token,request=fetch,nonce=randomUUID()){
  assert.ok(typeof token==='string' && token.length>=20 && token.length<=512 &&
    !/\s/.test(token),'github_release_credential_invalid');
  assert.match(nonce,/^[0-9a-f-]{36}$/i,'github_probe_nonce_invalid');
  const headers={
    accept:'application/vnd.github+json',
    authorization:'Bearer '+token,
    'content-type':'application/json',
    'user-agent':'mcp-workers-github-release-preflight',
    'x-github-api-version':'2026-03-10',
  };
  const get=async url=>request(new Request(url,{
    headers,redirect:'manual',signal:AbortSignal.timeout(15000),
  }));
  // Never log a response body, user info, header, URL query or token.
  const repo=await get(API);
  if(repo.status!==200)throw Error('github_repo_http_'+repo.status);
  const repoInfo=await repo.json().catch(()=>{throw Error('github_repo_invalid_json');});
  if(repoInfo?.id!==REPO_ID)throw Error('github_repo_identity_mismatch');
  if(repoInfo?.full_name!=='lirtual/mcp-workers')throw Error('github_repo_identity_mismatch');
  const workflow=await get(WORKFLOW);
  if(workflow.status!==200)throw Error('github_workflow_http_'+workflow.status);
  const info=await workflow.json().catch(()=>{throw Error('github_workflow_invalid_json');});
  if(info?.path!=='.github/workflows/workflow-github-executor.yml')
    throw Error('github_workflow_path_mismatch');
  if(info?.state!=='active')throw Error('github_workflow_inactive');
  // This branch does not exist; a successful dispatch must never be sent.
  const invalidRef='github-release-probe-absent-'+nonce;
  const response=await request(new Request(WORKFLOW+'/dispatches',{
    method:'POST',headers,redirect:'manual',signal:AbortSignal.timeout(15000),
    body:JSON.stringify({ref:invalidRef,return_run_details:true,inputs:{
      attempt_id:nonce,dispatch_id:nonce,capability_id:'github.workflow.check',
    }}),
  }));
  if(response.status!==422)throw Error('github_dispatch_http_'+response.status);
  if(!response.headers.get('x-github-request-id'))
    throw Error('github_dispatch_header_missing');
  return true;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  verifyS3ReleaseToken(process.env.WORKFLOW_GITHUB_DISPATCH_TOKEN)
    .then(()=>console.log('WORKFLOW_GITHUB_DISPATCH_TOKEN_READ_AND_DENIED_DISPATCH_OK'))
    .catch(error=>{
      // Only our fixed local assertion codes can appear, never API content.
      const allowed=/^github_(?:repo|workflow|dispatch)_(?:http_[1-5][0-9]{2}|[a-z_]+)$|^github_(?:release_credential_invalid|probe_nonce_invalid)$/;
      const code=String(error?.message||'');
      console.error('WORKFLOW_GITHUB_DISPATCH_TOKEN_PREFLIGHT_FAILED',
        allowed.test(code)?code:'github_unavailable');
      process.exitCode=1;
    });
}
