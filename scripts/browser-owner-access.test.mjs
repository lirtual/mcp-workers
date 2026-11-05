import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyBrowserActivationAccess,verifyBrowserActivationAccessCloudflare} from './browser-owner-access.mjs';
import {readFileSync} from 'node:fs';
import {collectWorkerVars,BROWSER_ACCESS_VARIABLES} from './worker-release-variables.mjs';

const env={ACCESS_TEAM_DOMAIN:'lirtualzero.cloudflareaccess.com',
  OWNER_EMAIL:'lirtual@outlook.com',
  BROWSER_ACTIVATION_AUDIENCE:'b'.repeat(64),
  CLOUDFLARE_ACCOUNT_ID:'c'.repeat(32),CLOUDFLARE_API_TOKEN:'test-only'};
const domain='browser.lirtual.dpdns.org/activate/verify/*';
const otp={id:'11111111-1111-4111-8111-111111111111',type:'onetimepin'};
const cf={id:'22222222-2222-4222-8222-222222222222',type:'cloudflare',
  config:{restrict_to_account_members:true}};
const providers=[otp,cf];
const app={id:'77945f97-e1ea-4b2b-b89a-ec71c0472afa',type:'self_hosted',
  domain,aud:env.BROWSER_ACTIVATION_AUDIENCE,self_hosted_domains:[domain],
  destinations:[{type:'public',uri:domain}],allowed_idps:[otp.id,cf.id],
  auto_redirect_to_identity:false,session_duration:'15m'};
const policy={decision:'allow',include:[{email:{email:env.OWNER_EMAIL}}],
  require:[],exclude:[]};

test('Browser staging uses global identity and only reviewed Wrangler route',async()=>{
  const cfg=JSON.parse(readFileSync(new URL('../apps/browser-mcp-worker/wrangler.jsonc',import.meta.url),'utf8'));
  assert.deepEqual(collectWorkerVars('browser-mcp-worker',env,{config:cfg}),[
    'BROWSER_ACCESS_ISSUER:https://lirtualzero.cloudflareaccess.com',
    'BROWSER_OWNER_EMAIL:lirtual@outlook.com',
    'BROWSER_ACTIVATION_ORIGIN:https://browser.lirtual.dpdns.org',
    'BROWSER_ACTIVATION_AUDIENCE:'+'b'.repeat(64)
  ]);
  assert.deepEqual(collectWorkerVars('browser-mcp-worker',{
    ...env,BROWSER_APPROVAL_ORIGIN:'https://wrong.example',
    BROWSER_ACCESS_AUDIENCE:'a'.repeat(64),
    BROWSER_APPROVAL_ISOLATION:'isolated-owner-profile-and-mailbox-v1'
  },{config:cfg}),collectWorkerVars('browser-mcp-worker',env,{config:cfg}));
  assert.throws(()=>collectWorkerVars('browser-mcp-worker',{
    ...env,BROWSER_OWNER_EMAIL:'wrong@example.com'},{config:cfg}),/obsolete/);
  await assert.rejects(verifyBrowserActivationAccessCloudflare({},()=>{throw Error('unexpected request')}),
    /activation_config_required/);
});
test('only exact Cloudflare account-member SSO plus OTP is accepted after cutover',()=>{
  assert.equal(verifyBrowserActivationAccess(app,[policy],providers,{BROWSER_OWNER_EMAIL:env.OWNER_EMAIL,BROWSER_ACTIVATION_AUDIENCE:env.BROWSER_ACTIVATION_AUDIENCE}),true);
  const dual=app;
  assert.equal(verifyBrowserActivationAccess({...app,allowed_idps:[cf.id,otp.id]},[policy],providers,{...env,BROWSER_OWNER_EMAIL:env.OWNER_EMAIL}),true);
  for(const bad of [
    {...app,allowed_idps:[]},{...app,allowed_idps:[cf.id]},
    {...app,allowed_idps:[otp.id],auto_redirect_to_identity:true},
    {...app,allowed_idps:[otp.id],auto_redirect_to_identity:false},
    {...app,allowed_idps:[otp.id,otp.id],auto_redirect_to_identity:false},
    {...app,allowed_idps:[otp.id,cf.id],auto_redirect_to_identity:true},
    {...app,allowed_idps:[otp.id,cf.id,'33333333-3333-4333-8333-333333333333']},
    {...app,aud:'other'},
    {...app,domain:'browser.lirtual.dpdns.org/*'},
    {...app,session_duration:'24h'},
    {...app,destinations:[{type:'public',uri:domain,overrides:[{}]}]}
  ])assert.throws(()=>verifyBrowserActivationAccess(bad,[policy],providers,{...env,BROWSER_OWNER_EMAIL:env.OWNER_EMAIL}));
  assert.throws(()=>verifyBrowserActivationAccess(dual,[policy],
    [otp,{...cf,config:{restrict_to_account_members:false}}],{...env,BROWSER_OWNER_EMAIL:env.OWNER_EMAIL}),/idp_scope/);
  assert.throws(()=>verifyBrowserActivationAccess(dual,[policy],
    [otp,{...cf,config:{}}],{...env,BROWSER_OWNER_EMAIL:env.OWNER_EMAIL}),/idp_scope/);
  assert.throws(()=>verifyBrowserActivationAccess(dual,[{
    ...policy,include:[{email:{email:'other@example.com'}}]}],providers,{...env,BROWSER_OWNER_EMAIL:env.OWNER_EMAIL}),/policy_identity/);
  assert.throws(()=>verifyBrowserActivationAccess(dual,[{
    ...policy,include:[{everyone:{}}]}],providers,{...env,BROWSER_OWNER_EMAIL:env.OWNER_EMAIL}),/policy_identity/);
  assert.throws(()=>verifyBrowserActivationAccess(dual,[policy,policy],providers,{...env,BROWSER_OWNER_EMAIL:env.OWNER_EMAIL}),/policy_count/);
});
const inventoryInfo=result=>({page:1,per_page:100,count:result.length,total_count:result.length,total_pages:1});
const mockedResponse=(result,info=Array.isArray(result)?inventoryInfo(result):undefined)=>({
  ok:true,json:async()=>({success:true,result,...(info===undefined?{}:{result_info:info})})
});

