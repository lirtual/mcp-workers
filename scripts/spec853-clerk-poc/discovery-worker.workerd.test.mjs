import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const moduleEntry = process.env.SPEC853_MINIFLARE_ENTRY;
const resource = "https://spec853-clerk-oauth-lab.aiyaya.workers.dev/mcp";
test("real local workerd hosts the standalone fail-closed discovery worker", {
  skip: !moduleEntry && "SPEC853_MINIFLARE_ENTRY not set",
}, async () => {
  const { Miniflare } = await import(moduleEntry);
  const code = await readFile(new URL("./discovery-worker.mjs", import.meta.url), "utf8");
  const mf = new Miniflare({ workers: [{
    config: {
      name: "spec853-discovery-only",
      compatibilityDate: "2026-10-19",
      manifest: { mainModule: "index.mjs", modulesRoot: "/",
        modules: { "index.mjs": { type: "esm", contents: code } },
      },
    },
  }] });
  try {
    const metadataURL = "https://spec853-clerk-oauth-lab.aiyaya.workers.dev/.well-known/oauth-protected-resource/mcp";
    const metadata = await mf.dispatchFetch(metadataURL);
    assert.equal(metadata.status, 200);
    const data = await metadata.json();
    assert.equal(data.resource, resource);
    assert.deepEqual(data.authorization_servers, ["https://warm-tadpole-1093.clerk.accounts.dev"]);
    for(const token of ["", "Bearer test"]) {
      const response = await mf.dispatchFetch(resource, {
        method: "POST",
        headers: token ? { authorization: token } : {},
        body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
      });
      assert.equal(response.status, 401);
      assert.match(response.headers.get("www-authenticate"), /resource_metadata=/);
    }
    const absent = await mf.dispatchFetch("https://spec853-clerk-oauth-lab.aiyaya.workers.dev/health");
    assert.equal(absent.status, 404);
  } finally { await mf.dispose(); }
});
