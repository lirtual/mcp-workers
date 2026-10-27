import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyMcpAccessPolicies } from './verify-mcp-access-policies.mjs';

const env = {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token',
};
const policies = () => [
  {id:'11111111-1111-4111-8111-111111111111',name:'WORKFLOWS',
   decision:'non_identity',precedence:1,reusable:true,
   include:[{service_token:{token_id:'synthetic-id'}}],exclude:[],require:[]},
  {id:'22222222-2222-4222-8222-222222222222',name:'Default Allow Rule',
   decision:'allow',precedence:2,reusable:true,
   include:[{email:{email:'synthetic@example.invalid'}}],exclude:[],require:[]},
];
export const fakeApps = (name='OpenList MCP') => [
  {id:'portal',name:'One-MCP',type:'mcp_portal',
   domain:'mcp.lirtual.dpdns.org',policies:policies()},
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
    fakeApps().filter(x=>x.name!=='One-MCP'),
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
