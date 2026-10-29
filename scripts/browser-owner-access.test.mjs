import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyBrowserOwnerAccess, verifyBrowserOwnerAccessCloudflare} from './browser-owner-access.mjs';
import {collectWorkerVars, BROWSER_APPROVAL_VARIABLES} from './worker-release-variables.mjs';
const env={BROWSER_APPROVAL_ORIGIN:'https://browser.lirtual.dpdns.org',
  BROWSER_ACCESS_ISSUER:'https://lirtualzero.cloudflareaccess.com',
  BROWSER_ACCESS_AUDIENCE:'a'.repeat(64),BROWSER_OWNER_EMAIL:'lirtual@outlook.com',
  BROWSER_APPROVAL_ISOLATION:'isolated-owner-profile-and-mailbox-v1',
  CLOUDFLARE_ACCOUNT_ID:'b'.repeat(32),CLOUDFLARE_API_TOKEN:'test-only'};
const app={id:'3a929fad-6ef5-433d-91df-3d6c77493f68',type:'self_hosted',
  domain:'browser.lirtual.dpdns.org/owner/*',aud:env.BROWSER_ACCESS_AUDIENCE,
  self_hosted_domains:['browser.lirtual.dpdns.org/owner/*'],
  destinations:[{type:'public',uri:'browser.lirtual.dpdns.org/owner/*'}],
  allowed_idps:['11111111-1111-4111-8111-111111111111'],
  auto_redirect_to_identity:true,session_duration:'15m'};
const policy={decision:'allow',include:[{email:{email:'lirtual@outlook.com'}}],require:[],exclude:[]};
const idps=[{id:app.allowed_idps[0],type:'onetimepin'},{id:'22222222-2222-4222-8222-222222222222',type:'cloudflare'}];
test('ordinary Browser releases remain disabled without any owner approval variables or API calls',async()=>{
  assert.deepEqual(collectWorkerVars('browser-mcp-worker',{}),[]);
  assert.equal(await verifyBrowserOwnerAccessCloudflare({},()=>{throw Error('unexpected request')}),false);
  for(const name of BROWSER_APPROVAL_VARIABLES){
    assert.throws(()=>collectWorkerVars('browser-mcp-worker',{[name]:env[name]}),/all five/);
  }
  assert.throws(()=>collectWorkerVars('browser-mcp-worker',{...env,BROWSER_OWNER_EMAIL:'agent@example.com'}),/identity/);
  assert.equal(collectWorkerVars('browser-mcp-worker',env).length,5);
});
test('owner Access must pin one OTP identity provider and exact-email policy',()=>{
  assert.equal(verifyBrowserOwnerAccess(app,[policy],idps,env),true);
  for(const invalid of [[],idps.map(x=>x.id),[idps[1].id]])
    assert.throws(()=>verifyBrowserOwnerAccess({...app,allowed_idps:invalid},[policy],idps,env),/otp_pin/);
  assert.throws(()=>verifyBrowserOwnerAccess({...app,aud:'other'},[policy],idps,env),/app_identity/);
  assert.throws(()=>verifyBrowserOwnerAccess({...app,self_hosted_domains:[...app.self_hosted_domains,'other.example/*']},[policy],idps,env),/app_identity/);
  assert.throws(()=>verifyBrowserOwnerAccess({...app,destinations:[...app.destinations,{type:'public',uri:'other.example/*'}]},[policy],idps,env),/app_identity/);
  assert.throws(()=>verifyBrowserOwnerAccess({...app,auto_redirect_to_identity:false},[policy],idps,env),/app_session/);
  assert.throws(()=>verifyBrowserOwnerAccess(app,[{...policy,include:[{everyone:{}}]}],idps,env),/policy_identity/);
  assert.throws(()=>verifyBrowserOwnerAccess(app,[policy,policy],idps,env),/policy_count/);
  assert.throws(()=>verifyBrowserOwnerAccess(app,[policy],[idps[1]],env),/otp_provider/);
});
test('activation prepublication gate only reads three bounded Cloudflare inventories',async()=>{
  const seen=[];
  const transport=async(url,opts)=>{seen.push(url);assert.equal(opts.headers.authorization,'Bearer test-only');
    let result=url.includes('/identity_providers')?idps:url.includes('/policies?')?[policy]:app;
    return {ok:true,json:async()=>({success:true,result})};};
  assert.equal(await verifyBrowserOwnerAccessCloudflare(env,transport),true);
  assert.equal(seen.length,3);
  assert.ok(seen.every(url=>url.startsWith('https://api.cloudflare.com/client/v4/accounts/')));
  assert.ok(seen.every(url=>url.includes('/access/')));
  await assert.rejects(verifyBrowserOwnerAccessCloudflare(env,async(url,opts)=>{
    const x=await transport(url,opts);
    if(url.includes('/access/apps/')&&!url.includes('/policies?'))
      return {ok:true,json:async()=>({success:true,result:{...app,allowed_idps:[]}})};
    return x;
  }),/otp_pin/);
});
