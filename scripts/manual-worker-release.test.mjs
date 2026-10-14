import test from "node:test";
import assert from "node:assert/strict";
import { activeVersion, verifyBindings, parseWranglerVersion, verifyPublishedVersion } from "./manual-worker-release.mjs";

const required = [
  { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
  { name: "RAINDROP_ACCESS_TOKEN", type: "secret_text" },
];
const secretList = [{ name: "MCP_ACCESS_TOKEN" }, { name: "RAINDROP_ACCESS_TOKEN" }];
const goodSettings = { bindings: required, observability: { enabled: true, logs: { invocation_logs: true } } };

test("Raindrop required Secret names and bindings are preserved", () => {
  assert.equal(verifyBindings("raindrop-mcp-worker", goodSettings, secretList), true);
  assert.throws(() => verifyBindings("raindrop-mcp-worker", goodSettings, []), /Secret missing/);
  assert.throws(() => verifyBindings("raindrop-mcp-worker", { ...goodSettings, bindings: [] }, secretList),
    /binding missing/);
  assert.throws(() => verifyBindings("raindrop-mcp-worker", { ...goodSettings, observability: {} }, secretList),
    /Invocation Logs/);
  assert.throws(() => verifyBindings("not-a-worker", goodSettings, secretList), /target/);
});

test("Active-version readback requires exactly one 100 percent version", () => {
  const good = { deployments: [{ id: "deployment-one", versions: [{ version_id: "version-one", percentage: 100 }] }] };
  assert.deepEqual(activeVersion(good), { deployment_id: "deployment-one", version_id: "version-one" });
  assert.throws(() => activeVersion({ deployments: [] }), /unambiguous/);
  assert.throws(() => activeVersion({ deployments: [{ id: "mixed", versions: [
    { version_id: "a", percentage: 50 }, { version_id: "b", percentage: 50 },
  ] }] }), /unambiguous/);
});

test("IMA requires retained inert DO and rejects legacy R2 bindings", () => {
  const worker = "ima-mcp-worker";
  const secretNames = ["MCP_ACCESS_TOKEN", "CLIENT_ID", "API_KEY"];
  const secrets = secretNames.map((name) => ({ name }));
  const durable = { name: "IMA_IMAGE_REFRESH_SHARD", type: "durable_object_namespace", class_name: "ImaImageRefreshShard" };
  const settings = {
    bindings: [...secretNames.map((name) => ({ name, type: "secret_text" })), durable],
    observability: { enabled: true, logs: { invocation_logs: true }, traces: { enabled: true } },
  };
  assert.equal(verifyBindings(worker, settings, secrets, { mode: "preflight" }), true);
  assert.equal(verifyBindings(worker, settings, secrets, { mode: "readback" }), true);
  assert.throws(() => verifyBindings(worker, { ...settings, bindings: [...settings.bindings, { name: "R2_BUCKET", type: "r2_bucket" }] }, secrets, { mode: "preflight" }), /Legacy IMA R2/);
  assert.throws(() => verifyBindings(worker, { ...settings, bindings: settings.bindings.filter((x) => x.name !== "IMA_IMAGE_REFRESH_SHARD") }, secrets), /Durable Object/);
  assert.throws(() => verifyBindings(worker, { ...settings, observability: { enabled: true, logs: { invocation_logs: true } } }, secrets), /tracing drift/);
});

test("Database RATE_LIMITER and required runtime Secret names are a strict gate", () => {
  const names = ["MCP_ACCESS_TOKEN", "DATABASE_CONFIG"];
  const secrets = names.map((name) => ({ name }));
  const limiter = { name: "RATE_LIMITER", type: "ratelimit", namespace_id: "1001",
    simple: { limit: 120, period: 60 } };
  const settings = {
    bindings: [...names.map((name) => ({ name, type: "secret_text" })), limiter],
    observability: { enabled: true, logs: { invocation_logs: true } },
  };
  assert.equal(verifyBindings("database-mcp-worker", settings, secrets), true);
  assert.throws(() => verifyBindings("database-mcp-worker",
    { ...settings, bindings: settings.bindings.filter((x) => x.name !== "RATE_LIMITER") }, secrets), /RATE_LIMITER/);
  assert.throws(() => verifyBindings("database-mcp-worker",
    { ...settings, bindings: [...settings.bindings.slice(0, 2), { ...limiter, simple: { limit: 200, period: 60 } }] },
    secrets), /RATE_LIMITER/);
});

test("Remote VPC identity and approved independent write and Shell gates must remain intact", () => {
  const worker = "remote-control-mcp-worker";
  const vpcId = "11111111-1111-4111-8111-111111111111";
  const names = ["MCP_ACCESS_TOKEN", "REMOTE_CONTROL_DEVICE_TOKEN"];
  const secrets = names.map((name) => ({ name }));
  const gates = ["REMOTE_CONTROL_ENABLE_FILE_WRITES", "REMOTE_CONTROL_ENABLE_SHELL"]
    .map((name) => ({ name, type: "plain_text", text: "true" }));
  const settings = {
    bindings: [...names.map((name) => ({ name, type: "secret_text" })),
      { name: "REMOTE_CONTROL_DEVICE", type: "vpc_service", service_id: vpcId }, ...gates],
    observability: { enabled: true, logs: { invocation_logs: false } },
  };
  assert.equal(verifyBindings(worker, settings, secrets, { vpcId }), true);
  assert.throws(() => verifyBindings(worker, settings, secrets, { vpcId: "22222222-2222-4222-8222-222222222222" }),
    /VPC Service/);
  assert.throws(() => verifyBindings(worker,
    { ...settings, bindings: settings.bindings.filter((x) => x.name !== "REMOTE_CONTROL_ENABLE_FILE_WRITES") },
    secrets, { vpcId }), /permission gate/);
  assert.throws(() => verifyBindings(worker,
    { ...settings, observability: { enabled: true, logs: { invocation_logs: true } } },
    secrets, { vpcId }), /Invocation Logs/);
});

test("Wrangler output requires a parseable release id, not upload-only success", () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  assert.equal(parseWranglerVersion("Current Version ID: " + id), id);
  assert.throws(() => parseWranglerVersion("Uploaded script"), /release Version ID/);
});

test("readback must match exact newly published Wrangler version", () => {
  const old = { version_id: "00000000-0000-4000-8000-000000000000", deployment_id: "old" };
  const id = "12345678-1234-4234-8234-123456789abc";
  const current = { version_id: id, deployment_id: "new" };
  assert.equal(verifyPublishedVersion(old, current, id), true);
  assert.throws(() => verifyPublishedVersion(old, current, "22222222-2222-4222-8222-222222222222"), /does not match/);
  assert.throws(() => verifyPublishedVersion(old, current, ""), /missing or malformed/);
  assert.throws(() => verifyPublishedVersion(old, current, undefined), /missing or malformed/);
  assert.throws(() => verifyPublishedVersion(old, old, old.version_id), /did not change/);
});
