import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyBrowserOwnerAccess, verifyBrowserActivationAccess, verifyBrowserOwnerAccessCloudflare} from './browser-owner-access.mjs';
import {readFileSync} from 'node:fs';
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
    assert.throws(()=>collectWorkerVars('browser-mcp-worker',{[name]:env[name]}),/complete|identity/);
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


const activationDomain='browser.lirtual.dpdns.org/activate/verify/*';
const activationEnv={...env,BROWSER_ACTIVATION_ORIGIN:'https://browser.lirtual.dpdns.org',
  BROWSER_ACTIVATION_AUDIENCE:'b'.repeat(64)};
const activationApp={...app,id:'77945f97-e1ea-4b2b-b89a-ec71c0472afa',
  domain:activationDomain,aud:activationEnv.BROWSER_ACTIVATION_AUDIENCE,
  self_hosted_domains:[activationDomain],destinations:[{type:'public',uri:activationDomain}]};

test('activation Access independently pins path, OTP provider, audience and exact owner',()=>{
  assert.equal(verifyBrowserActivationAccess(activationApp,[policy],idps,activationEnv),true);
  for(const invalid of [
    {...activationApp,domain:'browser.lirtual.dpdns.org/*'},
    {...activationApp,aud:env.BROWSER_ACCESS_AUDIENCE},
    {...activationApp,allowed_idps:[idps[1].id]},
    {...activationApp,destinations:[{type:'public',uri:activationDomain,overrides:[{path_pattern:'/*',behavior:'public'}]}]}
  ])assert.throws(()=>verifyBrowserActivationAccess(invalid,[policy],idps,activationEnv));
  assert.throws(()=>verifyBrowserActivationAccess(activationApp,
    [{...policy,include:[{email:{email:'other@example.com'}}]}],idps,activationEnv),/policy_identity/);
});

test('release gate verifies both Access apps, and activation alone, without mutating',async()=>{
  for(const activationOnly of [false,true]){
    const seen=[];
    const cfg=activationOnly?{
      BROWSER_ACCESS_ISSUER:env.BROWSER_ACCESS_ISSUER,
      BROWSER_OWNER_EMAIL:env.BROWSER_OWNER_EMAIL,
      BROWSER_ACTIVATION_ORIGIN:activationEnv.BROWSER_ACTIVATION_ORIGIN,
      BROWSER_ACTIVATION_AUDIENCE:activationEnv.BROWSER_ACTIVATION_AUDIENCE,
      CLOUDFLARE_ACCOUNT_ID:env.CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN:env.CLOUDFLARE_API_TOKEN
    }:activationEnv;
    const transport=async(url)=>{seen.push(url);
      const result=url.includes('/identity_providers')?idps:
        url.includes('/policies?')?[policy]:url.includes(activationApp.id)?activationApp:app;
      return{ok:true,json:async()=>({success:true,result})};
    };
    assert.equal(await verifyBrowserOwnerAccessCloudflare(cfg,transport),true);
    assert.equal(seen.length,activationOnly?3:5);
    assert.equal(seen.filter(u=>u.includes('/identity_providers')).length,1);
    assert.ok(seen.some(u=>u.includes(activationApp.id)));
  }
});

test('manual release stages activation variables to Worker and Access verification',()=>{
  const yml=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  for(const name of ['BROWSER_ACTIVATION_ORIGIN','BROWSER_ACTIVATION_AUDIENCE']){
    assert.equal(yml.split('\n').filter(line=>line.startsWith('          '+name+': ')).length,2);
    assert.ok(yml.includes('vars.'+name));
  }
});
