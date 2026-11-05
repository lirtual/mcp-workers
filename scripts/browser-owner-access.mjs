// Read-only Browser Profile Activation (#531) Access release gate.
// After the production cutover, only the exact Cloudflare account-member SSO + OTP
// configuration is accepted; OTP-only rollback or incomplete inventories fail closed. No API writes.
import { pathToFileURL } from "node:url";
import { collectWorkerVars } from "./worker-release-variables.mjs";

const ACTIVATION_APP_ID = "77945f97-e1ea-4b2b-b89a-ec71c0472afa";
const ACTIVATION_DOMAIN = "browser.lirtual.dpdns.org/activate/verify/*";
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
  fail(new Set(app.allowed_idps).size === app.allowed_idps.length,"idp_scope");
  fail(Array.isArray(policies) && policies.length===1,"policy_count");
  const policy=policies[0];
  fail(policy.decision==="allow" && Array.isArray(policy.include) &&
    policy.include.length===1 && Object.keys(policy.include[0]).join()==="email" &&
    policy.include[0].email?.email===env.BROWSER_OWNER_EMAIL &&
    (policy.require==null || Array.isArray(policy.require) && policy.require.length===0) &&
    (policy.exclude==null || Array.isArray(policy.exclude) && policy.exclude.length===0),
    "policy_identity");
  return true;
}
export async function verifyBrowserActivationAccessCloudflare(env,transport=fetch) {
  const enabled=["BROWSER_ACTIVATION_ORIGIN","BROWSER_ACTIVATION_AUDIENCE"]
    .some(k=>env[k]!=null&&env[k]!=="");
  fail(enabled,"activation_config_required");
  collectWorkerVars("browser-mcp-worker",env);
  fail(/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID??"") &&
    typeof env.CLOUDFLARE_API_TOKEN==="string" && env.CLOUDFLARE_API_TOKEN.length>0,
    "cloudflare_credentials");
  const base="https://api.cloudflare.com/client/v4/accounts/"+env.CLOUDFLARE_ACCOUNT_ID;
  const get=async(path,code)=>{
    let response;
    try{response=await transport(base+path,{headers:{
      authorization:"Bearer "+env.CLOUDFLARE_API_TOKEN,accept:"application/json"
    },signal:AbortSignal.timeout(15000)});}catch{throw Error(code+"_transport");}
    fail(response.ok,code+"_http");
    let body;
    try{body=await response.json();}catch{throw Error(code+"_json");}
    fail(body?.success===true,code+"_api");
    return body;
  };
  const [app,policies,providers]=await Promise.all([
    get("/access/apps/"+ACTIVATION_APP_ID,"app"),
    get("/access/apps/"+ACTIVATION_APP_ID+"/policies?per_page=100","policies"),
    get("/access/identity_providers?per_page=100","providers")
  ]);
  return verifyBrowserActivationAccess(app.result,
    responseList(policies,"policies_inventory"),
    responseList(providers,"providers_inventory"),env);
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  verifyBrowserActivationAccessCloudflare(process.env).then(()=>{
    console.log("Browser Profile Activation Access prepublication gate: PASS");
  }).catch(error=>{
    const codes=new Set(["activation_config_required","app_identity","app_session","otp_provider","otp_pin","idp_scope",
      "policy_count","policy_identity","cloudflare_credentials","app_transport",
      "app_http","app_json","app_api","policies_transport","policies_http",
      "policies_json","policies_api","providers_transport","providers_http",
      "providers_json","providers_api","policies_inventory","providers_inventory"]);
    console.error("Browser Profile Activation Access gate: BLOCKED ("+
      (codes.has(error?.message)?error.message:"invalid_config")+")");
    process.exitCode=1;
  });
}
