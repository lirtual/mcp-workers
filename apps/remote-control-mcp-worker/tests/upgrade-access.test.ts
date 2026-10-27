import assert from "node:assert/strict";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  verifyUpgradeOwnerAccess, validUpgradeFormOrigin, upgradeFormCookie,
  UPGRADE_APPROVAL_ORIGIN, type UpgradeAccessConfig,
} from "../src/upgrade-access.ts";

const CONFIG: UpgradeAccessConfig = {
  teamDomain: "isolated-test.cloudflareaccess.com",
  audience: "1".repeat(64),
  ownerEmail: "owner@example.test",
};
const PATH = UPGRADE_APPROVAL_ORIGIN + "/upgrade-approve/approved-op/fixed-ticket";
async function signedFixture() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  const certs: typeof fetch = async () => Response.json({ keys: [jwk] });
  async function token(overrides: {
    issuer?: string; audience?: string; email?: string; expired?: boolean;
    service?: boolean; subject?: string;
  } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = { email: overrides.email ?? "owner@example.test" };
    if (overrides.service) claims.service_token_id = "not-a-user";
    return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(overrides.issuer ?? "https://isolated-test.cloudflareaccess.com")
      .setAudience(overrides.audience ?? "1".repeat(64))
      .setSubject(overrides.subject ?? "user-subject")
      .setIssuedAt(now - 15)
      .setExpirationTime(overrides.expired ? now - 30 : now + 300).sign(privateKey);
  }
  return { token, certs };
}
test("only real owner RS256 Access assertion and exact HTTPS host passes", async () => {
  const f = await signedFixture();
  const valid = new Request(PATH, { headers: { "cf-access-jwt-assertion": await f.token() } });
  assert.equal(await verifyUpgradeOwnerAccess(valid, CONFIG, f.certs), true);
  for (const opts of [
    { issuer: "https://wrong.cloudflareaccess.com" },
    { audience: "2".repeat(64) },
    { email: "other@example.test" },
    { expired: true },
    { service: true },
    { subject: "" },
  ]) {
    const request = new Request(PATH, { headers: { "cf-access-jwt-assertion": await f.token(opts) } });
    assert.equal(await verifyUpgradeOwnerAccess(request, CONFIG, f.certs), false,
      JSON.stringify(opts));
  }
  for (const url of [
    "http://rca.lirtual.dpdns.org/upgrade-approve/id/token",
    "https://other.example/upgrade-approve/id/token",
    UPGRADE_APPROVAL_ORIGIN + "/browser-approve/id/token",
  ]) {
    const request = new Request(url, { headers: { "cf-access-jwt-assertion": await f.token() } });
    assert.equal(await verifyUpgradeOwnerAccess(request, CONFIG, f.certs), false);
  }
});

test("invalid JWT signatures, missing or invalid Access configuration fail closed", async () => {
  const f = await signedFixture();
  const jwt = await f.token();
  const query = (t: string) => new Request(PATH, {
    headers: { "cf-access-jwt-assertion": t },
  });
  assert.equal(await verifyUpgradeOwnerAccess(query(jwt.slice(0, -2) + "aa"), CONFIG, f.certs), false);
  assert.equal(await verifyUpgradeOwnerAccess(query("not-a-jwt"), CONFIG, f.certs), false);
  assert.equal(await verifyUpgradeOwnerAccess(new Request(PATH), CONFIG, f.certs), false);
  for (const bad of [
    { ...CONFIG, teamDomain: undefined },
    { ...CONFIG, audience: undefined },
    { ...CONFIG, ownerEmail: undefined },
    { ...CONFIG, teamDomain: "https://evil.example" },
    { ...CONFIG, audience: "not-an-audience" },
  ]) assert.equal(await verifyUpgradeOwnerAccess(query(jwt), bad, f.certs), false);
  assert.equal(await verifyUpgradeOwnerAccess(query(jwt), CONFIG,
    async () => new Response(null, { status: 503 })), false);
});

test("a real same-origin form POST requires a matching one-use HttpOnly CSRF cookie", () => {
  const formToken = "a".repeat(64);
  const expectedCookie = upgradeFormCookie(formToken);
  assert.match(expectedCookie, /Secure; HttpOnly; SameSite=Strict/);
  const request = (options: {method?: string; origin?: string; cookie?: string}) =>
    new Request(PATH, { method: options.method ?? "POST",
      headers: { ...(options.origin ? { origin: options.origin } : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}) } });
  assert.equal(validUpgradeFormOrigin(request({
    origin: UPGRADE_APPROVAL_ORIGIN, cookie: "rca_upgrade_csrf=" + formToken,
  }), formToken), true);
  for (const req of [
    request({ method: "GET", origin: UPGRADE_APPROVAL_ORIGIN, cookie: "rca_upgrade_csrf=" + formToken }),
    request({ origin: "https://evil.example", cookie: "rca_upgrade_csrf=" + formToken }),
    request({ cookie: "rca_upgrade_csrf=" + formToken }),
    request({ origin: UPGRADE_APPROVAL_ORIGIN, cookie: "rca_upgrade_csrf=" + "b".repeat(64) }),
    request({ origin: UPGRADE_APPROVAL_ORIGIN, cookie: "rca_upgrade_csrf=" + formToken + "; rca_upgrade_csrf=" + formToken }),
  ]) assert.equal(validUpgradeFormOrigin(req, formToken), false);
  assert.throws(() => upgradeFormCookie("not-a-csrf-token"));
});
