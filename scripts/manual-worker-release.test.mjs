import test from "node:test";
import assert from "node:assert/strict";
import { activeVersion, verifyBindings, parseWranglerVersion } from "./manual-worker-release.mjs";

const required = [
  { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
  { name: "RAINDROP_ACCESS_TOKEN", type: "secret_text" },
];
const secretList = [{ name: "MCP_ACCESS_TOKEN" }, { name: "RAINDROP_ACCESS_TOKEN" }];
const goodSettings = { bindings: required, observability: { logs: { invocation_logs: true } } };

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

test("IMA cutover keeps the image-refresh DO but permits only acknowledged legacy R2 removal", () => {
  const worker = "ima-mcp-worker";
  const secretNames = ["MCP_ACCESS_TOKEN", "CLIENT_ID", "API_KEY"];
  const secrets = secretNames.map((name) => ({ name }));
  const durable = { name: "IMA_IMAGE_REFRESH_SHARD", type: "durable_object_namespace", class_name: "ImaImageRefreshShard" };
  const legacy = { name: "R2_BUCKET", type: "r2_bucket" };
  const settings = {
    bindings: [...secretNames.map((name) => ({ name, type: "secret_text" })), durable, legacy],
    observability: { enabled: true, logs: { invocation_logs: true }, traces: { enabled: true } },
  };
  assert.throws(() => verifyBindings(worker, settings, secrets, { mode: "preflight" }), /acknowledgement/);
  assert.equal(verifyBindings(worker, settings, secrets, { mode: "preflight", ackIma: true }), true);
  assert.throws(() => verifyBindings(worker, settings, secrets, { mode: "readback" }), /Legacy IMA R2/);
  const withoutR2 = { ...settings, bindings: settings.bindings.filter((x) => x.name !== "R2_BUCKET") };
  assert.equal(verifyBindings(worker, withoutR2, secrets, { mode: "readback" }), true);
  assert.throws(() => verifyBindings(worker, { ...settings, bindings: settings.bindings.filter((x) => x.name !== "IMA_IMAGE_REFRESH_SHARD") },
    secrets, { mode: "preflight", ackIma: true }), /Durable Object/);
  assert.throws(() => verifyBindings(worker, { ...withoutR2, observability: { enabled: true, logs: { invocation_logs: true } } },
    secrets, { mode: "readback" }), /tracing drift/);
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
  assert.throws(() => parseWranglerVersion("Uploaded script"), /verifiable version ID/);
});