test('prepublication gate reads only Activation app, complete policies, and IdP inventory',async()=>{
  const seen=[];
  const transport=async(url,opts)=>{
    seen.push(url);assert.equal(opts.headers.authorization,'Bearer test-only');
    const result=url.includes('/identity_providers')?providers:
      url.includes('/policies?')?[policy]:app;
    return mockedResponse(result);
  };
  assert.equal(await verifyBrowserActivationAccessCloudflare(env,transport),true);
  assert.equal(seen.length,3);
  assert.ok(seen.every(url=>url.startsWith('https://api.cloudflare.com/client/v4/accounts/')));
  assert.ok(seen.every(url=>url.includes('/access/')));
  assert.ok(!seen.some(url=>url.includes('/owner/')));
  await assert.rejects(verifyBrowserActivationAccessCloudflare(env,async url=>{
    const result=url.includes('/identity_providers')?providers:url.includes('/policies?')?[policy]:
      {...app,allowed_idps:[]};
    return mockedResponse(result);
  }),/otp_pin/);
});

test('policy and provider inventory must prove complete single-page results',async()=>{
  const badInfos=[
    undefined,
    {page:1,per_page:100,count:1,total_count:1,total_pages:2},
    {page:2,per_page:100,count:1,total_count:1,total_pages:1},
    {page:1,per_page:99,count:1,total_count:1,total_pages:1},
    {page:1,per_page:100,count:0,total_count:1,total_pages:1},
    {page:1,per_page:100,count:1,total_count:2,total_pages:1},
    {page:1,per_page:100,count:1,total_count:1,total_pages:0},
    {page:1,per_page:100,count:'1',total_count:1,total_pages:1},
    {page:1,per_page:100,count:1,total_count:1.5,total_pages:1}
  ];
  for(const source of ['policies','providers']){
    for(const info of badInfos){
      const transport=async url=>{
        const isPolicy=url.includes('/policies?');
        const isProvider=url.includes('/identity_providers?');
        const result=isProvider?providers:isPolicy?[policy]:app;
        if(source==='policies'&&isPolicy || source==='providers'&&isProvider)
          return {ok:true,json:async()=>({success:true,result,...(info===undefined?{}:{result_info:info})})};
        return mockedResponse(result);
      };
      await assert.rejects(verifyBrowserActivationAccessCloudflare(env,transport),
        new RegExp(source+'_inventory'));
    }
  }
});

test('release consumes shared Browser identity and independent activation Audience',()=>{
  const yml=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  for(const name of ['ACCESS_TEAM_DOMAIN','OWNER_EMAIL','BROWSER_ACTIVATION_AUDIENCE'])
    assert.ok(yml.includes('vars.'+name));
  for(const obsolete of ['vars.BROWSER_OWNER_EMAIL','vars.BROWSER_ACCESS_ISSUER',
    'vars.BROWSER_ACTIVATION_ORIGIN'])assert.ok(!yml.includes(obsolete));
});
