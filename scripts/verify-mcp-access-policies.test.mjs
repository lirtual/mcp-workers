import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyMcpAccessPolicies } from './verify-mcp-access-policies.mjs';

const env = {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token',
};
const policies = (isPortal=false) => [
  {id:'7cec582c-4038-4fb0-9ad8-fcdb04af4adc',name:'WORKFLOWS',
   decision:'non_identity',precedence:1,reusable:true,
   include:[{service_token:{token_id:'synthetic-id'}}],exclude:[],require:[]},
  {id:isPortal?'07204847-0459-4197-b3c3-2dbe2a47a550':
   '659d043c-e957-4c91-9f33-2416c52ecbe5',
   name:isPortal?'MCP Portal and Browser Owners':'Default Allow Rule',
   decision:'allow',precedence:2,reusable:true,
   include:(isPortal?['lirtual@qq.com','lirtual@outlook.com']:
     ['lirtual@qq.com','lirtual@outlook.com','lirtual@gmail.com'])
     .map(email=>({email:{email}})),exclude:[],require:[]},
];
export const fakeApps = (name='OpenList MCP') => [
  {id:'portal',name:'MCP',type:'mcp_portal',
   domain:'mcp.lirtual.dpdns.org',policies:policies(true)},
  {id:'app',name,type:'mcp',policies:policies()},
];
export function fakeAccessAppResponse(apps=fakeApps(), total_pages=1) {
  return Response.json({success:true,result:apps,
    result_info:{page:1,total_pages}});
}
const target={id:'openlist',name:'OpenList MCP'};
test('matching reusable service-token and owner policies permit registration preflight',async()=>{
  let reads=0;
  const transport=async r=>{
    reads++;
    assert.equal(r.method,'GET');
    assert.equal(r.headers.get('authorization'),
      'Bearer synthetic-cloudflare-token');
    assert.equal(new URL(r.url).pathname,
      '/client/v4/accounts/'+'a'.repeat(32)+'/access/apps');
    return fakeAccessAppResponse();
  };
  assert.equal(await verifyMcpAccessPolicies(env,target,transport),true);
  assert.equal(reads,1);
});
test('missing policies, mismatched ID, reordering and broadly permissive policies fail closed',async()=>{
  for(const mutate of [
    apps=>{apps[1].policies=[];},
    apps=>{apps[1].policies[1].id='33333333-3333-4333-8333-333333333333';},
    apps=>{apps[1].policies.reverse();},
    apps=>{apps[1].policies[1].include=[{everyone:{}}];},
    apps=>{apps[0].policies[1].include=[{everyone:{}}];},
    apps=>{apps[0].policies=[];},
  ]) {
    const apps=fakeApps(); mutate(apps);
    await assert.rejects(
      ()=>verifyMcpAccessPolicies(env,target,async()=>fakeAccessAppResponse(apps)),
      /portal_access_policy_/);
  }
});
test('missing or ambiguous target/Portal apps, pagination and transport errors fail closed',async()=>{
  for(const apps of [
    fakeApps().slice(0,1),
    fakeApps().concat(fakeApps()[1]),
    fakeApps().filter(x=>x.name!=='MCP'),
    fakeApps().map(x=>({...x,name:x.type==='mcp_portal'?'One-MCP':x.name})),
  ]) {
    await assert.rejects(
      ()=>verifyMcpAccessPolicies(env,target,async()=>fakeAccessAppResponse(apps)),
      /portal_access_policy_/);
  }
  await assert.rejects(
    ()=>verifyMcpAccessPolicies(env,target,async()=>fakeAccessAppResponse(fakeApps(),2)),
    /inventory_unverifiable/);
  await assert.rejects(
    ()=>verifyMcpAccessPolicies(env,target,async()=>new Response('',{status:403})),
    /read_unavailable/);
  await assert.rejects(
    ()=>verifyMcpAccessPolicies(env,target,async()=>{throw Error('private upstream failure')}),
    /read_unavailable/);
});
test('no Access credential or malformed target means no network request',async()=>{
  let reads=0;const transport=async()=>{reads++;throw Error('unexpected request')};
  await assert.rejects(
    ()=>verifyMcpAccessPolicies({...env,CLOUDFLARE_API_TOKEN:''},target,transport),
    /auth_unavailable/);
  await assert.rejects(
    ()=>verifyMcpAccessPolicies(env,{id:'openlist',name:''},transport),
    /target_invalid/);
  assert.equal(reads,0);
});

const browserPolicy = () => ({
  id:'07204847-0459-4197-b3c3-2dbe2a47a550',
  name:'MCP Portal and Browser Owners',decision:'allow',precedence:2,reusable:true,
  include:[{email:{email:'lirtual@qq.com'}},{email:{email:'lirtual@outlook.com'}}],
  exclude:[],require:[],
});
const browserApps = () => {
  const apps=fakeApps('Browser');
  apps[1].policies[1]=browserPolicy();
  return apps;
};
const browserTarget={id:'browser',name:'Browser'};
test('Browser must share the exact reviewed Portal Owner policy',async()=>{
  const verify=(apps,target=browserTarget)=>verifyMcpAccessPolicies(env,target,
    async()=>fakeAccessAppResponse(apps));
  assert.equal(await verify(browserApps()),true);
  const invalid=[
    apps=>{apps[1].policies[1].id='659d043c-e957-4c91-9f33-2416c52ecbe5';},
    apps=>{apps[1].policies[1].name='Default Allow Rule';},
    apps=>{apps[1].policies[1].include=[{email:{email:'lirtual@outlook.com'}}];},
    apps=>{apps[1].policies[1].include.push({email:{email:'lirtual@gmail.com'}});},
    apps=>{apps[1].policies[1].include=[{everyone:{}}];},
    apps=>{apps[1].policies[1].precedence=1;},
    apps=>{apps[1].policies[0].id='33333333-3333-4333-8333-333333333333';},
    apps=>{apps[0].policies[1].include.push({email:{email:'lirtual@gmail.com'}});},
  ];
  for(const mutate of invalid){
    const apps=browserApps();mutate(apps);
    await assert.rejects(()=>verify(apps),/portal_access_policy_/);
  }
  await assert.rejects(()=>verify(browserApps(),{id:'other',name:'Browser'}),
    /portal_access_policy_/);
  await assert.rejects(()=>verify(browserApps(),{id:'browser',name:'Other'}),
    /portal_access_policy_/);
});

test('Workflow reviewed three-email rule differs from the narrowed Portal rule',async()=>{
  const target={id:'workflow',name:'Workflow'};
  const verify=apps=>verifyMcpAccessPolicies(env,target,
    async()=>fakeAccessAppResponse(apps));
  assert.equal(await verify(fakeApps('Workflow')),true);
  for(const mutate of [
    apps=>{apps[1].policies[1].include.push({email:{email:'outsider@example.invalid'}});},
    apps=>{apps[1].policies[1].include.pop();},
    apps=>{apps[1].policies[1].include[0]={email:{email:'lirtual@gmail.com'}};},
    apps=>{apps[1].policies[1].include[0]={email:{email:'lirtual@qq.com',other:true}};},
    apps=>{apps[1].policies[1].include[0]={everyone:{}};},
    apps=>{apps[1].policies[1].id='07204847-0459-4197-b3c3-2dbe2a47a550';},
    apps=>{apps[1].policies[0].id='00000000-0000-4000-8000-000000000000';},
    apps=>{apps[0].policies[1].name='Default Allow Rule';},
  ]) {
    const apps=fakeApps('Workflow');mutate(apps);
    await assert.rejects(()=>verify(apps),/portal_access_policy_/);
  }
});
