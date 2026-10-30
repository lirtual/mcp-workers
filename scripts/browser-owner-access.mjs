// Read-only Owner Approval (#418) and Profile Activation (#531) Access release gates. Never change policies.
import { pathToFileURL } from "node:url";
import { collectWorkerVars } from "./worker-release-variables.mjs";

const APP_ID = "3a929fad-6ef5-433d-91df-3d6c77493f68";
const DOMAIN = "browser.lirtual.dpdns.org/owner/*";
const ACTIVATION_APP_ID = "77945f97-e1ea-4b2b-b89a-ec71c0472afa";
const ACTIVATION_DOMAIN = "browser.lirtual.dpdns.org/activate/verify/*";

function requireGate(ok, code) { if (!ok) throw Error(code); }
function responseList(body, code) {
  requireGate(body?.success === true && Array.isArray(body.result) &&
    (body.result_info?.total_pages ?? 1) <= 1 &&
    (body.result_info?.total_count ?? body.result.length) <= body.result.length, code);
  return body.result;
}

function verifyPinnedAccess(app, policies, providers, {id, domain, audience, email}) {
  requireGate(app?.id === id && app.type === "self_hosted" &&
    app.domain === domain && app.aud === audience &&
    Array.isArray(app.self_hosted_domains) &&
    app.self_hosted_domains.length === 1 && app.self_hosted_domains[0] === domain &&
    Array.isArray(app.destinations) && app.destinations.length === 1 &&
    app.destinations[0]?.type === "public" && app.destinations[0]?.uri === domain &&
    (!app.destinations[0]?.overrides || app.destinations[0].overrides.length === 0),
    "app_identity");
  requireGate(app.session_duration === "15m" && app.auto_redirect_to_identity === true,
    "app_session");
  const matches = providers.filter(p => p?.type === "onetimepin");
  requireGate(matches.length === 1 && /^[a-f0-9-]{36}$/i.test(matches[0].id), "otp_provider");
  requireGate(Array.isArray(app.allowed_idps) && app.allowed_idps.length === 1 &&
    app.allowed_idps[0] === matches[0].id, "otp_pin");
  requireGate(Array.isArray(policies) && policies.length === 1, "policy_count");
  const p = policies[0];
  requireGate(p.decision === "allow" && Array.isArray(p.include) && p.include.length === 1 &&
    Object.keys(p.include[0]).join() === "email" &&
    p.include[0].email?.email === email &&
    (p.require == null || Array.isArray(p.require) && p.require.length === 0) &&
    (p.exclude == null || Array.isArray(p.exclude) && p.exclude.length === 0),
    "policy_identity");
  return true;
}

export function verifyBrowserOwnerAccess(app, policies, providers, env) {
  return verifyPinnedAccess(app, policies, providers, {
    id: APP_ID, domain: DOMAIN, audience: env.BROWSER_ACCESS_AUDIENCE,
    email: env.BROWSER_OWNER_EMAIL
  });
}

export function verifyBrowserActivationAccess(app, policies, providers, env) {
  return verifyPinnedAccess(app, policies, providers, {
    id: ACTIVATION_APP_ID, domain: ACTIVATION_DOMAIN,
    audience: env.BROWSER_ACTIVATION_AUDIENCE, email: env.BROWSER_OWNER_EMAIL
  });
}

export async function verifyBrowserOwnerAccessCloudflare(env, transport = fetch) {
  // An ordinary Browser release must work with NO approval bindings.
  // Partial configuration is never allowed; the Worker itself also fails closed.
  const approvalEnabled = ["BROWSER_APPROVAL_ORIGIN", "BROWSER_ACCESS_AUDIENCE", "BROWSER_APPROVAL_ISOLATION"]
    .some(k => env[k] != null && env[k] !== "");
  const activationEnabled = ["BROWSER_ACTIVATION_ORIGIN", "BROWSER_ACTIVATION_AUDIENCE"]
    .some(k => env[k] != null && env[k] !== "");
  if (!approvalEnabled && !activationEnabled) return false;
  collectWorkerVars("browser-mcp-worker", env);
  requireGate(/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") &&
    typeof env.CLOUDFLARE_API_TOKEN === "string" && env.CLOUDFLARE_API_TOKEN.length > 0,
    "cloudflare_credentials");
  const base = "https://api.cloudflare.com/client/v4/accounts/" + env.CLOUDFLARE_ACCOUNT_ID;
  const get = async (path, code) => {
    let response;
    try { response = await transport(base + path, {headers:{
      authorization: "Bearer " + env.CLOUDFLARE_API_TOKEN,
      accept: "application/json"
    },signal:AbortSignal.timeout(15000)}); }
    catch { throw Error(code + "_transport"); }
    requireGate(response.ok, code + "_http");
    let body;
    try { body = await response.json(); } catch { throw Error(code + "_json"); }
    requireGate(body?.success === true, code + "_api");
    return body;
  };
  const providersPromise = get("/access/identity_providers?per_page=100", "providers");
  const verify = async (id, fn) => {
    const [app, policies, providers] = await Promise.all([
      get("/access/apps/" + id, "app"),
      get("/access/apps/" + id + "/policies?per_page=100", "policies"),
      providersPromise
    ]);
    return fn(app.result, responseList(policies, "policies_inventory"),
      responseList(providers, "providers_inventory"), env);
  };
  const checks = [];
  if (approvalEnabled) checks.push(verify(APP_ID, verifyBrowserOwnerAccess));
  if (activationEnabled) checks.push(verify(ACTIVATION_APP_ID, verifyBrowserActivationAccess));
  await Promise.all(checks);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyBrowserOwnerAccessCloudflare(process.env).then(enabled => {
    console.log(enabled ? "Browser Owner/Activation Access prepublication gate: PASS" :
      "Browser Owner/Activation Access remains disabled (no variables staged)");
  }).catch(error => {
    // Only local fixed error codes are printed; never log API bodies, tokens or URLs.
    const codes = new Set(["app_identity","app_session","otp_provider","otp_pin",
      "policy_count","policy_identity","cloudflare_credentials","app_transport",
      "app_http","app_json","app_api","policies_transport","policies_http",
      "policies_json","policies_api","providers_transport","providers_http",
      "providers_json","providers_api","policies_inventory","providers_inventory"]);
    console.error("Browser Owner/Activation Access gate: BLOCKED (" +
      (codes.has(error?.message) ? error.message : "invalid_config") + ")");
    process.exitCode = 1;
  });
}
