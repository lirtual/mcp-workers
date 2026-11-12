import test from "node:test";
import assert from "node:assert/strict";
import worker from "./discovery-worker.mjs";
const RESOURCE = "https://spec853-clerk-oauth-lab.aiyaya.workers.dev/mcp";
const ISSUER = "https://warm-tadpole-1093.clerk.accounts.dev";
const METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
const METADATA_URL = new URL(METADATA_PATH, RESOURCE).href;

test("RFC 9728 protected resource metadata matches the exact Clerk lab issuer and resource", async () => {
  for (const path of [METADATA_PATH, "/.well-known/oauth-protected-resource"]) {
    const result = await worker.fetch(new Request(new URL(path, RESOURCE)));
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.deepEqual(await result.json(), {
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
    });
  }
});
test("all MCP calls deny by default with discoverable 401 including presented OAuth bearer", async () => {
  for (const [method, auth] of [
    ["GET", null], ["POST", null], ["POST", "Bearer synthetic.jwt.token"],
    ["POST", "Bearer supervisor-admin-token"], ["DELETE", null],
  ]) {
    const result = await worker.fetch(new Request(RESOURCE, {
      method,
      headers: auth ? { authorization: auth } : {},
    }));
    assert.equal(result.status, 401);
    assert.equal(result.headers.get("www-authenticate"), 'Bearer resource_metadata="' + METADATA_URL + '"');
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.deepEqual(await result.json(), { error: "unauthorized" });
  }
});
test("unknown paths, wrong hosts, and write methods on metadata do not disclose tools", async () => {
  for (const [url, method] of [
    [new URL("/health", RESOURCE), "GET"],
    [new URL("/.well-known/oauth-protected-resource/mcp", RESOURCE), "POST"],
    ["https://evil.example.invalid/mcp", "POST"],
  ]) {
    const result = await worker.fetch(new Request(url, { method }));
    assert.equal(result.status, 404);
    assert.equal(result.headers.get("cache-control"), "no-store");
  }
});
test("the standalone script is deployable as an ES module and has no bindings", async () => {
  const text = await import("node:fs/promises").then(fs => fs.readFile(new URL("./discovery-worker.mjs", import.meta.url), "utf8"));
  assert.ok(text.includes("export default"));
  assert.ok(!text.includes("MCP_ACCESS_TOKEN"));
  assert.ok(!text.includes("CF_API_TOKEN"));
  assert.ok(!text.includes("process.env"));
  assert.ok(!text.includes("tools/call"));
  assert.ok(!text.includes("await fetch("));
  assert.ok(!text.includes("globalThis.fetch"));
});
