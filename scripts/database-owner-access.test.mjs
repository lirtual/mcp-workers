import test from "node:test";
import assert from "node:assert/strict";
import { findDatabaseOwnerApp, findDatabaseOwnerLoginProviders, verifyDatabaseOwnerPolicy,
  verifyDatabaseOwnerAccessCloudflare, AccessInventoryHttpError,
  AccessInventoryStageError, safeDatabaseOwnerAccessDiagnostic } from "./database-owner-access.mjs";

const host = "owner.example.net";
const audience = "a".repeat(64);
const ownerEmail = "owner@example.net";
const otpId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ssoId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const app = { id: "9f91a9ea-d498-49e5-9d9d-2289d1c08f65", name: "Database Owner Setup",
  type: "self_hosted", domain: host, self_hosted_domains: [host], aud: audience,
  session_duration: "15m", auto_redirect_to_identity: false,
  same_site_cookie_attribute: "lax", allowed_idps: [otpId, ssoId] };
const allowed = { decision: "allow", include: [{ email: { email: ownerEmail } }],
  exclude: [], require: [] };
const params = { host, audience, ownerEmail, otpId, ssoId };
const providers = [
  { id: otpId, type: "onetimepin" },
  { id: ssoId, type: "cloudflare", config: { restrict_to_account_members: true } }
];
const envelope = result => ({ success: true, result, result_info: {
  page: 1, per_page: 100, count: result.length, total_count: result.length, total_pages: 1 } });
const config = { vars: { DATABASE_SETUP_HOST: host } };
const env = { CLOUDFLARE_ACCOUNT_ID: "f".repeat(32),
  CLOUDFLARE_API_TOKEN: "fake-token", DATABASE_ACCESS_AUD: audience, OWNER_EMAIL: ownerEmail };
const transport = async url => Response.json(url.includes("/identity_providers") ? envelope(providers) :
  url.includes("/policies") ? envelope([allowed]) : envelope([app]));

