// Read-only Browser Profile Activation (#531) Access release gate.
// After the production cutover, only the exact Cloudflare account-member SSO + OTP
// configuration is accepted; OTP-only rollback or incomplete inventories fail closed. No API writes.
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { collectWorkerVars } from "./worker-release-variables.mjs";

const ACTIVATION_APP_ID = "77945f97-e1ea-4b2b-b89a-ec71c0472afa";
const ACTIVATION_DOMAIN = "browser.lirtual.dpdns.org/activate/verify/*";
// Current independently inspected Access policy and identity-provider identities.
// Changing these trust boundaries requires reviewed code and a separate release.
const REVIEWED_POLICY_ID = "a9ad0c55-9533-4391-ad59-60018b264401";
const REVIEWED_IDPS = new Set([
  "6a3456ba-dd71-47e9-a888-b53aaa5dc93b", // OTP
  "26b88b6c-81e8-4f70-93ba-8af984bd5d63", // account-member SSO
]);
const fail = (ok,code) => {if(!ok)throw Error(code);};
function responseList(body,code) {
  const info=body?.result_info;
  fail(body?.success === true && Array.isArray(body.result) &&
    body.result.length <= 100 &&
    Number.isSafeInteger(info?.page) && info.page === 1 &&
    Number.isSafeInteger(info?.per_page) && info.per_page === 100 &&
    Number.isSafeInteger(info?.count) && info.count === body.result.length &&
    Number.isSafeInteger(info?.total_count) && info.total_count === body.result.length &&
    Number.isSafeInteger(info?.total_pages) && info.total_pages === 1,code);
  return body.result;
}
export function verifyBrowserActivationAccess(app,policies,providers,env) {
  fail(app?.id === ACTIVATION_APP_ID && app.type === "self_hosted" &&
    app.domain === ACTIVATION_DOMAIN && app.aud === env.BROWSER_ACTIVATION_AUDIENCE &&
    Array.isArray(app.self_hosted_domains) && app.self_hosted_domains.length === 1 &&
    app.self_hosted_domains[0] === ACTIVATION_DOMAIN &&
    Array.isArray(app.destinations) && app.destinations.length === 1 &&
    app.destinations[0]?.type === "public" &&
    app.destinations[0]?.uri === ACTIVATION_DOMAIN &&
    (!app.destinations[0]?.overrides || app.destinations[0].overrides.length === 0),
    "app_identity");
  fail(app.session_duration === "15m","app_session");
  const otp = providers.filter(p=>p?.type === "onetimepin");
  const cloudflare = providers.filter(p=>p?.type === "cloudflare" &&
    p.config?.restrict_to_account_members === true);
  fail(otp.length===1 && /^[a-f0-9-]{36}$/i.test(otp[0].id),"otp_provider");
  fail(Array.isArray(app.allowed_idps) && app.allowed_idps.includes(otp[0].id),"otp_pin");
  fail(app.allowed_idps.length===2 && app.auto_redirect_to_identity===false &&
    cloudflare.length===1 && app.allowed_idps.includes(cloudflare[0].id),
    "idp_scope");
  fail(new Set(app.allowed_idps).size === app.allowed_idps.length &&
    app.allowed_idps.every(id=>REVIEWED_IDPS.has(id)),"idp_scope");
  fail(Array.isArray(policies) && policies.length===1,"policy_count");
  const policy=policies[0];
  fail(policy.id===REVIEWED_POLICY_ID && policy.decision==="allow" &&
    Array.isArray(policy.include) &&
    policy.include.length===1 && Object.keys(policy.include[0]).join()==="email" &&
    policy.include[0].email?.email===env.BROWSER_OWNER_EMAIL &&
    (policy.require==null || Array.isArray(policy.require) && policy.require.length===0) &&
    (policy.exclude==null || Array.isArray(policy.exclude) && policy.exclude.length===0),
    "policy_identity");
  return true;
}
// Read-only discovery: Cloudflare's Organization and the *fixed* reviewed App
// are sources, not user-supplied Audience/Team Domain GitHub Variables.
export async function discoverBrowserActivationIdentity(env,transport=fetch) {
  fail(/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID??"") &&
    typeof env.CLOUDFLARE_API_TOKEN==="string" && env.CLOUDFLARE_API_TOKEN.length>0,
    "cloudflare_credentials");
  fail(typeof env.OWNER_EMAIL==="string" && env.OWNER_EMAIL.length<=256 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(env.OWNER_EMAIL),"owner_email");
  const base="https://api.cloudflare.com/client/v4/accounts/"+env.CLOUDFLARE_ACCOUNT_ID;
  const get=async(path,code)=>{
    let response;
    try{response=await transport(base+path,{headers:{
      authorization:"Bearer "+env.CLOUDFLARE_API_TOKEN,accept:"application/json"
    },signal:AbortSignal.timeout(15000)});}catch{throw Error(code+"_transport");}
    fail(response?.ok===true,code+"_http");
    let body;
    try{body=await response.json();}catch{throw Error(code+"_json");}
    fail(body?.success===true && body.result!=null,code+"_api");
    return body;
  };
  const [org,app,policies,providers]=await Promise.all([
    get("/access/organizations","organization"),
    get("/access/apps/"+ACTIVATION_APP_ID,"app"),
    get("/access/apps/"+ACTIVATION_APP_ID+"/policies?per_page=100","policies"),
    get("/access/identity_providers?per_page=100","providers")
  ]);
  const teamDomain=org.result?.auth_domain;
  fail(typeof teamDomain==="string" &&
    /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain) &&
    teamDomain.length<=256,"organization_identity");
  const audience=app.result?.aud;
  fail(typeof audience==="string" && /^[a-f0-9]{64}$/.test(audience),
    "app_audience");
  const config=JSON.parse(readFileSync(new URL("../apps/browser-mcp-worker/wrangler.jsonc",import.meta.url),"utf8"));
  const staged=collectWorkerVars("browser-mcp-worker",{
    ACCESS_TEAM_DOMAIN:teamDomain,OWNER_EMAIL:env.OWNER_EMAIL,
    BROWSER_ACTIVATION_AUDIENCE:audience
  },{config});
  const actual=Object.fromEntries(staged.map(pair=>[pair.slice(0,pair.indexOf(":")),pair.slice(pair.indexOf(":")+1)]));
  const policyRows=responseList(policies,"policies_inventory");
  const providerRows=responseList(providers,"providers_inventory");
  verifyBrowserActivationAccess(app.result,policyRows,providerRows,actual);
  const policyId=policyRows[0]?.id;
  fail(typeof policyId==="string" && /^[a-f0-9-]{36}$/i.test(policyId),
    "policy_identity");
  return {
    accountId:env.CLOUDFLARE_ACCOUNT_ID,appId:ACTIVATION_APP_ID,
    teamDomain,ownerEmail:env.OWNER_EMAIL,audience,
    origin:actual.BROWSER_ACTIVATION_ORIGIN,policyId,
    identityProviders:[...app.result.allowed_idps].sort(),
  };
}
export function verifyBrowserIdentityContinuity(candidate,actual) {
  fail(candidate && actual && Object.keys(candidate).length===8 &&
    JSON.stringify(candidate)===JSON.stringify(actual),"identity_drift");
  return true;
}
export async function verifyBrowserActivationAccessCloudflare(env,transport=fetch) {
  await discoverBrowserActivationIdentity(env,transport);
  return true;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  discoverBrowserActivationIdentity(process.env).then(()=>{
    console.log("Browser Profile Activation Access read-only gate: PASS");
  }).catch(error=>{
    console.error("Browser Profile Activation Access gate: BLOCKED ("+
      (/^[a-z_]+$/.test(error?.message??"")?error.message:"invalid_config")+")");
    process.exitCode=1;
  });
}
