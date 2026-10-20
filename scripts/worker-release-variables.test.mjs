import assert from "node:assert/strict";
import test from "node:test";
import { collectWorkerVars, remoteControlInstallOrigin, WORKER_VARIABLES } from "./worker-release-variables.mjs";

const remoteConfig = { routes: [
  { pattern: "rca.lirtual.dpdns.org", custom_domain: true },
] };

test("Remote Control installer origin comes only from its configured Custom Domain", () => {
  assert.equal(remoteControlInstallOrigin(remoteConfig), "https://rca.lirtual.dpdns.org");
  assert.deepEqual(collectWorkerVars("remote-control-mcp-worker", {}, { config: remoteConfig }),
    ["REMOTE_CONTROL_INSTALL_ORIGIN:https://rca.lirtual.dpdns.org"]);
  assert.throws(() => collectWorkerVars("remote-control-mcp-worker", {}), /Custom Domain/);
  for (const bad of [
    { routes: [] },
    { routes: [{ pattern: "*.example.com", custom_domain: true }] },
    { routes: [{ pattern: "foo.example.com/*", custom_domain: true }] },
    { routes: [{ pattern: "example.com:8443", custom_domain: true }] },
    { routes: [{ pattern: "foo.example.com", custom_domain: false }] },
    { routes: [{ pattern: "foo.example.com", custom_domain: true }, { pattern: "bar.example.com", custom_domain: true }] },
  ]) {
    assert.throws(() => remoteControlInstallOrigin(bad), /Custom Domain|hostname/);
  }
});

test("each Worker owns an explicit non-secret variable allowlist", () => {
  assert.deepEqual(WORKER_VARIABLES["ssh-mcp-worker"], []);
  assert.deepEqual(WORKER_VARIABLES["remote-control-mcp-worker"], []);
  assert.deepEqual(collectWorkerVars("remote-control-mcp-worker",
    { MAX_ROWS: "100", REMOTE_CONTROL_V2_ONLY: "false", REMOTE_CONTROL_INSTALL_ORIGIN: "https://evil.example" }, { config: remoteConfig }),
    ["REMOTE_CONTROL_INSTALL_ORIGIN:https://rca.lirtual.dpdns.org"]);
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
    assert.throws(() => collectWorkerVars("ima-mcp-worker", { CLIENT_ID: "ima-client-123", IMA_BASE_URL: value }), /IMA_BASE_URL/);
  }
});

test("IMA CLIENT_ID must be present as a non-secret GitHub Variable", () => {
  assert.deepEqual(collectWorkerVars("ima-mcp-worker", { CLIENT_ID: "123456789" }),
    ["CLIENT_ID:123456789"]);
  for (const value of [undefined, "", " ", "\n", "\t", "a\nb", "a b", "a\u0000b", "a".repeat(513)]) {
    const env = value === undefined ? {} : { CLIENT_ID: value };
    assert.throws(() => collectWorkerVars("ima-mcp-worker", env), /CLIENT_ID/);
  }
  // Old GitHub Secrets must never satisfy the new required plain-text variable.
  assert.throws(() => collectWorkerVars("ima-mcp-worker",
    { API_KEY: "secret", IMA_BASE_URL: "https://ima.qq.com" }), /CLIENT_ID/);
});


test("GitHub Actions repo overrides come only from the selected Worker Environment", () => {
  assert.deepEqual(collectWorkerVars("github-actions-mcp-worker", {}), []);
  assert.deepEqual(collectWorkerVars("github-actions-mcp-worker",
    { GITHUB_REPOS: "autoactions/tsrv,autoactions/tsvc", API_KEY: "never-pass" }),
    ["GITHUB_REPOS:autoactions/tsrv,autoactions/tsvc"]);
  for (const bad of ["../test", "a/repo, ../evil", "a/repo\\nb/repo", "a", "a/repo:", "a/repo,"]) {
    assert.throws(() => collectWorkerVars("github-actions-mcp-worker", { GITHUB_REPOS: bad }),
      /GITHUB_REPOS/);
  }
});
