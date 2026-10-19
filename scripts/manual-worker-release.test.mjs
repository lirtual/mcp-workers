import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("Remote v2 production has no VPC, shares exact Preview namespace, checks legacy cutover", () => {
  const worker = "remote-control-mcp-worker";
  const ownerNs = "c086eb6384ad41df9de13765d868324a";
  const v2 = { bindings: [
    { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
    { name: "REMOTE_CONTROL_V2_ONLY", type: "plain_text", text: "true" },
    { name: "V2_OWNER", type: "durable_object_namespace", namespace_id: ownerNs },
  ], observability: { enabled: true, logs: { invocation_logs: false } } };
  const secrets = [{ name: "MCP_ACCESS_TOKEN" }];
  const options = { mode: "readback", v2OwnerNamespaceId: ownerNs };
  assert.equal(verifyBindings(worker, v2, secrets, options), true);
  assert.throws(() => verifyBindings(worker, v2, [], options), /Secret missing/);
  assert.throws(() => verifyBindings(worker, v2, secrets,
    { ...options, v2OwnerNamespaceId: "wrong" }), /V2_OWNER/);
  assert.throws(() => verifyBindings(worker, { ...v2,
    bindings: v2.bindings.filter(x => x.name !== "V2_OWNER") }, secrets, options), /V2_OWNER/);
  assert.throws(() => verifyBindings(worker, { ...v2,
    bindings: [...v2.bindings, { name: "REMOTE_CONTROL_DEVICE", type: "vpc_service" }] },
    secrets, options), /VPC/);
  assert.throws(() => verifyBindings(worker, { ...v2,
    bindings: v2.bindings.filter(x => x.name !== "REMOTE_CONTROL_V2_ONLY") },
    secrets, options), /v2-only/);
  // First production cutover must accept old VPC as the PREVIOUS version
  // while verifying that the NEW version is strict v2-only.
  const legacy = { bindings: [
    { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
    { name: "REMOTE_CONTROL_DEVICE_TOKEN", type: "secret_text" },
    { name: "REMOTE_CONTROL_DEVICE", type: "vpc_service",
      service_id: "11111111-1111-4111-8111-111111111111" },
  ], observability: { enabled: true, logs: { invocation_logs: false } } };
  assert.equal(verifyBindings(worker, legacy,
    [{ name: "MCP_ACCESS_TOKEN" }, { name: "REMOTE_CONTROL_DEVICE_TOKEN" }],
    { mode: "preflight", v2OwnerNamespaceId: ownerNs }), true);
  assert.throws(() => verifyBindings(worker, legacy,
    [{ name: "MCP_ACCESS_TOKEN" }, { name: "REMOTE_CONTROL_DEVICE_TOKEN" }],
    { mode: "readback", v2OwnerNamespaceId: ownerNs }), /V2_OWNER/);
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
  assert.equal(verifyPublishedVersion({ mode: "bootstrap" }, current, id), true);
  assert.throws(() => verifyPublishedVersion({ mode: "bootstrap" }, current,
    "22222222-2222-4222-8222-222222222222"), /does not match/);
});

test("manual release scope stages the pinned Agent only for Remote Control", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes("      - id: scope\n") && workflow.includes("        run: node scripts/select-affected-apps.mjs"), "manual scope entry exists");
  const selector = new URL("./select-affected-apps.mjs", import.meta.url);
  function runManual(worker, ref = "refs/heads/main") {
    const dir = mkdtempSync(join(tmpdir(), "remote-release-scope-"));
    const output = join(dir, "outputs");
    try {
      execFileSync(process.execPath, [selector.pathname], {
        env: { ...process.env, EVENT_NAME: "workflow_dispatch", MANUAL_WORKER: worker,
          MANUAL_REF: ref, BEFORE_SHA: "", PR_BASE_SHA: "",
          GITHUB_OUTPUT: output, GITHUB_SHA: "not-read-for-manual" },
        encoding: "utf8",
      });
      return readFileSync(output, "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  for (const worker of ["remote-control-mcp-worker", "database-mcp-worker",
    "ima-mcp-worker", "raindrop-mcp-worker", "ssh-mcp-worker"]) {
    const values = runManual(worker);
    assert.match(values, new RegExp("^apps=" + worker + "$", "m"));
    assert.match(values, new RegExp("^remote_control_changed=" +
      (worker === "remote-control-mcp-worker" ? "true" : "false") + "$", "m"));
    assert.match(values, new RegExp("^database_changed=" +
      (worker === "database-mcp-worker" ? "true" : "false") + "$", "m"));
  }
  assert.throws(() => runManual("missing-worker"), (error) => error.status !== 0);
  assert.throws(() => runManual("remote-control-mcp-worker", "refs/heads/feature"), (error) => error.status !== 0);
});

test("SSH production release requires Broker service, own DO, and least-privileged secret bindings", () => {
  const worker = "ssh-mcp-worker";
  const secrets = [{ name: "MCP_ACCESS_TOKEN" }, { name: "MCP_BROKER_TOKEN" }];
  const settings = {
    bindings: [
      { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
      { name: "MCP_BROKER_TOKEN", type: "secret_text" },
      { name: "EDGE_SSH_BROKER", type: "service", service: "edgessh",
        entrypoint: "HostBrokerEntrypoint" },
      { name: "SSH_OPERATIONS", type: "durable_object_namespace", class_name: "SshOperationsDO" },
    ],
    observability: { enabled: false },
  };
  assert.equal(verifyBindings(worker, settings, secrets), true);
  assert.throws(() => verifyBindings(worker, { ...settings, bindings: settings.bindings.slice(0, 3) },
    secrets), /SSH Durable Object/);
  assert.throws(() => verifyBindings(worker, { ...settings,
    bindings: [...settings.bindings, { name: "ENCRYPTION_KEY", type: "secret_text" }] },
    secrets), /SSH must not copy/);
  assert.throws(() => verifyBindings(worker, { ...settings,
    bindings: settings.bindings.map(x => x.name === "EDGE_SSH_BROKER" ?
      { ...x, service: "wrong" } : x) }, secrets), /SSH Broker/);
  assert.throws(() => verifyBindings(worker, settings, [{ name: "MCP_ACCESS_TOKEN" }]),
    /Secret missing/);
});
