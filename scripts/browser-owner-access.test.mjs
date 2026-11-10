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
const otp={id:'6a3456ba-dd71-47e9-a888-b53aaa5dc93b',type:'onetimepin'};
const cf={id:'26b88b6c-81e8-4f70-93ba-8af984bd5d63',type:'cloudflare',
  config:{restrict_to_account_members:true}};
const providers=[otp,cf];
const app={id:'77945f97-e1ea-4b2b-b89a-ec71c0472afa',type:'self_hosted',
  domain,aud:env.BROWSER_ACTIVATION_AUDIENCE,self_hosted_domains:[domain],
  destinations:[{type:'public',uri:domain}],allowed_idps:[otp.id,cf.id],
  auto_redirect_to_identity:false,session_duration:'15m'};
const policy={id:'a9ad0c55-9533-4391-ad59-60018b264401',decision:'allow',include:[{email:{email:env.OWNER_EMAIL}}],
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
    /cloudflare_credentials/);
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
    {...app,allowed_idps:[otp.id,cf.id,'a9ad0c55-9533-4391-ad59-60018b264401']},
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
    const result=url.includes('/access/organizations')?{auth_domain:env.ACCESS_TEAM_DOMAIN}:
      url.includes('/identity_providers')?providers:
      url.includes('/policies?')?[policy]:app;
    return mockedResponse(result);
  };
  assert.equal(await verifyBrowserActivationAccessCloudflare(env,transport),true);
  assert.equal(seen.length,4);
  assert.ok(seen.every(url=>url.startsWith('https://api.cloudflare.com/client/v4/accounts/')));
  assert.ok(seen.every(url=>url.includes('/access/')));
  assert.ok(!seen.some(url=>url.includes('/owner/')));
  await assert.rejects(verifyBrowserActivationAccessCloudflare(env,async url=>{
    const result=url.includes('/access/organizations')?{auth_domain:env.ACCESS_TEAM_DOMAIN}:
      url.includes('/identity_providers')?providers:url.includes('/policies?')?[policy]:
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
        const result=url.includes('/access/organizations')?{auth_domain:env.ACCESS_TEAM_DOMAIN}:
          isProvider?providers:isPolicy?[policy]:app;
        if(source==='policies'&&isPolicy || source==='providers'&&isProvider)
          return {ok:true,json:async()=>({success:true,result,...(info===undefined?{}:{result_info:info})})};
        return mockedResponse(result);
      };
      await assert.rejects(verifyBrowserActivationAccessCloudflare(env,transport),
        new RegExp(source+'_inventory'));
    }
  }
});

test('Browser release consumes only Owner Email and discovered identity',()=>{
  const yml=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  assert.ok(yml.includes('vars.OWNER_EMAIL'));
  for(const obsolete of ['vars.ACCESS_TEAM_DOMAIN','vars.BROWSER_ACTIVATION_AUDIENCE',
    'vars.BROWSER_OWNER_EMAIL','vars.BROWSER_ACCESS_ISSUER',
    'vars.BROWSER_ACTIVATION_ORIGIN'])assert.ok(!yml.includes(obsolete));
  assert.match(yml,/node scripts\/manual-worker-release\.mjs identity-recheck/);
  assert.ok(yml.indexOf('manual-worker-release.mjs identity-recheck') <
    yml.indexOf('Publish exactly selected Worker'));
});

test('Spec #804 discovers Browser identity from the Zero Trust organization and fixed app',async()=>{
  const {discoverBrowserActivationIdentity}=await import('./browser-owner-access.mjs');
  const urls=[];
  const transport=async url=>{
    urls.push(url);
    const result=url.includes('/access/organizations')?{auth_domain:env.ACCESS_TEAM_DOMAIN}:
      url.includes('/identity_providers')?providers:
      url.includes('/policies?')?[{...policy,id:'a9ad0c55-9533-4391-ad59-60018b264401'}]:app;
    return mockedResponse(result);
  };
  const found=await discoverBrowserActivationIdentity(env,transport);
  assert.deepEqual(found,{
    accountId:env.CLOUDFLARE_ACCOUNT_ID,appId:app.id,
    teamDomain:env.ACCESS_TEAM_DOMAIN,ownerEmail:env.OWNER_EMAIL,
    audience:app.aud,origin:'https://browser.lirtual.dpdns.org',
    policyId:'a9ad0c55-9533-4391-ad59-60018b264401',
    identityProviders:[cf.id,otp.id].sort(),
  });
  assert.equal(urls.filter(url=>url.endsWith('/access/organizations')).length,1);
  assert.ok(urls.every(url=>url.includes('/accounts/'+env.CLOUDFLARE_ACCOUNT_ID+'/access/')));
  const denied=async url=>url.includes('/access/organizations')
    ?{ok:false,status:403,json:async()=>({success:false})}:transport(url);
  await assert.rejects(discoverBrowserActivationIdentity(env,denied),/organization_http/);
});

test('Spec #804 fails closed on Organization, Audience, policy, provider or candidate drift',async()=>{
  const {discoverBrowserActivationIdentity,verifyBrowserIdentityContinuity}=
    await import('./browser-owner-access.mjs');
  const valid=async(url)=>{
    const result=url.includes('/access/organizations')?{auth_domain:env.ACCESS_TEAM_DOMAIN}:
      url.includes('/identity_providers')?providers:
      url.includes('/policies?')?[policy]:app;
    return mockedResponse(result);
  };
  const initial=await discoverBrowserActivationIdentity(env,valid);
  assert.equal(verifyBrowserIdentityContinuity(initial,{...initial}),true);
  for(const key of ['accountId','teamDomain','appId','policyId','audience','ownerEmail','origin']){
    await assert.rejects(async()=>verifyBrowserIdentityContinuity(initial,
      {...initial,[key]:'changed'}),/identity_drift/);
  }
  await assert.rejects(async()=>verifyBrowserIdentityContinuity(initial,
    {...initial,identityProviders:[otp.id]}),/identity_drift/);
  const rejects=[
    [url=>url.includes('/access/organizations'),{auth_domain:'other.cloudflareaccess.com'},/organization_identity|identity_drift/],
    [url=>url.includes('/access/organizations'),{auth_domain:'https://owner.cloudflareaccess.com'},/organization_identity/],
    [url=>url.includes('/access/apps/')&&!url.includes('/policies?'),{...app,aud:'wrong'},/app_audience/],
    [url=>url.includes('/access/apps/')&&!url.includes('/policies?'),{...app,domain:'browser.lirtual.dpdns.org/*'},/app_identity/],
    [url=>url.includes('/policies?'),[{...policy,id:'00000000-0000-4000-8000-000000000000'}],/policy_identity/],
    [url=>url.includes('/identity_providers'),[otp,{...cf,config:{restrict_to_account_members:false}}],/idp_scope/],
  ];
  for(const [match,replacement,code] of rejects){
    const overridden=async url=>match(url)?mockedResponse(replacement):valid(url);
    if(code.source.includes('identity_drift')){
      const discovered=await discoverBrowserActivationIdentity(env,overridden);
      assert.throws(()=>verifyBrowserIdentityContinuity(initial,discovered),/identity_drift/);
    }else await assert.rejects(discoverBrowserActivationIdentity(env,overridden),code);
  }
  await assert.rejects(discoverBrowserActivationIdentity(
    {...env,CLOUDFLARE_ACCOUNT_ID:'wrong'},valid),/cloudflare_credentials/);
});
