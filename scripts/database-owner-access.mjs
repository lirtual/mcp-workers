// Read-only #344 Owner Access gate. Never creates/updates a policy or logs user credentials.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function requireCondition(condition, message) {
  if (!condition) throw Error(message);
}

export function verifyDatabaseOwnerPolicy(app, policies, { host, audience, ownerEmail, otpId }) {
  requireCondition(app?.type === "self_hosted" && app.domain === host &&
    Array.isArray(app.self_hosted_domains) &&
    app.self_hosted_domains.length === 1 &&
    app.self_hosted_domains[0] === host &&
    app.aud === audience,
    "Database Owner Access app identity or host mismatch");
  requireCondition(app.session_duration === "15m" &&
    app.auto_redirect_to_identity === true &&
    app.same_site_cookie_attribute === "lax",
    "Database Owner Access OTP session configuration drift");
  // An empty/unset allowed_idps list inherits all account login methods.
  // Exact owner email is necessary but does not prove OTP-only authentication.
  requireCondition(typeof otpId === "string" &&
    /^[a-f0-9-]{36}$/i.test(otpId) &&
    Array.isArray(app.allowed_idps) &&
    app.allowed_idps.length === 1 &&
    app.allowed_idps[0] === otpId,
    "Database Owner Access must restrict login to the One-time PIN identity provider");
  requireCondition(Array.isArray(policies) && policies.length === 1,
    "Database Owner must have one restricted Access policy");
  const policy = policies[0];
  const include = policy?.include;
  requireCondition(policy?.decision === "allow" && Array.isArray(include) &&
    include.length === 1 &&
    typeof include[0]?.email?.email === "string" &&
    include[0].email.email.toLowerCase() === ownerEmail.toLowerCase() &&
    Object.keys(include[0]).length === 1 &&
    (!policy.require || (Array.isArray(policy.require) && policy.require.length === 0)) &&
    (!policy.exclude || (Array.isArray(policy.exclude) && policy.exclude.length === 0)),
    "Database Owner Access policy must allow exactly the designated email");
  return true;
}

function ensureList(response, label) {
  requireCondition(response?.success === true && Array.isArray(response.result) &&
    (response.result_info?.total_pages ?? 1) <= 1 &&
    (!response.result_info?.total_count ||
      response.result_info.total_count <= response.result.length),
    "Database Owner Access " + label + " inventory unavailable or incomplete");
  return response.result;
}

export function findDatabaseOwnerOtpProvider(inventory) {
  const matches = ensureList(inventory, "identity providers")
    .filter(provider => provider?.type === "onetimepin");
  requireCondition(matches.length === 1 &&
    /^[a-f0-9-]{36}$/i.test(matches[0]?.id ?? ""),
    "Database Owner One-time PIN provider missing or ambiguous");
  return matches[0].id;
}

export function findDatabaseOwnerApp(inventory, host) {
  const matches = ensureList(inventory, "applications")
    .filter(app => app?.domain === host ||
      app?.self_hosted_domains?.includes(host));
  requireCondition(matches.length === 1,
    "Database Owner Access application missing or ambiguous");
  return matches[0];
}

export async function verifyDatabaseOwnerAccessCloudflare(config, environment, transport = fetch) {
  const host = config?.vars?.DATABASE_SETUP_HOST;
  const audience = environment.ACCESS_AUD;
  const ownerEmail = environment.OWNER_EMAIL;
  const account = environment.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = environment.CLOUDFLARE_API_TOKEN;
  requireCondition(typeof host === "string" && /^[a-z0-9.-]{4,253}$/.test(host) &&
    typeof audience === "string" && /^[a-f0-9]{64}$/i.test(audience) &&
    typeof ownerEmail === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail) &&
    typeof account === "string" && /^[a-f0-9]{32}$/.test(account) &&
    typeof apiToken === "string" && apiToken.length > 0,
    "Database Owner Access validation environment missing");
  const url = "https://api.cloudflare.com/client/v4/accounts/" + account + "/access/apps";
  const get = async path => {
    const response = await transport(path, { headers: {
      Authorization: "Bearer " + apiToken, Accept: "application/json"
    }, signal: AbortSignal.timeout(15000) });
    requireCondition(response.ok, "Database Owner Access inventory request failed");
    return response.json();
  };
  const otpId = findDatabaseOwnerOtpProvider(await get(
    "https://api.cloudflare.com/client/v4/accounts/" + account + "/access/identity_providers?per_page=100"));
  const app = findDatabaseOwnerApp(await get(url + "?per_page=100"), host);
  const policies = ensureList(await get(url + "/" + encodeURIComponent(app.id) + "/policies?per_page=100"),
    "policies");
  return verifyDatabaseOwnerPolicy(app, policies, { host, audience, ownerEmail, otpId });
}

async function main() {
  const raw = await readFile("apps/database-mcp-worker/wrangler.jsonc", "utf8");
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
  await verifyDatabaseOwnerAccessCloudflare(config, process.env);
  console.log("Database Owner Cloudflare Access app and exact-email policy: PASS");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Never echo potentially sensitive Cloudflare response bodies or HTTP errors.
    console.error("Database Owner Cloudflare Access gate: BLOCKED");
    process.exitCode = 1;
  });
}