test("Database Owner requires the exact app, SSO + OTP and one Owner policy", () => {
  assert.equal(verifyDatabaseOwnerPolicy(app, [allowed], params), true);
  assert.equal(verifyDatabaseOwnerPolicy({ ...app, allowed_idps: [ssoId, otpId] }, [allowed], params), true);
  for (const changed of [
    { id: "00000000-0000-4000-8000-000000000000" },
    { aud: "b".repeat(64) }, { domain: "other.example.net" },
    { self_hosted_domains: [host, "other.example.net"] },
    { type: "mcp" }, { session_duration: "24h" },
    { auto_redirect_to_identity: true }, { same_site_cookie_attribute: "strict" },
    { same_site_cookie_attribute: undefined }, { allowed_idps: undefined },
    { allowed_idps: [] }, { allowed_idps: [otpId] },
    { allowed_idps: [ssoId] }, { allowed_idps: [otpId, otpId] },
    { allowed_idps: [ssoId, ssoId] },
    { allowed_idps: [otpId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"] },
    { allowed_idps: [otpId, ssoId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"] }
  ]) assert.throws(() => verifyDatabaseOwnerPolicy({ ...app, ...changed }, [allowed], params),
    /identity|session|SSO/);
  for (const changes of [
    [], [allowed, allowed], [{ ...allowed, decision: "bypass" }],
    [{ ...allowed, include: [{ everyone: {} }] }],
    [{ ...allowed, include: [{ email: { email: "other@example.net" } }] }],
    [{ ...allowed, include: [{ email: { email: ownerEmail } }, { everyone: {} }] }],
    [{ ...allowed, include: [{ email: { email: ownerEmail }, extra: true }] }],
    [{ ...allowed, require: [{ email: { email: ownerEmail } }] }],
    [{ ...allowed, exclude: [{ email: { email: ownerEmail } }] }]
  ]) assert.throws(() => verifyDatabaseOwnerPolicy(app, changes, params), /restricted|designated/);
});

test("Database Owner login provider inventory requires one OTP and one restricted account-member SSO", () => {
  assert.deepEqual(findDatabaseOwnerLoginProviders(envelope(providers)), { otpId, ssoId });
  for (const bad of [
    [], [providers[0]], [providers[1]], [providers[0], providers[0], providers[1]],
    [providers[0], providers[1], providers[1]],
    [providers[0], { ...providers[1], config: { restrict_to_account_members: false } }],
    [providers[0], { id: "invalid", type: "cloudflare", config: { restrict_to_account_members: true } }]
  ]) assert.throws(() => findDatabaseOwnerLoginProviders(envelope(bad)), /missing or ambiguous/);
});

test("All Access inventories must be complete single-page responses", () => {
  assert.equal(findDatabaseOwnerApp(envelope([app]), host).id, app.id);
  assert.throws(() => findDatabaseOwnerApp(envelope([{ ...app, id: "other" }]), host), /missing or ambiguous/);
  assert.throws(() => findDatabaseOwnerApp(envelope([app, app]), host), /missing or ambiguous/);
  for (const bad of [
    { result_info: undefined },
    { result_info: { page: 2 } }, { result_info: { per_page: 10 } },
    { result_info: { count: 0 } }, { result_info: { total_count: 2 } },
    { result_info: { total_pages: 2 } }, { success: false }
  ]) {
    const baseline = envelope([app]);
    assert.throws(() => findDatabaseOwnerApp({ ...baseline, ...bad,
      result_info: bad.result_info === undefined ? undefined :
        { ...baseline.result_info, ...bad.result_info } }, host), /incomplete/);
  }
  for (const bad of [
    { ...envelope(providers), result_info: undefined },
    { ...envelope(providers), result_info: { ...envelope(providers).result_info, total_pages: 2 } }
  ]) assert.throws(() => findDatabaseOwnerLoginProviders(bad), /incomplete/);
});

test("Release reads only configured canonical Audience and exact Access inventories", async () => {
  const visited = [];
  const fetcher = async (url, options) => {
    visited.push({ url, auth: options.headers.Authorization });
    return transport(url);
  };
  assert.equal(await verifyDatabaseOwnerAccessCloudflare(config, env, fetcher), true);
  assert.equal(visited.length, 3);
  assert.ok(visited.every(v => v.url.startsWith(
    "https://api.cloudflare.com/client/v4/accounts/" + "f".repeat(32))));
  assert.ok(visited.every(v => v.auth === "Bearer fake-token"));
  await assert.rejects(verifyDatabaseOwnerAccessCloudflare(config,
    { ...env, DATABASE_ACCESS_AUD: undefined, ACCESS_AUD: audience }, fetcher), /environment missing/);
  await assert.rejects(verifyDatabaseOwnerAccessCloudflare(config,
    { ...env, OWNER_EMAIL: "" }, fetcher), /environment missing/);
  await assert.rejects(verifyDatabaseOwnerAccessCloudflare(config, env,
    async url => Response.json(url.includes("/policies") ?
      { ...envelope([allowed]), result_info: undefined } :
      url.includes("/identity_providers") ? envelope(providers) : envelope([app]))), /incomplete/);
});

test("Owner Access HTTP failures expose only stage and status", async () => {
  for (const [target, stage] of [
    ["identity_providers", "idps"], ["/apps?", "apps"], ["/policies?", "policies"]
  ]) {
    const fetcher = async url => url.includes(target)
      ? Response.json({ errors: [{ message: "sensitive-payload" }] }, { status: 403 })
      : transport(url);
    await assert.rejects(verifyDatabaseOwnerAccessCloudflare(config, env, fetcher), error => {
      assert.ok(error instanceof AccessInventoryHttpError);
      assert.equal(error.stage, stage);
      assert.equal(error.status, 403);
      assert.doesNotMatch(safeDatabaseOwnerAccessDiagnostic(error), /sensitive|token|email/);
      return true;
    });
  }
});

test("Owner Access transport and invalid JSON errors remain sanitized", async () => {
  for (const [fetcher, kind] of [
    [async () => { throw Error("secret-transport"); }, "transport"],
    [async () => new Response("secret-bad-json", { status: 200 }), "json"]
  ]) {
    await assert.rejects(verifyDatabaseOwnerAccessCloudflare(config, env, fetcher), error => {
      assert.ok(error instanceof AccessInventoryStageError);
      assert.equal(error.stage, "idps");
      assert.equal(error.kind, kind);
      assert.equal(safeDatabaseOwnerAccessDiagnostic(error), ` (stage=idps; kind=${kind})`);
      assert.doesNotMatch(safeDatabaseOwnerAccessDiagnostic(error), /secret/);
      return true;
    });
  }
});

test("Safe diagnostic codes are fixed and never echo underlying input", () => {
  assert.equal(safeDatabaseOwnerAccessDiagnostic(new Error(
    "Database Owner Access SSO and OTP session configuration drift")), " (check=app_session)");
  assert.equal(safeDatabaseOwnerAccessDiagnostic(new Error(
    "Database Owner Access must restrict login to account-member SSO and OTP")), " (check=app_idps)");
  assert.equal(safeDatabaseOwnerAccessDiagnostic(new Error(
    "Database Owner account-member SSO provider missing or ambiguous")), " (check=idps_sso)");
  assert.equal(safeDatabaseOwnerAccessDiagnostic(new Error(
    "Database Owner Access applications inventory unavailable or incomplete")), " (check=apps_inventory)");
  assert.equal(safeDatabaseOwnerAccessDiagnostic(new Error("sensitive-token-or-email")), " (check=unknown)");
});
