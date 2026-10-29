import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewedPayload,verifyProviderProvenance,verifyCloudflareProvider,
  syncReviewedVersion} from './sync-reviewed-weixin-provider.mjs';

const sha='a'.repeat(40), id=40796327454;
const version='3d61997c-eb30-46e3-b96f-334343d061af';
const old='12970996-4220-4731-b76e-a0c8aa7a5017';
const proof={release_run_id:id,release_sha:sha,provider_version_id:version};
const run={id,workflow_id:399111011,head_sha:sha,event:'workflow_dispatch',
  status:'completed',conclusion:'success',head_branch:'main',
  path:'lirtual/cloudflare-actions/.github/workflows/release.yml@refs/heads/main'};
const list={workflow_runs:[run]};
const deployment={deployments:[{versions:[{percentage:100,version_id:version}]}]};
const settings={bindings:[{name:'DB',type:'d1',id:'051c3b6d-e3bc-4d69-907f-37e8ab00618f'},
  {name:'WEIXIN_ENCRYPTION_KEY',type:'secret_text'}]};
const credentials={providerReadToken:'read-token',environmentWriteToken:'env-token',
  cloudflareToken:'cf-token',accountId:'a'.repeat(32),workflowToken:'workflow-token'};

test('reject untrusted events, source-run status, stale releases and wrong Cloudflare identity',()=>{
 assert.deepEqual(reviewedPayload({action:'reviewed_weixin_provider_release',client_payload:proof}),proof);
 assert.throws(()=>reviewedPayload({action:'something_else',client_payload:proof}),/Unreviewed/);
 assert.throws(()=>reviewedPayload({action:'reviewed_weixin_provider_release',
  client_payload:{...proof,unreviewed:'extra'}}),/Invalid/);
 assert.equal(verifyProviderProvenance(proof,run,list),true);
 for(const patch of [{conclusion:'failure'},{workflow_id:1},{head_sha:'b'.repeat(40)},{head_branch:'dev'}])
   assert.throws(()=>verifyProviderProvenance(proof,{...run,...patch},list),/not latest/);
 assert.throws(()=>verifyProviderProvenance(proof,run,
   {workflow_runs:[{id:id+1,event:'workflow_dispatch'},run]}),/not latest/);
 assert.equal(verifyCloudflareProvider(proof,deployment,settings),true);
 for(const d of [{deployments:[{versions:[{percentage:50,version_id:version}]}]},
   {deployments:[{versions:[{percentage:100,version_id:old}]}]}])
   assert.throws(()=>verifyCloudflareProvider(proof,d,settings),/mismatched/);
 assert.throws(()=>verifyCloudflareProvider(proof,deployment,{bindings:[
  ...settings.bindings,{name:'MCP_ACCESS_TOKEN'}]}),/mismatched/);
});

function mocked({approved=true,sourceOk=true,live=old,environmentPin=old}={}){
 const calls=[];let pin=environmentPin;
 const fetchImpl=async(url,options)=>{
   const method=options.method, u=String(url);calls.push({url:u,method,body:options.body});
   const json=v=>({ok:true,status:200,json:async()=>v});
   const success=v=>json({success:true,result:v});
   if(method==='PATCH'){
     assert.ok(u.includes('/environments/workflow-mcp-worker/variables/WEIXIN_ACTION_DEPLOYMENT_ID'));
     pin=JSON.parse(options.body).value;return {status:204};
   }
   if(method==='POST'){
     assert.ok(u.endsWith('/actions/workflows/release.yml/dispatches'));
     assert.deepEqual(JSON.parse(options.body),{ref:'main',
      inputs:{worker:'workflow-mcp-worker',deploy_to_production:'true'}});
     return {status:204};
   }
   if(u.includes('/actions/runs/'+id))return json(sourceOk?run:{...run,conclusion:'failure'});
   if(u.includes('/actions/workflows/release.yml/runs'))return json(list);
   if(u.includes('/workers/scripts/weixin-mcp-worker/deployments'))return success(deployment);
   if(u.includes('/workers/scripts/weixin-mcp-worker/settings'))return success(settings);
   if(u.includes('/workers/scripts/workflow-mcp-worker/settings'))
     return success({bindings:[{name:'WEIXIN_ACTION_DEPLOYMENT_ID',type:'plain_text',text:live}]});
   if(u.endsWith('/environments/workflow-mcp-worker'))return json({
     protection_rules:approved?[{type:'required_reviewers',reviewers:[{type:'User',id:1}]}]:[]});
   if(u.endsWith('/variables/WEIXIN_ACTION_DEPLOYMENT_ID'))return json({
     name:'WEIXIN_ACTION_DEPLOYMENT_ID',value:pin});
   throw Error('Unexpected endpoint '+u);
 };
 return {calls,fetchImpl};
}
test('approved sync updates only reviewed environment variable then dispatches existing release',async()=>{
 const m=mocked();const v=await syncReviewedVersion(proof,credentials,m.fetchImpl);
 assert.deepEqual(v,{provider_version_id:version,dispatched:true});
 assert.equal(m.calls.filter(x=>x.method==='PATCH').length,1);
 assert.equal(m.calls.filter(x=>x.method==='POST').length,1);
 assert.ok(m.calls.every(x=>!JSON.stringify(x).includes('read-token')));
});
test('unreviewed or stale releases do not mutate environment or dispatch',async()=>{
 for(const options of [{approved:false},{sourceOk:false}]){
   const m=mocked(options);
   await assert.rejects(()=>syncReviewedVersion(proof,credentials,m.fetchImpl));
   assert.equal(m.calls.filter(x=>x.method!=='GET').length,0);
 }
});
test('matching live and environment pin is idempotent with zero writes',async()=>{
 const m=mocked({live:version,environmentPin:version});
 assert.deepEqual(await syncReviewedVersion(proof,credentials,m.fetchImpl),
  {provider_version_id:version,dispatched:false});
 assert.equal(m.calls.filter(x=>x.method!=='GET').length,0);
});
