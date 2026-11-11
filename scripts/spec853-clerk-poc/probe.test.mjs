import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { createSyntheticMcpProbe, verifySyntheticJwt } from "./probe.mjs";

const issuer = "https://clerk.example.invalid";
const a = { id: "sentry", url: "https://sentry.example.invalid/mcp", scope: "sentry:read", ownerSub: "owner123", allowedTools: ["sentry_find_organizations"] };
const b = { id: "workflow", url: "https://workflow.example.invalid/mcp", scope: "workflow:read", ownerSub: "owner123", allowedTools: ["workflow_get"] };
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pub = { ...publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig", alg: "RS256" };
const jwks = { keys: [pub] };
const now = Math.floor(Date.now() / 1000);
const claims = { iss: issuer, sub: "owner123", aud: a.url, scope: a.scope, iat: now - 60, exp: now + 3600 };

function b64(json) { return Buffer.from(JSON.stringify(json)).toString("base64url"); }
function token(payload = {}, header = {}) {
  const h = b64({ alg: "RS256", typ: "JWT", kid: "test-key", ...header });
  const p = b64({ ...claims, ...payload });
  const signingInput = h + "." + p;
  const s = createSign("RSA-SHA256").update(signingInput).end().sign(privateKey).toString("base64url");
  return signingInput + "." + s;
}
function request(url = a.url, bearer, name = "sentry_find_organizations") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: "Bearer " + bearer } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
  });
}
let calls = [];
const valid = t => verifySyntheticJwt(t, { jwks, issuer, now });
function probe(verify = valid) {
  calls = [];
  return createSyntheticMcpProbe({
    resources: [a, b], issuer, verify,
    dispatch: async identity => { calls.push(identity); return { content: [{ type: "text", text: "probe-only" }] }; },
  });
}
async function deny(p, req, expected, message) {
  const before = calls.length;
  const res = await p.fetch(req);
  assert.equal(res.status, expected, message);
  assert.equal(calls.length, before, "denied request must not dispatch any tool");
  assert.equal(res.headers.get("cache-control"), "no-store");
  return res;
}

test("metadata is public and resource-specific; no upstream/secret information", async () => {
  const p = probe();
  for (const r of [a, b]) {
    const url = new URL(r.url);
    const res = await p.fetch(new Request(url.origin + "/.well-known/oauth-protected-resource/mcp"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { resource: r.url, authorization_servers: [issuer], scopes_supported: [r.scope] });
  }
  await deny(p, new Request("https://unknown.example.invalid/mcp", { method: "POST" }), 404);
});
test("missing token gets 401 challenge for the exact resource", async () => {
  const p = probe();
  const res = await deny(p, request(), 401);
  assert.match(res.headers.get("www-authenticate"), /resource_metadata="https:\/\/sentry.example.invalid\/\.well-known\/oauth-protected-resource\/mcp"/);
});
test("synthetic RS256 JWT allows only the pinned resource and tool; no raw bearer forwarded", async () => {
  const p = probe();
  const res = await p.fetch(request(a.url, token()));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { principal: "owner123", resourceId: "sentry", toolName: "sentry_find_organizations" });
  assert.equal("authorization" in calls[0], false);
  assert.equal((await res.json()).result.content[0].text, "probe-only");
});
test("no privilege expansion from same owner token across resources", async () => {
  const p = probe();
  await deny(p, request(b.url, token(), "workflow_get"), 403);
});
test("token belonging to other resource rejects wrong audience", async () => {
  const p = probe();
  await deny(p, request(a.url, token({ aud: b.url })), 403);
});
test("audience missing or different form rejects", async () => {
  const p = probe();
  await deny(p, request(a.url, token({ aud: undefined })), 403);
  await deny(p, request(a.url, token({ aud: "https://sentry.example.invalid" })), 403);
});
test("unapproved Clerk user sub is rejected independently of email", async () => {
  const p = probe();
  await deny(p, request(a.url, token({ sub: "attacker", email: "owner@example.invalid" })), 403);
});
test("missing and cross-service scopes deny", async () => {
  const p = probe();
  await deny(p, request(a.url, token({ scope: "workflow:read offline_access" })), 403);
  await deny(p, request(a.url, token({ scope: undefined })), 403);
});
test("expired JWT denies", async () => {
  const p = probe();
  await deny(p, request(a.url, token({ exp: now - 1 })), 401);
});
test("not-before in future denies", async () => {
  const p = probe();
  await deny(p, request(a.url, token({ nbf: now + 3600 })), 401);
});
test("future issued-at denies", async () => {
  const p = probe();
  await deny(p, request(a.url, token({ iat: now + 3600 })), 401);
});
test("wrong issuer denies", async () => {
  const p = probe();
  await deny(p, request(a.url, token({ iss: "https://evil.example.invalid" })), 401);
});
test("key-id not in trusted JWKS denies", async () => {
  const p = probe();
  await deny(p, request(a.url, token({}, { kid: "attacker-key" })), 401);
});
test("alg none is rejected even when signed", async () => {
  const p = probe();
  await deny(p, request(a.url, token({}, { alg: "none" })), 401);
});
test("tampered signature denies", async () => {
  const p = probe();
  const t = token();
  await deny(p, request(a.url, t.slice(0, -2) + "xx"), 401);
});
test("upstream management bearer is never accepted as OAuth", async () => {
  const p = probe();
  await deny(p, request(a.url, "MCP_ACCESS_TOKEN_LEGACY_EXAMPLE"), 401);
});
test("valid identity but tool not on service's allowlist denies", async () => {
  const p = probe();
  await deny(p, request(a.url, token(), "workflow_get"), 403);
});
test("opaque online validator can authorize but must never bypass resource binding", async () => {
  const p = probe(async () => ({ ...claims, aud: b.url }));
  await deny(p, request(a.url, "synthetic-opaque"), 403);
});
test("opaque token provider revocation must deny immediately", async () => {
  const p = probe(async () => ({ active: false }));
  await deny(p, request(a.url, "synthetic-revoked"), 403);
});
test("provider network outage or 5xx rejects closed, no fallback", async () => {
  const p = probe(async () => { throw Error("simulated-provider-503"); });
  await deny(p, request(a.url, "synthetic-opaque"), 401);
});
test("opaque token valid introspection authorizes only one tool", async () => {
  const p = probe(async () => ({ ...claims, active: true }));
  const res = await p.fetch(request(a.url, "synthetic-opaque"));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
});
test("unauthorized GET, arbitrary paths, and wrong HTTP methods never dispatch", async () => {
  const p = probe();
  await deny(p, new Request(a.url, { method: "GET", headers: { authorization: "Bearer " + token() } }), 404);
  await deny(p, new Request("https://sentry.example.invalid/tool", { method: "POST" }), 404);
});
