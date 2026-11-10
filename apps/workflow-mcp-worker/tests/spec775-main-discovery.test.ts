import test from 'node:test';
import assert from 'node:assert/strict';
import {listAvailableGitHubActions} from '../src/github-action-catalog.ts';
import {parseGitHubAction} from '../src/github-action-contract.ts';
import {isDynamicMainAction,DYNAMIC_MAIN_REF} from '../src/github-action-main.ts';

const repo='lirtual/github-actions',repoId=1430925009;
const sha='a'.repeat(40);
const makeYaml=(name:string,publicAction:boolean)=>`name: ${name}\non:\n  workflow_dispatch:\n    inputs:\n      attempt_id: {type: string, required: true}\n      dispatch_id: {type: string, required: true}\n      capability_id: {type: string, required: true}\nenv:\n  WORKFLOW_ACTION_TYPE: task\n${publicAction?'  WORKFLOW_ACTION_PUBLIC: "true"\n':''}jobs:\n  run:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo verified\n`;
const publicPath='.github/workflows/new-report.yml';
const maintenancePath='.github/workflows/verify-action.yml';
function api(requests:string[]){return async(request:Request)=>{
 const url=new URL(request.url),path=url.pathname;
 requests.push(path);
 if(path===`/repos/${repo}`)return Response.json({id:repoId,full_name:repo,default_branch:'main'});
 if(path===`/repos/${repo}/commits/main`)return Response.json({sha});
 if(path===`/repos/${repo}/actions/workflows`)return Response.json({workflows:[
  {path:publicPath,id:810,state:'active'},{path:maintenancePath,id:811,state:'active'},
 ]});
 if(path===`/repos/${repo}/contents/${publicPath}`)return Response.json({path:publicPath,encoding:'base64',content:btoa(makeYaml('new-report',true))});
 if(path===`/repos/${repo}/contents/${maintenancePath}`)return Response.json({path:maintenancePath,encoding:'base64',content:btoa(makeYaml('verify-action',false))});
 throw Error('unexpected: '+path);
};}

test('new declared Task appears once at current main; undeclared maintenance remains invisible',async()=>{
 const requests:string[]=[];
 const found=await listAvailableGitHubActions({
   WORKFLOW_GITHUB_DISPATCH_TOKEN:'token',
   WORKFLOW_GITHUB_ACTION_IDENTITY:JSON.stringify({repository:repo,repositoryId:repoId,ciWorkflowId:901}),
 },api(requests));
 assert.equal(found.actions.length,1);
 assert.equal(found.actions[0].workflowPath,publicPath);
 assert.equal(found.actions[0].ref,DYNAMIC_MAIN_REF);
 assert.equal(found.actions[0].commitSha,sha);
 assert.equal(found.actions[0].can_publish,true);
 assert.equal(requests.filter(path=>path.endsWith('/tags')).length,0);
});

test('Action declaration remains strict and main admission is limited to trusted repository',()=>{
 assert.equal(parseGitHubAction(makeYaml('report',true)).publicMain,true);
 assert.equal(parseGitHubAction(makeYaml('report',false)).publicMain,false);
 const identity={repository:repo,repositoryId:repoId,workflowId:810,
   workflowPath:publicPath,type:'task' as const};
 assert.equal(isDynamicMainAction(identity,DYNAMIC_MAIN_REF,'new-report'),true);
 assert.equal(isDynamicMainAction({...identity,repositoryId:1},DYNAMIC_MAIN_REF),true);
 assert.equal(isDynamicMainAction({...identity,repository:'untrusted/repo'},DYNAMIC_MAIN_REF),true);
 assert.equal(isDynamicMainAction(identity,'refs/heads/dev'),false);
});
test('public action_id resolves inside bounded GitHub Task foreach, not generic Provider foreach',async t=>{
 const previous=globalThis.fetch;
 globalThis.fetch=api([]) as typeof fetch;
 t.after(()=>{globalThis.fetch=previous;});
 const {resolvePublicActionDefinition}=await import('../src/public-action-definition.ts');
 const {compilePublicPlan}=await import('../src/plan.ts');
 const env={WORKFLOW_GITHUB_DISPATCH_TOKEN:'token',
  WORKFLOW_GITHUB_ACTION_IDENTITY:JSON.stringify({repository:repo,repositoryId:repoId,ciWorkflowId:901})};
 const definition=JSON.stringify({version:1,name:'reports',inputs:{items:['a']},steps:[{
   id:'batch',flow:'foreach',items:{ref:'inputs.items'},max_items:1,template:{steps:[{
     id:'run',uses:'action.run',with:{action_id:'github.new-report',input:{}}},
   ]},
 }]});
 const translated=await resolvePublicActionDefinition(definition,env as any);
 const parsed=JSON.parse(translated.definition);
 assert.equal(parsed.steps[0].template.steps[0].with.executor,'github');
 assert.equal(parsed.steps[0].template.steps[0].with.action.ref,DYNAMIC_MAIN_REF);
 const compiled=await compilePublicPlan(translated.definition);
 assert.equal(compiled.plan.steps[0].uses,'flow.foreach');
 const forbidden=definition.replace('github.new-report','cloudflare.other');
 await assert.rejects(()=>resolvePublicActionDefinition(forbidden,env as any),/unsupported_foreach_action/);
});
