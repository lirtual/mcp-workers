import assert from "node:assert/strict";
import test from "node:test";
import { BOOTSTRAP_SECRETS, parseBootstrapSecrets } from "./bootstrap-worker-secrets.mjs";

const fixtures = {
  "raindrop-mcp-worker": {
    MCP_ACCESS_TOKEN: "portal-token", RAINDROP_ACCESS_TOKEN: "raindrop-token",
  },
  "ima-mcp-worker": {
    MCP_ACCESS_TOKEN: "portal-token", API_KEY: "ima-key", CLIENT_ID: "client-id",
  },
  "database-mcp-worker": {
    MCP_ACCESS_TOKEN: "portal-token", DATABASE_CONFIG: '{"connections":[]}',
  },
  "ssh-mcp-worker": {
    MCP_ACCESS_TOKEN: "portal-token", MCP_BROKER_TOKEN: "b".repeat(32),
  },
};

test("only four selected Workers may bootstrap; Remote Control cannot", () => {
  assert.deepEqual(Object.keys(BOOTSTRAP_SECRETS).sort(), Object.keys(fixtures).sort());
  assert.throws(() => parseBootstrapSecrets("remote-control-mcp-worker", "{}"), /not enabled/);
});

test("exact Worker-specific secret keys are accepted without conversion", () => {
  for (const [worker, values] of Object.entries(fixtures)) {
    const parsed = parseBootstrapSecrets(worker, JSON.stringify(values));
    assert.deepEqual(parsed, values);
    assert.equal(typeof parsed.DATABASE_CONFIG, parsed.DATABASE_CONFIG === undefined ? "undefined" : "string");
  }
});

test("missing, empty, extra, wrong-type, and malformed secret sources fail closed", () => {
  const worker = "raindrop-mcp-worker";
  const good = fixtures[worker];
  assert.throws(() => parseBootstrapSecrets(worker, ""), /Missing/);
  assert.throws(() => parseBootstrapSecrets(worker, "not-json"), /valid JSON/);
  assert.throws(() => parseBootstrapSecrets(worker, "[]"), /JSON object/);
  assert.throws(() => parseBootstrapSecrets(worker, JSON.stringify({ MCP_ACCESS_TOKEN: "portal-token" })), /match/);
  assert.throws(() => parseBootstrapSecrets(worker, JSON.stringify({ ...good, EXTRA: "secret" })), /match/);
  assert.throws(() => parseBootstrapSecrets(worker, JSON.stringify({ ...good, MCP_ACCESS_TOKEN: "" })), /match/);
  assert.throws(() => parseBootstrapSecrets(worker, JSON.stringify({ ...good, MCP_ACCESS_TOKEN: 123 })), /match/);
  assert.throws(() => parseBootstrapSecrets(worker, JSON.stringify({ ...good, RAINDROP_ACCESS_TOKEN: null })), /match/);
});

test("SSH broker token is independently checked before any upload", () => {
  assert.throws(() => parseBootstrapSecrets("ssh-mcp-worker", JSON.stringify({
    ...fixtures["ssh-mcp-worker"], MCP_BROKER_TOKEN: "short",
  })), /32 characters/);
  assert.throws(() => parseBootstrapSecrets("ssh-mcp-worker", JSON.stringify({
    ...fixtures["ssh-mcp-worker"], ENCRYPTION_KEY: "must-not-upload",
  })), /match/);
});
