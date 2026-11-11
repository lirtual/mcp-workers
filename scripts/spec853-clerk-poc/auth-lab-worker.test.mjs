/**
 * T4 protocol-only tests with a deliberately stubbed SDK. Not token crypto
 * tests; existing sdk-official.test.mjs exercises real Clerk SDK in workerd.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = await readFile(new URL("./auth-lab-worker.mjs", import.meta.url), "utf8");
const fake = `
function createClerkClient() {
  return {
    authenticateRequest: async request => {
      const bearer = request.headers.get("authorization");
      if (!bearer || !bearer.startsWith("Bearer ")) return { isAuthenticated: false };
      const token = bearer.slice(7);
      if (!["good", "missing-scope", "wrong-type", "wrong-issuer", "no-owner"].includes(token)) {
        return { isAuthenticated: false };
      }
      const wrongPayload = btoa(JSON.stringify({ iss: "https://evil.example.invalid" })).replace(/=/g, "");
      return {
        isAuthenticated: true,
        tokenType: token === "wrong-type" ? "session_token" : "oauth_token",
        token: token === "wrong-issuer" ? "eyJhbGciOiJSUzI1NiJ9." + wrongPayload + ".sig" : "opaque-test",
        toAuth: () => ({ userId: token === "no-owner" ? "" : "user_test",
          scopes: token === "missing-scope" ? [] : ["profile"] }),
      };
    },
  };
}
`;
assert.ok(source.includes('import { createClerkClient } from "@clerk/backend";'));
const moduleUrl = "data:text/javascript;base64," + Buffer.from(
  source.replace('import { createClerkClient } from "@clerk/backend";', fake)
).toString("base64");
const worker = (await import(moduleUrl)).default;
const origin = "https://spec853-clerk-oauth-lab.aiyaya.workers.dev";
const env = { CLERK_SECRET_KEY: "synthetic-not-real" };
const request = (path, method = "GET", bearer, body) => new Request(origin + path, {
  method,
  headers: bearer ? { authorization: "Bearer " + bearer } : {},
  body: body == null ? undefined : JSON.stringify(body),
});
const call = (method, params = {}, bearer = "good", id = 1) =>
  worker.fetch(request("/mcp", "POST", bearer, { jsonrpc: "2.0", id, method, params }), env);

test("public PRM contains fixed dev issuer, audience, and scope", async () => {
  const r = await worker.fetch(request("/.well-known/oauth-protected-resource/mcp"), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.resource, origin + "/mcp");
  assert.deepEqual(j.authorization_servers, ["https://warm-tadpole-1093.clerk.accounts.dev"]);
  assert.deepEqual(j.scopes_supported, ["profile"]);
});
test("missing and unauthenticated bearer challenges are fail-closed", async () => {
  for (const bearer of [undefined, "bogus"]) {
    const r = await worker.fetch(request("/mcp", "POST", bearer, "{}"), env);
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate"), /resource_metadata=/);
    assert.match(r.headers.get("www-authenticate"), /scope="profile"/);
  }
  const r = await worker.fetch(request("/mcp", "POST", "good", "{}"), {});
  assert.equal(r.status, 401);
});
test("missing scope is 403 and wrong token type, owner, issuer fail closed", async () => {
  assert.equal((await call("tools/list", {}, "missing-scope")).status, 403);
  for (const t of ["wrong-type", "no-owner", "wrong-issuer"])
    assert.equal((await call("tools/list", {}, t)).status, 401, t);
});
test("initialize, tools/list, and no-op call require valid synthetic auth", async () => {
  const i = await call("initialize", {});
  assert.equal(i.status, 200);
  const ir = await i.json();
  assert.equal(ir.result.serverInfo.name, "spec853-clerk-oauth-lab");
  assert.ok(ir.result.capabilities.tools);
  const l = await call("tools/list", {});
  assert.equal(l.status, 200);
  const lr = await l.json();
  assert.deepEqual(lr.result.tools.map(x => x.name), ["lab_status"]);
  const c = await call("tools/call", { name: "lab_status", arguments: {} });
  assert.equal(c.status, 200);
  assert.match((await c.json()).result.content[0].text, /no-op/);
});
test("unknown tool and unexpected method never trigger upstream operations", async () => {
  const e = await call("tools/call", { name: "deleteEverything", arguments: {} });
  assert.equal((await e.json()).error.code, -32602);
  const u = await call("admin/erase", {});
  assert.equal((await u.json()).error.code, -32601);
  const m = await worker.fetch(request("/mcp", "GET", "good"), env);
  assert.equal(m.status, 405);
  const x = await worker.fetch(request("/secret", "GET"), env);
  assert.equal(x.status, 404);
});
test("Worker source has no real secret, no direct upstream fetch, and only one Clerk SDK import", () => {
  assert.equal((source.match(/from "@clerk\/backend"/g) || []).length, 1);
  assert.ok(!/sk_(?:test|live)_[A-Za-z0-9_-]{20,}/.test(source));
  assert.ok(!source.includes("await fetch("));
  assert.ok(!source.includes("CLERK_OWNER_USER_ID"));
});
