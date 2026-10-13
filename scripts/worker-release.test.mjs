import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseConfig, verifyWorker, parseWranglerVersion } from "./worker-release.mjs";

const load = (name) => parseConfig(readFileSync("apps/" + name + "/wrangler.jsonc", "utf8"));
const obs = (logs = true, traces = false) => ({
  enabled: true, logs: { invocation_logs: logs }, traces: { enabled: traces },
});
function fixture(name, bindings, options = {}) {
  const config = load(name);
  const settings = {
    compatibility_date: config.compatibility_date,
    observability: obs(options.logs ?? true, options.traces ?? false),
    bindings,
  };
  const secrets = config.secrets.required.map((secret) => ({ name: secret, type: "secret_text" }));
  return { config, settings, secrets, scriptSettings: { observability: settings.observability } };
}
function secretsFor(name) {
  return load(name).secrets.required.map((secret) => ({ name: secret, type: "secret_text" }));
}
function verify(name, f, phase = "before", vpc) {
  return verifyWorker(name, f.config, f.settings, f.secrets, f.scriptSettings, phase, vpc);
}

test("Raindrop checks only Secret presence, rejects missing name or unexpected resources", () => {
  const name = "raindrop-mcp-worker";
  const f = fixture(name, secretsFor(name));
  assert.doesNotThrow(() => verify(name, f));
  f.secrets.pop();
  assert.throws(() => verify(name, f), /Secret name missing/);
  f.secrets = secretsFor(name);
  f.settings.bindings.push({ name: "UNEXPECTED_DO", type: "durable_object_namespace" });
  assert.throws(() => verify(name, f), /Unexpected production resource/);
});

test("Raindrop detects a release observability mismatch", () => {
  const name = "raindrop-mcp-worker";
  const f = fixture(name, secretsFor(name), { logs: false });
  assert.throws(() => verify(name, f), /Invocation logging drift/);
});

test("IMA legacy R2 is only permitted before approved migration, DO is mandatory", () => {
  const name = "ima-mcp-worker";
  const resources = [
    { name: "IMA_IMAGE_REFRESH_SHARD", type: "durable_object_namespace", class_name: "ImaImageRefreshShard" },
    { name: "R2_BUCKET", type: "r2_bucket" },
  ];
  const f = fixture(name, [...secretsFor(name), ...resources], { traces: true });
  assert.doesNotThrow(() => verify(name, f, "before"));
  assert.throws(() => verify(name, f, "after"), /Legacy IMA R2/);
  f.settings.bindings = f.settings.bindings.filter((x) => x.name !== "R2_BUCKET");
  assert.doesNotThrow(() => verify(name, f, "after"));
  f.settings.bindings = f.settings.bindings.filter((x) => x.name !== "IMA_IMAGE_REFRESH_SHARD");
  assert.throws(() => verify(name, f), /IMA DO binding missing/);
});

test("Database must retain the actual Rate Limiter policy", () => {
  const name = "database-mcp-worker";
  const resource = { name: "RATE_LIMITER", type: "ratelimit", namespace_id: "1001",
    simple: { limit: 120, period: 60 } };
  const f = fixture(name, [...secretsFor(name), resource]);
  assert.doesNotThrow(() => verify(name, f));
  resource.simple.limit = 200;
  assert.throws(() => verify(name, f), /RATE_LIMITER limits drift/);
});

test("Remote VPC identity and independently approved true gates cannot drift", () => {
  const name = "remote-control-mcp-worker";
  const id = "11111111-1111-4111-8111-111111111111";
  const bindings = [
    ...secretsFor(name),
    { name: "REMOTE_CONTROL_DEVICE", type: "vpc_service", service_id: id },
    { name: "REMOTE_CONTROL_ENABLE_FILE_WRITES", type: "plain_text", text: "true" },
    { name: "REMOTE_CONTROL_ENABLE_SHELL", type: "plain_text", text: "true" },
  ];
  const f = fixture(name, bindings, { logs: false });
  assert.doesNotThrow(() => verify(name, f, "before", id));
  assert.throws(() => verify(name, f, "before", "22222222-2222-4222-8222-222222222222"), /VPC Service ID/);
  bindings[3].text = "false";
  assert.throws(() => verify(name, f, "before", id), /runtime permission/);
});

test("Wrangler CLI output requires a parseable deployment version, never guesses", () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  assert.equal(parseWranglerVersion("Current Version ID: " + id), id);
  assert.throws(() => parseWranglerVersion("Uploaded script"), /verifiable deployed version/);
});
