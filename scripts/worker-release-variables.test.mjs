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
  assert.deepEqual(WORKER_VARIABLES["workflow-mcp-worker"], []);
  assert.deepEqual(collectWorkerVars("workflow-mcp-worker", { S2_READONLY_ENABLED: "true", GH_TOKEN: "ignored" }), []);
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


test("GitHub Actions has no redundant repository allowlist variables", () => {
  assert.deepEqual(collectWorkerVars("github-actions-mcp-worker", {}), []);
  assert.deepEqual(collectWorkerVars("github-actions-mcp-worker", {
    GITHUB_REPOS: "ignored", GITHUB_REPOS_SECONDARY: "ignored",
  }), []);
});

test("Workflow S2 runtime switch is explicit and pinned to the production MCP Portal", () => {
  assert.deepEqual(collectWorkerVars("workflow-mcp-worker", {
    S2_READONLY_ENABLED: "true",
    S2_PORTAL_ENDPOINT: "https://test-mcp.lirtual.dpdns.org/mcp",
  }), []);
  assert.deepEqual(collectWorkerVars("workflow-mcp-worker", {
    WORKFLOW_S2_RELEASE: "true",
    S2_PORTAL_ENDPOINT: "https://untrusted.example.org/mcp",
    S2_DIRECT_TARGETS_ENABLED: "true",
    S3_ENABLED: "true",
  }), [
    "S2_READONLY_ENABLED:true",
    "S2_PORTAL_ENDPOINT:https://mcp.lirtual.dpdns.org/mcp",
  ]);
  assert.throws(() => collectWorkerVars("raindrop-mcp-worker", {
    WORKFLOW_S2_RELEASE:"true",
  }), /S2 release is allowed only/);
});


test("S3 production variables use only registered fixed GitHub echo authority",()=>{
  const selected=collectWorkerVars("workflow-mcp-worker",{
    WORKFLOW_S2_RELEASE:"true",WORKFLOW_S3_RELEASE:"true",
    S3_GITHUB_REPOSITORY:"untrusted/other",S3_GITHUB_REF:"refs/heads/evil",
    S3_GITHUB_AUDIENCE:"untrusted",S3_ENABLED:"false",
  });
  assert.deepEqual(selected,[
    "S3_ENABLED:true","S3_GITHUB_REPOSITORY:lirtual/mcp-workers",
    "S3_GITHUB_REPOSITORY_ID:1414936394","S3_GITHUB_REF:refs/heads/main",
    "S3_GITHUB_AUDIENCE:workflow-s3-claim:production",
    "S2_READONLY_ENABLED:true","S2_PORTAL_ENDPOINT:https://mcp.lirtual.dpdns.org/mcp",
  ]);
  assert.throws(()=>collectWorkerVars("workflow-mcp-worker",{
    WORKFLOW_S3_RELEASE:"true"}),/S3 release requires/);
  assert.throws(()=>collectWorkerVars("raindrop-mcp-worker",{
    WORKFLOW_S2_RELEASE:"true",WORKFLOW_S3_RELEASE:"true"}),/S3 release requires/);
  assert.deepEqual(collectWorkerVars("workflow-mcp-worker",{
    WORKFLOW_S2_RELEASE:"true",S3_ENABLED:"true"}),[
      "S2_READONLY_ENABLED:true","S2_PORTAL_ENDPOINT:https://mcp.lirtual.dpdns.org/mcp",
    ]);
});
