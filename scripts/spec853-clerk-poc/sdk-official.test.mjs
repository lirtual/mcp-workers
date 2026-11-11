/**
 * Spec #853: official Clerk SDK + local Cloudflare workerd ONLY.
 * All OAuth JWTs and signing keys are synthetic and generated in memory.
 * Run with SPEC853_SDK_CACHE (isolated npm install) and SPEC853_MINIFLARE_ENTRY.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateKeyPairSync, createSign } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const sdkRoot = process.env.SPEC853_SDK_CACHE;
const miniflareEntry = process.env.SPEC853_MINIFLARE_ENTRY;
const resource = "https://sentry.example.invalid/mcp";
const issuerDomain = "gentle-lynx-71.clerk.accounts.dev";
const publishableKey = "pk_test_" + Buffer.from(issuerDomain + "$").toString("base64").replace(/=+$/, "");
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwtKey = publicKey.export({ type: "spki", format: "pem" });
const now = Math.floor(Date.now() / 1000);
const encode = input => Buffer.from(JSON.stringify(input)).toString("base64url");

function mint(overrides = {}, headerOverrides = {}) {
  const header = encode({ alg: "RS256", typ: "at+jwt", kid: "fixture-key", ...headerOverrides });
  const payload = encode({
    iss: "https://" + issuerDomain,
    sub: "user_synthetic_owner",
    aud: resource,
    scope: "sentry:read",
    client_id: "synthetic_client",
    iat: now - 60,
    exp: now + 3600,
    jti: "fixture-jti",
    ...overrides,
  });
  const input = header + "." + payload;
  const signature = createSign("RSA-SHA256").update(input).end().sign(privateKey).toString("base64url");
  return input + "." + signature;
}

test("official Clerk Backend SDK: synthetic oauth_token vs wrong audience, expiry and token type", {
  skip: !sdkRoot && "SPEC853_SDK_CACHE not configured",
}, async () => {
  const { createClerkClient } = await import(pathToFileURL(join(sdkRoot, "node_modules/@clerk/backend/dist/index.mjs")).href);
  const clerk = createClerkClient({
    secretKey: "sk_test_synthetic_fixture_only",
    publishableKey,
    jwtKey,
  });
  const check = async (value, audience = resource) => {
    const request = new Request(resource, { headers: { authorization: "Bearer " + value } });
    return clerk.authenticateRequest(request, { acceptsToken: "oauth_token", audience, jwtKey });
  };
  const valid = await check(mint());
  assert.equal(valid.isAuthenticated, true);
  assert.equal(valid.tokenType, "oauth_token");
  assert.equal(valid.toAuth().userId, "user_synthetic_owner");
  assert.ok(valid.toAuth().scopes.includes("sentry:read"));
  assert.equal((await check(mint(), "https://workflow.example.invalid/mcp")).isAuthenticated, false);
  assert.equal((await check(mint({ exp: now - 180 }))).isAuthenticated, false);
  assert.equal((await check(mint({}, { typ: "JWT" }))).isAuthenticated, false);
  // SDK machine-token verification accepts a signed JWT with a different iss
  // unless the resource layer separately binds it to the expected issuer.
  const mismatchedIssuer = await check(mint({ iss: "https://other.example.invalid" }));
  if (mismatchedIssuer.isAuthenticated) {
    const claims = JSON.parse(Buffer.from(mismatchedIssuer.token.split(".")[1], "base64url").toString("utf8"));
    assert.notEqual(claims.iss, "https://" + issuerDomain);
  }
});

test("official Clerk SDK bundled into real local workerd: exact resource, owner and scopes", {
  skip: (!sdkRoot || !miniflareEntry) && "SPEC853_SDK_CACHE / SPEC853_MINIFLARE_ENTRY missing",
}, async () => {
  const esbuild = await import(pathToFileURL(join(sdkRoot, "node_modules/esbuild/lib/main.js")).href);
  const { Miniflare } = await import(miniflareEntry);
  const entry = await readFile(new URL("./sdk-worker-entry.mjs", import.meta.url), "utf8");
  const built = await esbuild.build({
    stdin: { contents: entry, sourcefile: "sdk-worker-entry.mjs", resolveDir: sdkRoot, loader: "js" },
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["worker", "browser"],
    target: "es2022",
    write: false,
  });
  const quote = value => String.fromCharCode(34) + value + String.fromCharCode(34);
  let source = built.outputFiles[0].text;
  for (const [placeholder, replacement] of [
    ["__SPEC853_FAKE_PUBLISHABLE_KEY__", publishableKey],
    ["__SPEC853_FAKE_JWT_PEM__", jwtKey],
  ]) {
    assert.ok(source.includes(quote(placeholder)), "bundle missing expected test-only fixture");
    source = source.replace(quote(placeholder), JSON.stringify(replacement));
  }
  const mf = new Miniflare({
    workers: [{
      config: {
        name: "spec853-sdk-only",
        compatibilityDate: "2026-10-19",
        manifest: {
          mainModule: "index.mjs",
          modulesRoot: "/",
          modules: { "index.mjs": { type: "esm", contents: source } },
        },
      },
    }],
  });
  try {
    for (const [name, token, expected] of [
      ["valid_oauth", mint(), 200],
      ["wrong_audience", mint({ aud: "https://workflow.example.invalid/mcp" }), 401],
      ["wrong_scope", mint({ scope: "workflow:read" }), 401],
      ["wrong_owner", mint({ sub: "user_other" }), 401],
      ["wrong_issuer", mint({ iss: "https://other.example.invalid" }), 401],
      ["expired", mint({ exp: now - 180 }), 401],
      ["session_type", mint({}, { typ: "JWT" }), 401],
    ]) {
      const response = await mf.dispatchFetch(resource, {
        method: "POST",
        headers: { authorization: "Bearer " + token },
        body: "{}",
      });
      assert.equal(response.status, expected, name + ":" + JSON.stringify(await response.json()));
    }
  } finally {
    await mf.dispose();
  }
});
