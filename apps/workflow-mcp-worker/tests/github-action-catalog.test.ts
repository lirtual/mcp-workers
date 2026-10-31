import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedActionRepositories, listAvailableGitHubActions } from '../src/github-action-catalog.ts';

const approved = {repository:'lirtual/github-actions',repositoryId:123,commitSha:'a'.repeat(40)};
test('no approved repositories means zero actions, without requiring a token', async () => {
  assert.deepEqual(await listAvailableGitHubActions({}), {actions:[]});
});
test('explicit allowlist accepts only pinned, unique repository identities', () => {
  assert.deepEqual(approvedActionRepositories(JSON.stringify([approved])),
    [{repository:approved.repository,repositoryId:approved.repositoryId}]);
  assert.deepEqual(approvedActionRepositories(JSON.stringify([{
    repository:approved.repository,repositoryId:approved.repositoryId,
  }])), [{repository:approved.repository,repositoryId:approved.repositoryId}]);
  for (const entries of [
    [{...approved,repository:'another/repo/invalid'}],
    [{...approved,commitSha:'main'}],
    [{...approved,repositoryId:0}],
    [approved,approved],
    [{...approved,token:'not-allowed'}],
  ]) assert.throws(() => approvedActionRepositories(JSON.stringify(entries)), /catalog_invalid/);
  assert.throws(() => approvedActionRepositories('{broken'), /catalog_invalid/);
});
test('approved discovery requires a server-owned credential', async () => {
  await assert.rejects(listAvailableGitHubActions({
    GITHUB_ACTION_APPROVED_REPOSITORIES:JSON.stringify([approved]),
  }), /token_missing/);
});

const releaseSha='b'.repeat(40),headSha='c'.repeat(40);
const actionYaml=`name: Verify Task
on:
  workflow_dispatch:
    inputs:
      attempt_id: {type: string, required: true}
      dispatch_id: {type: string, required: true}
      capability_id: {type: string, required: true}
env:
  WORKFLOW_ACTION_TYPE: task
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: echo success
`;
function githubMock(requests:string[],mode:'tagged'|'moved'|'head'|'no_tag'='tagged',actualName='lirtual/github-actions'){
 return async(req:Request):Promise<Response>=>{
   const u=new URL(req.url),route=u.pathname+u.search;
   requests.push(route);
   if(u.pathname.endsWith('/tags'))
     return Response.json(mode==='no_tag'?[]:[{name:'v0.1.21',commit:{sha:mode==='head'?headSha:releaseSha}}]);
   if(u.pathname.endsWith('/git/ref/tags/v0.1.21'))
     return Response.json({ref:'refs/tags/v0.1.21',
       object:{type:'commit',sha:mode==='moved'?headSha:mode==='head'?headSha:releaseSha}});
   if(u.pathname.endsWith('/commits/main'))return Response.json({sha:headSha});
   if(u.pathname.endsWith('/commits/'+releaseSha))return Response.json({sha:releaseSha});
   if(u.pathname.endsWith('/actions/workflows'))
     return Response.json({workflows:[{id:100,path:'.github/workflows/task.yml',state:'active'}]});
   if(u.pathname.endsWith('/contents/.github/workflows/task.yml'))
     return Response.json({path:'.github/workflows/task.yml',encoding:'base64',content:btoa(actionYaml)});
   return Response.json({id:123,full_name:actualName,default_branch:'main'});
 };
}
const discoveryEnv={GITHUB_ACTION_APPROVED_REPOSITORIES:JSON.stringify([approved]),
  WORKFLOW_GITHUB_DISPATCH_TOKEN:'test-token'};
test('catalog emits a verified tag-bound runnable candidate plus unpublished HEAD',async()=>{
 const requests:string[]=[];
 const found=await listAvailableGitHubActions(discoveryEnv,githubMock(requests));
 assert.equal(found.actions.length,2);
 const released=found.actions.find(a=>a.can_publish);
 assert.ok(released);
 assert.equal(released!.commitSha,releaseSha);
 assert.equal(released!.ref,'refs/tags/v0.1.21');
 assert.match(released!.contractDigest,/^[0-9a-f]{64}$/);
 assert.equal(released!.workflowId,100);
 assert.equal(released!.type,'task');
 assert.equal(released!.availability,'publishable_after_owner_approval');
 const head=found.actions.find(a=>!a.can_publish);
 assert.equal(head?.commitSha,headSha);
 assert.equal(head?.reason,'no_verified_published_tag_for_revision');
 assert(requests.includes('/repos/lirtual/github-actions/git/ref/tags/v0.1.21'));
 assert(requests.some(x=>x.endsWith('?ref='+releaseSha)));
});
test('a GitHub redirect to the pre-rename name cannot satisfy the renamed repository grant',async()=>{
 await assert.rejects(
  listAvailableGitHubActions(discoveryEnv,githubMock([],'tagged','lirtual/session-actions')),
  /repository_mismatch/);
});
test('moved tag never becomes a publishable candidate',async()=>{
 const found=await listAvailableGitHubActions(discoveryEnv,githubMock([],'moved'));
 assert.equal(found.actions.length,1);
 assert.equal(found.actions[0].can_publish,false);
});
test('verified tag on current SHA yields one candidate without duplicate YAML fetch',async()=>{
 const requests:string[]=[];
 const found=await listAvailableGitHubActions(discoveryEnv,githubMock(requests,'head'));
 assert.equal(found.actions.length,1);
 assert.equal(found.actions[0].can_publish,true);
 assert.equal(requests.filter(s=>s.includes('/contents/')).length,1);
});
test('no tag explicitly reports unavailable rather than inventing an immutable ref',async()=>{
 const found=await listAvailableGitHubActions(discoveryEnv,githubMock([],'no_tag'));
 assert.equal(found.actions[0].availability,'unavailable');
 assert.equal(found.actions[0].can_publish,false);
 assert.equal('ref' in found.actions[0],false);
});


test('GitHub discovery explicitly distinguishes unknown business output from Job completion',async()=>{
 const found=await listAvailableGitHubActions(discoveryEnv,githubMock([]));
 for(const action of found.actions){
   assert.equal(action.output_schema_status,'not_declared');
   assert.equal('output_schema' in action,false);
 }
});
