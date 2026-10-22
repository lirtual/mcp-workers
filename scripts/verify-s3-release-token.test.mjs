import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyS3ReleaseToken} from './verify-s3-release-token.mjs';

const nonce='11111111-1111-4111-8111-111111111111';
const repo={id:1414936394,full_name:'lirtual/mcp-workers'};
const wf={path:'.github/workflows/workflow-s3-executor.yml',state:'active'};
const mk=(status,json={},headers={})=>new Response(JSON.stringify(json),
  {status,headers:{'content-type':'application/json',...headers}});
function stub(options={}){
  const calls=[];
  const fn=async r=>{
    calls.push(r);
    if(r.method==='POST')return mk(options.postStatus??422,{message:'ref not found'},
      options.postHeaders??{'x-github-request-id':'test'});
    return new URL(r.url).pathname.endsWith('/workflow-s3-executor.yml')
      ?mk(options.workflowStatus??200,options.workflow??wf)
      :mk(options.repoStatus??200,options.repo??repo);
  };
  return {calls,fn};
}
const token='github_token_test_long_enough_abc';
test('authorized repo, fixed executor and impossible ref confirm permission without running job',async()=>{
  const mock=stub();
  assert.equal(await verifyS3ReleaseToken(token,mock.fn,nonce),true);
  assert.equal(mock.calls.length,3);
  assert.deepEqual(mock.calls.map(x=>x.method),['GET','GET','POST']);
  const last=mock.calls.at(-1);
  assert.equal(last.redirect,'manual');
  assert.ok(new URL(last.url).pathname.endsWith('/dispatches'));
  assert.ok(JSON.parse(await last.text()).ref.includes('s3-release-probe-absent-'));
  assert.ok(!mock.calls.some(x=>x.url.includes(token)));
});
test('missing/invalid token is rejected before any request',async()=>{
  for(const invalid of ['', 'a', 'a b'.repeat(20), undefined]){
    const mock=stub();
    await assert.rejects(verifyS3ReleaseToken(invalid,mock.fn,nonce),/s3_release_credential_invalid/);
    assert.equal(mock.calls.length,0);
  }
});
test('cannot accept a different repo, absent executor or write-unauthorized status',async()=>{
  for(const options of [
    {repo:{...repo,id:12}},
    {repo:{...repo,full_name:'another/repo'}},
    {repoStatus:403},
    {workflowStatus:404},
    {workflow:{...wf,state:'disabled_manually'}},
    {workflow:{...wf,path:'.github/workflows/ci.yml'}},
    {postStatus:401},
    {postStatus:403},
    {postStatus:204},
    {postStatus:200},
    {postHeaders:{}},
  ]){
    const mock=stub(options);
    await assert.rejects(verifyS3ReleaseToken(token,mock.fn,nonce));
  }
});
test('transport error cannot become approval',async()=>{
  await assert.rejects(verifyS3ReleaseToken(token,async()=>{throw Error('network');},nonce));
});
