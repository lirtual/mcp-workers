import test from 'node:test';
import assert from 'node:assert/strict';
import { currentExecutorRepository, listAvailableGitHubActions } from '../src/github-action-catalog.ts';

const approved = {repository:'lirtual/github-actions',repositoryId:123,commitSha:'a'.repeat(40)};
test('no approved repositories means zero actions, without requiring a token', async () => {
  assert.deepEqual(await listAvailableGitHubActions({}), {actions:[]});
});
test('one release-owned executor identity replaces the multi-repo allowlist', () => {
  const identity={repository:approved.repository,repositoryId:approved.repositoryId,ciWorkflowId:777};
  assert.deepEqual(currentExecutorRepository(JSON.stringify(identity)),identity);
  for(const bad of ['{broken',JSON.stringify([identity]),
    JSON.stringify({...identity,extra:true}),JSON.stringify({...identity,repositoryId:0}),
    JSON.stringify({...identity,ciWorkflowId:0}),JSON.stringify({...identity,repository:'bad/repo/extra'})])
    assert.equal(currentExecutorRepository(bad),null);
});
test('approved discovery requires a server-owned credential', async () => {
  await assert.rejects(listAvailableGitHubActions({
    WORKFLOW_GITHUB_ACTION_IDENTITY:JSON.stringify({repository:approved.repository,repositoryId:approved.repositoryId,ciWorkflowId:777}),
  }), /token_missing/);
});

const headSha='c'.repeat(40);
const actionYaml=`name: task\non:\n  workflow_dispatch:\n    inputs:\n      attempt_id: {type: string, required: true}\n      dispatch_id: {type: string, required: true}\n      capability_id: {type: string, required: true}\nenv:\n  WORKFLOW_ACTION_TYPE: task\n  WORKFLOW_ACTION_PUBLIC: "true"\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo success\n`;
function githubMock(requests:string[],mode:'public'|'private'='public',actualName='lirtual/github-actions'){
 return async(req:Request):Promise<Response>=>{
   const u=new URL(req.url),route=u.pathname+u.search;
   requests.push(route);
   if(u.pathname.endsWith('/commits/main'))return Response.json({sha:headSha});
   if(u.pathname.endsWith('/actions/workflows'))
     return Response.json({workflows:[{id:100,path:'.github/workflows/task.yml',state:'active'}]});
   if(u.pathname.endsWith('/contents/.github/workflows/task.yml'))
     return Response.json({path:'.github/workflows/task.yml',encoding:'base64',
       content:btoa(mode==='public'?actionYaml:actionYaml.replace('  WORKFLOW_ACTION_PUBLIC: "true"\n',''))});
   return Response.json({id:1430925009,full_name:actualName,default_branch:'main'});
 };
}
const discoveryEnv={WORKFLOW_GITHUB_ACTION_IDENTITY:JSON.stringify({
    repository:'lirtual/github-actions',repositoryId:1430925009,ciWorkflowId:777,
  }),WORKFLOW_GITHUB_DISPATCH_TOKEN:'test-token'};
test('catalog exposes one current main candidate and never resolves a Tag',async()=>{
 const requests:string[]=[];
 const found=await listAvailableGitHubActions(discoveryEnv,githubMock(requests));
 assert.equal(found.actions.length,1);
 const action=found.actions[0];
 assert.equal(action.commitSha,headSha);
 assert.equal(action.ref,'refs/heads/main');
 assert.match(action.contractDigest,/^[0-9a-f]{64}$/);
 assert.equal(action.workflowId,100);
 assert.equal(action.type,'task');
 assert.equal(action.availability,'publishable_after_owner_approval');
 assert.equal(action.output_schema_status,'not_declared');
 assert.equal('output_schema' in action,false);
 assert.equal(requests.some(s=>s.includes('/tags')),false);
 assert.equal(requests.filter(s=>s.includes('/contents/')).length,1);
});
test('only explicitly declared trusted main Actions are visible',async()=>{
 const privateActions=await listAvailableGitHubActions(discoveryEnv,githubMock([],'private'));
 assert.equal(privateActions.actions.length,0);
 await assert.rejects(()=>listAvailableGitHubActions(discoveryEnv,
   githubMock([],'public','lirtual/session-actions')),/repository_mismatch/);
 const differentRepo=await listAvailableGitHubActions({
   WORKFLOW_GITHUB_ACTION_IDENTITY:JSON.stringify({
     repository:'other/actions',repositoryId:1430925009,ciWorkflowId:777,
   }),WORKFLOW_GITHUB_DISPATCH_TOKEN:'test-token',
 },async req=>{const u=new URL(req.url);
   if(u.pathname.endsWith('/commits/main'))return Response.json({sha:headSha});
   if(u.pathname.endsWith('/actions/workflows'))return Response.json({workflows:[{id:100,path:'.github/workflows/task.yml',state:'active'}]});
   if(u.pathname.endsWith('/contents/.github/workflows/task.yml'))return Response.json({path:'.github/workflows/task.yml',encoding:'base64',content:btoa(actionYaml)});
   return Response.json({id:1430925009,full_name:'other/actions',default_branch:'main'});
 });
 assert.equal(differentRepo.actions.length,1);
 assert.equal(differentRepo.actions[0].repository,'other/actions');
});
