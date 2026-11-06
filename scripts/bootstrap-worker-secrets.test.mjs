import assert from "node:assert/strict";
import test from "node:test";
import { BOOTSTRAP_SECRETS, collectBootstrapSecrets } from "./bootstrap-worker-secrets.mjs";

const fixtures = {
  "browser-mcp-worker": { MCP_ACCESS_TOKEN: "independent-browser-token" },
  "raindrop-mcp-worker": { MCP_ACCESS_TOKEN: "portal", RAINDROP_ACCESS_TOKEN: "raindrop" },
  "ima-mcp-worker": { MCP_ACCESS_TOKEN: "portal", IMA_API_KEY: "ima-key" },
  "database-mcp-worker": { MCP_ACCESS_TOKEN: "portal", DATABASE_CONNECTIONS: "{}" },
  "ssh-mcp-worker": { MCP_ACCESS_TOKEN: "portal", SSH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") },
  "remote-control-mcp-worker": { MCP_ACCESS_TOKEN: "portal" },
  "github-actions-mcp-worker": { MCP_ACCESS_TOKEN: "portal", ACTIONS_GITHUB_DISPATCH_TOKENS: "github-test-token" },
  "workflow-mcp-worker": { MCP_ACCESS_TOKEN: "portal", WORKFLOW_MCP_PORTAL_CLIENT_SECRET: "test-secret", WORKFLOW_GITHUB_DISPATCH_TOKEN: "x".repeat(24), WORKFLOW_SESSION_RUNTIME_DATA_KEY: Buffer.alloc(32, 9).toString("base64") },
};

test("bootstrap supports all selected Workers, including isolated Remote Control", () => {
  assert.deepEqual(Object.keys(BOOTSTRAP_SECRETS).sort(), Object.keys(fixtures).sort());
  assert.deepEqual(collectBootstrapSecrets("remote-control-mcp-worker", { ...fixtures["remote-control-mcp-worker"], REMOTE_CONTROL_DEVICE_TOKEN: "legacy" }), fixtures["remote-control-mcp-worker"]);
  assert.throws(() => collectBootstrapSecrets("unlisted-worker", {}), /not enabled/);
});

test("selected Worker receives only required named secrets (no JSON wrappers)", () => {
  for (const [worker, selected] of Object.entries(fixtures)) {
    const env = { ...selected, OTHER_WORKER_KEY: "do-not-copy", RAINDROP_MCP_SECRETS_JSON: "obsolete" };
    const parsed = collectBootstrapSecrets(worker, env);
    assert.deepEqual(parsed, worker === "database-mcp-worker" ? {MCP_ACCESS_TOKEN:"portal"} : selected);
    assert.equal(Object.hasOwn(parsed, "OTHER_WORKER_KEY"), false);
  }
});

test("missing or empty Secrets fail before any deploy, including shared portal bearer", () => {
  for (const [worker, values] of Object.entries(fixtures)) {
    for (const name of Object.keys(values).filter(name=>name!=="DATABASE_CONNECTIONS")) {
      const missing = { ...values };
      delete missing[name];
      assert.throws(() => collectBootstrapSecrets(worker, missing), new RegExp(name));
      assert.throws(() => collectBootstrapSecrets(worker, { ...values, [name]: " " }), new RegExp(name));
    }
  }
});

test("SSH catalog key must be a canonical 32-byte Base64 key", () => {
  const input = fixtures["ssh-mcp-worker"];
  assert.throws(() => collectBootstrapSecrets("ssh-mcp-worker", { ...input, SSH_ENCRYPTION_KEY: "short" }), /32-byte key/);
  assert.deepEqual(collectBootstrapSecrets("ssh-mcp-worker",
    { ...input, SSH_BROKER_TOKEN: "retired", EDGE_SSH_DB: "binding-is-not-secret" }), input);
});

test("one ACTIONS_GITHUB_DISPATCH_TOKENS Secret stages multiple PATs without additional secret names", () => {
  const primary = fixtures["github-actions-mcp-worker"];
  const mixed = { ...primary, ACTIONS_GITHUB_DISPATCH_TOKENS: "pat1\npat2\npat3",
    GH_TOKEN_SECONDARY: "do-not-forward", GITHUB_REPOS: "ignored" };
  assert.deepEqual(collectBootstrapSecrets("github-actions-mcp-worker", mixed),
    { ...primary, ACTIONS_GITHUB_DISPATCH_TOKENS: "pat1\npat2\npat3" });
  assert.throws(() => collectBootstrapSecrets("github-actions-mcp-worker",
    { ...primary, ACTIONS_GITHUB_DISPATCH_TOKENS: "same\nsame" }), /Invalid or duplicate/);
  assert.throws(() => collectBootstrapSecrets("github-actions-mcp-worker",
    { ...primary, ACTIONS_GITHUB_DISPATCH_TOKENS: Array(9).fill("different").map((x,i) => x + i).join("\n") }),
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


test("Workflow full release requires canonical Secrets and rejects real-byte drift", () => {
  const worker = "workflow-mcp-worker";
  const canonical = fixtures[worker];
  const pairs = [
    ["WORKFLOW_MCP_PORTAL_CLIENT_SECRET", "MCP_PORTAL_CLIENT_SECRET"],
    ["WORKFLOW_SESSION_RUNTIME_DATA_KEY", "SESSION_RUNTIME_DATA_KEY"],
  ];
  const withLegacy = { ...canonical,
    MCP_PORTAL_CLIENT_SECRET: canonical.WORKFLOW_MCP_PORTAL_CLIENT_SECRET,
    SESSION_RUNTIME_DATA_KEY: canonical.WORKFLOW_SESSION_RUNTIME_DATA_KEY,
  };
  // The old names are comparison inputs only, never published as new bindings.
  assert.deepEqual(collectBootstrapSecrets(worker, withLegacy), canonical);
  // After independently authorized legacy retirement, canonical-only still works.
  assert.deepEqual(collectBootstrapSecrets(worker, canonical), canonical);
  for (const [name, legacy] of pairs) {
    const missing = { ...withLegacy };
    delete missing[name];
    assert.throws(() => collectBootstrapSecrets(worker, missing), new RegExp(name));
    assert.throws(() => collectBootstrapSecrets(worker, { ...withLegacy, [name]: "" }), new RegExp(name));

    const drift = { ...withLegacy, [legacy]: canonical[legacy] + "\n" };
    assert.throws(() => collectBootstrapSecrets(worker, drift), /original-byte mismatch/);
    assert.deepEqual(collectBootstrapSecrets(worker, { ...withLegacy, [legacy]: "" }), canonical);
  }
  // Different UTF-8 strings with the same character count cannot pass parity.
  const unicode = { ...withLegacy,
    WORKFLOW_MCP_PORTAL_CLIENT_SECRET: "é",
    MCP_PORTAL_CLIENT_SECRET: "ê",
  };
  assert.throws(() => collectBootstrapSecrets(worker, unicode), /original-byte mismatch/);
  const secretCanary = "synthetic-test-canary-value";
  assert.throws(() => collectBootstrapSecrets(worker, {
    ...withLegacy, MCP_PORTAL_CLIENT_SECRET: secretCanary,
  }), error => /original-byte mismatch/.test(error.message) && !error.message.includes(secretCanary));
});

test("Workflow registered GitHub token must be nonblank, bounded and not multiline",()=>{
  const valid=fixtures["workflow-mcp-worker"];
  for(const invalid of ["short","x".repeat(513),"foo\nbar"]){
    assert.throws(()=>collectBootstrapSecrets("workflow-mcp-worker",
      {...valid,WORKFLOW_GITHUB_DISPATCH_TOKEN:invalid}),/WORKFLOW_GITHUB_DISPATCH_TOKEN/);
  }
  assert.deepEqual(collectBootstrapSecrets("workflow-mcp-worker",{...valid,ACTIONS_GITHUB_DISPATCH_TOKENS:"ignored"}),valid);
});

test("Workflow GitHub Environment secrets never use reserved GITHUB_ names",()=>{
  for (const invalid of ["bad", Buffer.alloc(31).toString("base64"), Buffer.alloc(32).toString("base64").slice(0,-1)]) {
    assert.throws(() => collectBootstrapSecrets("workflow-mcp-worker",
      {...fixtures["workflow-mcp-worker"],WORKFLOW_SESSION_RUNTIME_DATA_KEY: invalid}),/WORKFLOW_SESSION_RUNTIME_DATA_KEY/);
  }
  const names=BOOTSTRAP_SECRETS["workflow-mcp-worker"];
  assert.ok(names.includes("WORKFLOW_GITHUB_DISPATCH_TOKEN"));
  for(const name of names)assert.doesNotMatch(name,/^GITHUB_/);
});
