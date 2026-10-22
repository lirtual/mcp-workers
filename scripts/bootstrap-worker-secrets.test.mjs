import assert from "node:assert/strict";
import test from "node:test";
import { BOOTSTRAP_SECRETS, collectBootstrapSecrets } from "./bootstrap-worker-secrets.mjs";

const fixtures = {
  "raindrop-mcp-worker": { MCP_ACCESS_TOKEN: "portal", RAINDROP_ACCESS_TOKEN: "raindrop" },
  "ima-mcp-worker": { MCP_ACCESS_TOKEN: "portal", API_KEY: "ima-key" },
  "database-mcp-worker": { MCP_ACCESS_TOKEN: "portal", DATABASE_CONFIG: '{"sample":"mysql://user:pass@host/db"}' },
  "ssh-mcp-worker": { MCP_ACCESS_TOKEN: "portal", MCP_BROKER_TOKEN: "x".repeat(32) },
  "remote-control-mcp-worker": { MCP_ACCESS_TOKEN: "portal" },
  "github-actions-mcp-worker": { MCP_ACCESS_TOKEN: "portal", GH_TOKEN: "github-test-token" },
  "workflow-mcp-worker": { MCP_ACCESS_TOKEN: "portal", MCP_PORTAL_CLIENT_ID: "test-id", MCP_PORTAL_CLIENT_SECRET: "test-secret", GITHUB_EXECUTOR_TOKEN: "x".repeat(24) },
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

test("one GH_TOKEN Secret stages multiple PATs without additional secret names", () => {
  const primary = fixtures["github-actions-mcp-worker"];
  const mixed = { ...primary, GH_TOKEN: "pat1\npat2\npat3",
    GH_TOKEN_SECONDARY: "do-not-forward", GITHUB_REPOS: "ignored" };
  assert.deepEqual(collectBootstrapSecrets("github-actions-mcp-worker", mixed),
    { ...primary, GH_TOKEN: "pat1\npat2\npat3" });
  assert.throws(() => collectBootstrapSecrets("github-actions-mcp-worker",
    { ...primary, GH_TOKEN: "same\nsame" }), /Invalid or duplicate/);
  assert.throws(() => collectBootstrapSecrets("github-actions-mcp-worker",
    { ...primary, GH_TOKEN: Array(9).fill("different").map((x,i) => x + i).join("\n") }),
    /Invalid or duplicate/);
});

test("Workflow release always stages the dedicated Portal and GitHub credentials",()=>{
  const expected=fixtures["workflow-mcp-worker"];
  assert.deepEqual(collectBootstrapSecrets("workflow-mcp-worker",expected),expected);
  for(const name of Object.keys(expected)){
    assert.throws(()=>collectBootstrapSecrets("workflow-mcp-worker",{...expected,[name]:""}),new RegExp(name));
  }
  assert.deepEqual(collectBootstrapSecrets("raindrop-mcp-worker",{
    ...fixtures["raindrop-mcp-worker"],...expected
  }),fixtures["raindrop-mcp-worker"]);
});


test("Workflow registered GitHub token must be nonblank, bounded and not multiline",()=>{
  const valid=fixtures["workflow-mcp-worker"];
  for(const invalid of ["short","x".repeat(513),"foo\nbar"]){
    assert.throws(()=>collectBootstrapSecrets("workflow-mcp-worker",
      {...valid,GITHUB_EXECUTOR_TOKEN:invalid}),/GITHUB_EXECUTOR_TOKEN/);
  }
  assert.deepEqual(collectBootstrapSecrets("workflow-mcp-worker",{...valid,GH_TOKEN:"ignored"}),valid);
});
