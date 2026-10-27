import test from "node:test";
import assert from "node:assert/strict";
import { findDatabaseOwnerApp, findDatabaseOwnerOtpProvider, verifyDatabaseOwnerPolicy,
  verifyDatabaseOwnerAccessCloudflare } from "./database-owner-access.mjs";

const host = "owner.example.net";
const audience = "a".repeat(64);
const ownerEmail = "owner@example.net";
const otpId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const app = { id: "app-one", name: "Database Owner Setup", type: "self_hosted",
  domain: host, self_hosted_domains: [host], aud: audience, session_duration: "15m",
  auto_redirect_to_identity: true, allowed_idps: [otpId] };
const allowed = { decision: "allow", include: [{ email: { email: ownerEmail } }],
  exclude: [], require: [] };
const params = { host, audience, ownerEmail, otpId };
const envelope = result => ({ success: true, result,
  result_info: { total_pages: 1, total_count: result.length } });

test("Owner Access allows only a matching app and exactly one email policy", () => {
  assert.equal(verifyDatabaseOwnerPolicy(app, [allowed], params), true);
  for (const altered of [
    { ...app, aud: "b".repeat(64) },
    { ...app, domain: "other.example.net" },
    { ...app, self_hosted_domains: [host, "other.example.net"] },
    { ...app, type: "mcp" },
    { ...app, session_duration: "24h" },
    { ...app, auto_redirect_to_identity: false },
    { ...app, allowed_idps: undefined },
    { ...app, allowed_idps: [] },
    { ...app, allowed_idps: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"] },
    { ...app, allowed_idps: [otpId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"] }
  ]) assert.throws(() => verifyDatabaseOwnerPolicy(altered, [allowed], params), /identity|session|One-time PIN/);
  for (const policies of [
    [], [allowed, allowed],
    [{ ...allowed, decision: "bypass" }],
    [{ ...allowed, include: [{ everyone: {} }] }],
    [{ ...allowed, include: [{ email: { email: "other@example.net" } }] }],
    [{ ...allowed, include: [{ email: { email: ownerEmail } }, { everyone: {} }] }],
    [{ ...allowed, require: [{ email: { email: "other@example.net" } }] }]
  ]) assert.throws(() => verifyDatabaseOwnerPolicy(app, policies, params), /restricted|designated/);
});

test("Owner Access app inventory must be complete and unambiguous", () => {
  assert.equal(findDatabaseOwnerApp(envelope([app]), host).id, "app-one");
  assert.throws(() => findDatabaseOwnerApp(envelope([]), host), /missing or ambiguous/);
  assert.throws(() => findDatabaseOwnerApp(envelope([app, app]), host), /missing or ambiguous/);
  assert.throws(() => findDatabaseOwnerApp({ success: true, result: [app],
    result_info: { total_pages: 2, total_count: 20 } }, host), /incomplete/);
});

test("Owner Access requires exactly one configured OTP identity provider", () => {
  const otp = { id: otpId, type: "onetimepin" };
  assert.equal(findDatabaseOwnerOtpProvider(envelope([otp])), otpId);
  assert.throws(() => findDatabaseOwnerOtpProvider(envelope([])), /missing or ambiguous/);
  assert.throws(() => findDatabaseOwnerOtpProvider(envelope([{ id: otpId, type: "cloudflare" }])),
    /missing or ambiguous/);
  assert.throws(() => findDatabaseOwnerOtpProvider(envelope([otp, otp])), /missing or ambiguous/);
  assert.throws(() => findDatabaseOwnerOtpProvider({
    success: true, result: [otp], result_info: { total_pages: 2, total_count: 101 }
  }), /incomplete/);
});

test("Release checks real OTP, Access app and app policies without logging credentials", async () => {
  const visited = [];
  const config = { vars: { DATABASE_SETUP_HOST: host } };
  const env = { CLOUDFLARE_ACCOUNT_ID: "f".repeat(32), CLOUDFLARE_API_TOKEN: "fake-token",
    ACCESS_AUD: audience, OWNER_EMAIL: ownerEmail };
  const transport = async (url, opts) => {
    visited.push({ url, authorization: opts.headers.Authorization });
    return Response.json(url.includes("/identity_providers") ?
      envelope([{ id: otpId, type: "onetimepin" }, { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", type: "cloudflare" }]) :
      url.includes("/policies") ? envelope([allowed]) : envelope([app]));
  };
  assert.equal(await verifyDatabaseOwnerAccessCloudflare(config, env, transport), true);
  assert.equal(visited.length, 3);
  assert.ok(visited.every(v => v.url.startsWith(
    "https://api.cloudflare.com/client/v4/accounts/" + "f".repeat(32))));
  assert.ok(visited.every(v => v.authorization === "Bearer fake-token"));
  await assert.rejects(verifyDatabaseOwnerAccessCloudflare(config, { ...env, OWNER_EMAIL: "" },
    transport), /environment missing/);
  await assert.rejects(verifyDatabaseOwnerAccessCloudflare(config, env,
    async () => Response.json({ success: false, result: [] }, { status: 403 })),
  /request failed/);
});
