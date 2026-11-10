import test from 'node:test';
import assert from 'node:assert/strict';
import {validateExecutorRepository,verifyWorkflowGitHubExecutor} from './workflow-github-executor.mjs';

const valid = 'different-owner/private-actions';
const meta = {full_name:valid,id:1800090011,default_branch:'main'};
const ci = {id:391234567,path:'.github/workflows/ci.yml',state:'active'};
function httpMock(options={}) {
  const seen=[];
  const http=async(request)=>{
    seen.push(request);
    const data=request.url.endsWith('/actions/workflows/ci.yml')
      ? (options.ci??ci) : (options.meta??meta);
    return new Response(JSON.stringify(data),{status:options.status??200});
  };
  return {http,seen};
}

test('one arbitrary authorized owner/repo resolves immutable name, ID and active CI ID',async()=>{
  const {http,seen}=httpMock();
  const resolved=await verifyWorkflowGitHubExecutor(valid,'token',http);
  assert.deepEqual({...resolved},{repository:valid,repositoryId:meta.id,ciWorkflowId:ci.id});
  assert.deepEqual(seen.map(x=>new URL(x.url).pathname),[
    '/repos/'+valid,'/repos/'+valid+'/actions/workflows/ci.yml']);
  assert.ok(seen.every(x=>x.redirect==='manual'&&x.headers.get('authorization')==='Bearer token'));
});

test('executor configuration requires a single literal owner/repo',()=>{
  for(const bad of [undefined,'','x','x/y/z',' x/y','x/y ','["x/y"]',
    'x/../y','../r','x/.repo','a/b\nextra','https://github.com/x/y','a/b?z=1']) {
    assert.throws(()=>validateExecutorRepository(bad),/WORKFLOW_GITHUB_ACTION_REPOSITORY/);
  }
  assert.equal(validateExecutorRepository(valid),valid);
});

test('repository renames, transfers, wrong defaults, and inactive or wrong CI fail before dispatch',async()=>{
  for(const change of [
    {meta:{...meta,full_name:'other/private-actions'}},
    {meta:{...meta,id:1234.5}},
    {meta:{...meta,id:0}},
    {meta:{...meta,default_branch:'develop'}},
    {ci:{...ci,path:'.github/workflows/other.yml'}},
    {ci:{...ci,id:0}},
    {ci:{...ci,state:'disabled_manually'}},
  ]) {
    const {http}=httpMock(change);
    await assert.rejects(verifyWorkflowGitHubExecutor(valid,'token',http),
      /mismatch/);
  }
});

test('missing token, redirects, denial, errors, and invalid API bodies fail closed',async()=>{
  await assert.rejects(verifyWorkflowGitHubExecutor(valid,''),
    /TOKEN/);
  for(const status of [301,302,401,403,404,500]) {
    const {http}=httpMock({status});
    await assert.rejects(verifyWorkflowGitHubExecutor(valid,'token',http),
      /unavailable/);
  }
  await assert.rejects(verifyWorkflowGitHubExecutor(valid,'token',
    async()=>{throw Error('network');}),/unavailable/);
  await assert.rejects(verifyWorkflowGitHubExecutor(valid,'token',
    async()=>new Response('not-json')),/invalid/);
  await assert.rejects(verifyWorkflowGitHubExecutor(valid,'token',
    async()=>new Response('x'.repeat(70_000))),/invalid/);
});


test('protected release preserves a separate environment-free Repository source capture',async()=>{
  const {readFileSync}=await import('node:fs');
  const ci=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
  const release=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  const validation=readFileSync(new URL('./manual-worker-release.mjs',import.meta.url),'utf8');
  assert.match(ci,/canonical_workflow_executor_repository:/);
  assert.match(ci,/validate-source "\$SOURCE_REPOSITORY"/);
  assert.match(release,/CANONICAL_WORKFLOW_EXECUTOR_REPOSITORY: \$\{\{ needs\.checks\.outputs\.canonical_workflow_executor_repository \}\}/);
  assert.match(validation,/CANONICAL_WORKFLOW_EXECUTOR_REPOSITORY ===/);
});
