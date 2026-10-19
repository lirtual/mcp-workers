import assert from "node:assert/strict";
import test from "node:test";
import { collectWorkerVars, WORKER_VARIABLES } from "./worker-release-variables.mjs";

test("each Worker owns an explicit non-secret variable allowlist", () => {
  assert.deepEqual(WORKER_VARIABLES["ssh-mcp-worker"], []);
  assert.deepEqual(WORKER_VARIABLES["remote-control-mcp-worker"], []);
  assert.deepEqual(collectWorkerVars("remote-control-mcp-worker",
    { MAX_ROWS: "100", REMOTE_CONTROL_V2_ONLY: "false" }), []);
  assert.throws(() => collectWorkerVars("not-a-worker", {}), /Unsupported/);
});

test("select only Worker-specific overrides; empty means source default", () => {
  assert.deepEqual(collectWorkerVars("raindrop-mcp-worker",
    { MAX_ROWS: "400", RAINDROP_RATE_LIMIT_MAX_RETRIES: "2" }), ["RAINDROP_RATE_LIMIT_MAX_RETRIES:2"]);
  assert.deepEqual(collectWorkerVars("database-mcp-worker",
    { MAX_ROWS: "500", MAX_RESULT_BYTES: "", IMA_BASE_URL: "https://other.example" }), ["MAX_ROWS:500"]);
  assert.deepEqual(collectWorkerVars("database-mcp-worker", {}), []);
});

test("reject multiline, excessive, or negative numeric configuration before Wrangler", () => {
  for (const value of ["-1", "5001", "1\nSECRET=oops", "NaN", "01", "0.5", "9999999999999999"]) {
    assert.throws(() => collectWorkerVars("database-mcp-worker", { MAX_ROWS: value }), /MAX_ROWS/);
  }
  assert.deepEqual(collectWorkerVars("database-mcp-worker", { QUERY_TIMEOUT_MS: "60000" }), ["QUERY_TIMEOUT_MS:60000"]);
  assert.throws(() => collectWorkerVars("database-mcp-worker", { QUERY_TIMEOUT_MS: "60001" }), /QUERY_TIMEOUT_MS/);
});

test("IMA URL must be HTTPS and cannot contain userinfo, hashes or newlines", () => {
  assert.deepEqual(collectWorkerVars("ima-mcp-worker", { CLIENT_ID: "ima-client-123", IMA_BASE_URL: "https://ima.example.com/api" }),
    ["CLIENT_ID:ima-client-123", "IMA_BASE_URL:https://ima.example.com/api"]);
  for (const value of ["http://ima.example.com", "https://user:pass@ima.example.com",
    "https://ima.example.com/#frag", "https://ima.example.com/\nX"]) {
    assert.throws(() => collectWorkerVars("ima-mcp-worker", { IMA_BASE_URL: value }), /IMA_BASE_URL/);
  }
});
