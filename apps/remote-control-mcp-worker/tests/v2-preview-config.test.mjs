import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

test("dedicated v2 preview cannot inherit the v1 VPC binding, token or DO namespace", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const preview = JSON.parse(await readFile(path.join(root, "wrangler.v2-preview.jsonc"), "utf8"));
  const production = await readFile(path.join(root, "wrangler.jsonc"), "utf8");
  assert.equal(preview.name, "remote-control-v2-preview");
  assert.equal(preview.main, "src/worker.ts");
  assert.equal(preview.vars?.REMOTE_CONTROL_V2_PREVIEW_ONLY, "true");
  assert.equal(preview.durable_objects.bindings.length, 1);
  assert.deepEqual(preview.durable_objects.bindings[0], {
    name: "V2_OWNER", class_name: "V2OwnerCoordinator",
  });
  assert.deepEqual(preview.exports.V2OwnerCoordinator, { type: "durable-object", storage: "sqlite" });
  assert.deepEqual(preview.secrets.required, ["MCP_ACCESS_TOKEN"]);
  assert.deepEqual(preview.compatibility_flags, ["nodejs_compat"]);
  assert.equal(preview.observability.logs.invocation_logs, false);
  assert.equal(preview.preview_urls, false);
  assert.equal(preview.keep_vars, false);
  assert.ok(!("vpc_services" in preview));
  assert.ok(!("migrations" in preview));
  assert.ok(!("routes" in preview));
  assert.ok(!("triggers" in preview));
  assert.equal(JSON.stringify(preview).includes("REMOTE_CONTROL_DEVICE_TOKEN"), false);
  assert.equal(JSON.stringify(preview).includes("REMOTE_CONTROL_DEVICE"), false);
  const bootstrap = JSON.parse(await readFile(path.join(root, "wrangler.v2-preview-bootstrap.jsonc"), "utf8"));
  const { secrets: _requiredPreviewSecret, ...releaseSettings } = preview;
  assert.deepEqual(bootstrap, releaseSettings, "bootstrap differs only by omission of the required secret declaration");
  assert.equal("secrets" in bootstrap, false);
  assert.ok(production.includes('"name": "remote-control-mcp-worker"'), "production configuration must remain independent");
});
