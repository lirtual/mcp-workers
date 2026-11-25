import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyMcpAccessPolicies } from './verify-mcp-access-policies.mjs';

const env = {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token',
};
import { accessApplications as fakeApps } from './portal-access.test-fixture.mjs';
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
    apps=>{apps[1].policies[0].include=[{everyone:{}}];},
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
    fakeApps().filter(x=>x.name!=='MCP Portal'),
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

const browserTarget={id:'browser',name:'Browser'};
test('Browser shares the reviewed three-owner and two-token policy set',async()=>{
  const verify=(apps,target=browserTarget)=>verifyMcpAccessPolicies(env,target,
    async()=>fakeAccessAppResponse(apps));
  assert.equal(await verify(fakeApps('Browser')),true);
  for(const mutate of [
    apps=>{apps[1].policies[1].id='07204847-0459-4197-b3c3-2dbe2a47a550';},
    apps=>{apps[1].policies[1].name='MCP Portal and Browser Owners';},
    apps=>{apps[1].policies[1].include.pop();},
    apps=>{apps[1].policies[1].include.push({email:{email:'outsider@example.invalid'}});},
    apps=>{apps[1].policies[1].include=[{everyone:{}}];},
    apps=>{apps[1].policies[1].precedence=1;},
    apps=>{apps[1].policies[0].id='33333333-3333-4333-8333-333333333333';},
    apps=>{apps[0].policies[1].include.push({email:{email:'outsider@example.invalid'}});},
  ]) {
    const apps=fakeApps('Browser');mutate(apps);
    await assert.rejects(()=>verify(apps),/portal_access_policy_/);
  }
  await assert.rejects(()=>verify(fakeApps('Browser'),{id:'other',name:'Browser'}),/portal_access_policy_/);
  await assert.rejects(()=>verify(fakeApps('Browser'),{id:'browser',name:'Other'}),/portal_access_policy_/);
});

test('Workflow requires the exact current policy IDs, owner emails and both independent service tokens',async()=>{
  const target={id:'workflow',name:'Workflow'};
  const verify=apps=>verifyMcpAccessPolicies(env,target,async()=>fakeAccessAppResponse(apps));
  assert.equal(await verify(fakeApps('Workflow')),true);
  for(const mutate of [
    apps=>{apps[1].policies[0].include.push({email:{email:'outsider@example.invalid'}});},
    apps=>{apps[1].policies[0].include.pop();},
    apps=>{apps[1].policies[0].include[0]={email:{email:'lirtual@gmail.com'}};},
    apps=>{apps[1].policies[0].include[0]={email:{email:'lirtual@qq.com',other:true}};},
    apps=>{apps[1].policies[0].include[0]={everyone:{}};},
    apps=>{apps[1].policies[0].id='07204847-0459-4197-b3c3-2dbe2a47a550';},
    apps=>{apps[1].policies[1].id='7cec582c-4038-4fb0-9ad8-fcdb04af4adc';},
    apps=>{apps[1].policies[1].include.pop();},
    apps=>{apps[1].policies[1].include.push({service_token:{token_id:'third'}});},
    apps=>{apps[1].policies[1].include[0]=structuredClone(apps[1].policies[1].include[1]);},
    apps=>{apps[1].policies[1].include[0]={service_token:{token_id:'unknown'}};},
    apps=>{apps[1].policies[1].include[0].service_token.extra=true;},
    apps=>{apps[1].policies[1].include[0].everyone={};},
    apps=>{apps[1].policies[1].require=[{email:{email:'outsider@example.invalid'}}];},
    apps=>{apps[1].policies[1].exclude=[{everyone:{}}];},
    apps=>{apps[0].policies[1].name='MCP Portal and Browser Owners';},
  ]) {
    const apps=fakeApps('Workflow');mutate(apps);
    await assert.rejects(()=>verify(apps),/portal_access_policy_/);
  }
});
