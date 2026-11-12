/** Official Clerk SDK bundle in native local workerd: network-free deny path. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const entry = process.env.SPEC853_MINIFLARE_ENTRY;
const bundle = process.env.SPEC853_BUNDLE_OUTPUT || "/tmp/spec853-auth-lab.bundle.mjs";
test("compiled official Clerk SDK runs in workerd and does not expose MCP without a token", {
  skip: !entry && "SPEC853_MINIFLARE_ENTRY not configured",
}, async () => {
  const { Miniflare } = await import(entry);
  const source = await readFile(bundle, "utf8");
  const mf = new Miniflare({ workers: [{ config: {
    name: "spec853-t4-official-sdk",
    compatibilityDate: "2026-10-19",
    manifest: { mainModule: "index.mjs", modulesRoot: "/",
      modules: { "index.mjs": { type: "esm", contents: source } } },
  } }] });
  const base = "https://spec853-clerk-oauth-lab.aiyaya.workers.dev";
  try {
    const meta = await mf.dispatchFetch(base + "/.well-known/oauth-protected-resource/mcp");
    assert.equal(meta.status, 200);
    assert.equal((await meta.json()).resource, base + "/mcp");
    for (const path of ["/mcp", "/mcp?debug=1"]) {
      const r = await mf.dispatchFetch(base + path, {
        method: "POST", body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      });
      assert.equal(r.status, 401);
      assert.match(r.headers.get("www-authenticate"), /scope="profile"/);
    }
    assert.equal((await mf.dispatchFetch(base + "/secret")).status, 404);
  } finally {
    await mf.dispose();
  }
});
