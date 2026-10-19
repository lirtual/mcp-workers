import assert from "node:assert/strict";
import test from "node:test";
import { BOOTSTRAP_SECRETS, collectBootstrapSecrets } from "./bootstrap-worker-secrets.mjs";

const fixtures = {
  "raindrop-mcp-worker": { MCP_ACCESS_TOKEN: "portal", RAINDROP_ACCESS_TOKEN: "raindrop" },
  "ima-mcp-worker": { MCP_ACCESS_TOKEN: "portal", API_KEY: "ima-key" },
  "database-mcp-worker": { MCP_ACCESS_TOKEN: "portal", DATABASE_CONFIG: '{"sample":"mysql://user:pass@host/db"}' },
  "ssh-mcp-worker": { MCP_ACCESS_TOKEN: "portal", MCP_BROKER_TOKEN: "x".repeat(32) },
  "remote-control-mcp-worker": { MCP_ACCESS_TOKEN: "portal" },
};

test("bootstrap supports all selected Workers, including isolated Remote Control", () => {
  assert.deepEqual(Object.keys(BOOTSTRAP_SECRETS).sort(), Object.keys(fixtures).sort());
  assert.deepEqual(collectBootstrapSecrets("remote-control-mcp-worker", { MCP_ACCESS_TOKEN: "portal", REMOTE_CONTROL_DEVICE_TOKEN: "legacy" }), { MCP_ACCESS_TOKEN: "portal" });
  assert.throws(() => collectBootstrapSecrets("unlisted-worker", {}), /not enabled/);
});

test("selected Worker receives only required named secrets (no JSON wrappers)", () => {
  for (const [worker, selected] of Object.entries(fixtures)) {
    const env = { ...selected, OTHER_WORKER_KEY: "do-not-copy", RAINDROP_MCP_SECRETS_JSON: "obsolete" };
    const parsed = collectBootstrapSecrets(worker, env);
    assert.deepEqual(parsed, selected);
    assert.equal(Object.hasOwn(parsed, "OTHER_WORKER_KEY"), false);
  }
});

test("missing or empty Secrets fail before any deploy, including shared portal bearer", () => {
  for (const [worker, values] of Object.entries(fixtures)) {
    for (const name of Object.keys(values)) {
      const missing = { ...values };
      delete missing[name];
      assert.throws(() => collectBootstrapSecrets(worker, missing), new RegExp(name));
      assert.throws(() => collectBootstrapSecrets(worker, { ...values, [name]: " " }), new RegExp(name));
    }
  }
});

test("database config stays an unescaped JSON string; no extra nesting", () => {
  const input = fixtures["database-mcp-worker"];
  assert.equal(collectBootstrapSecrets("database-mcp-worker", input).DATABASE_CONFIG, input.DATABASE_CONFIG);
});

test("SSH broker token must be at least 32 chars and root encryption key is not forwarded", () => {
  const input = fixtures["ssh-mcp-worker"];
  assert.throws(() => collectBootstrapSecrets("ssh-mcp-worker", { ...input, MCP_BROKER_TOKEN: "short" }), /32 characters/);
  assert.deepEqual(collectBootstrapSecrets("ssh-mcp-worker",
    { ...input, ENCRYPTION_KEY: "root-key", EDGE_SSH_DB: "root-db" }), input);
});
