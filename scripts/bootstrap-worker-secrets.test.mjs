import assert from "node:assert/strict";
import test from "node:test";
import { BOOTSTRAP_SECRETS, collectBootstrapSecrets } from "./bootstrap-worker-secrets.mjs";

const fixtures = {
  "raindrop-mcp-worker": { MCP_ACCESS_TOKEN: "portal", RAINDROP_ACCESS_TOKEN: "raindrop" },
  "ima-mcp-worker": { MCP_ACCESS_TOKEN: "portal", IMA_API_KEY: "ima-key" },
  "database-mcp-worker": { MCP_ACCESS_TOKEN: "portal", DATABASE_CONFIG: '{"sample":"mysql://user:pass@host/db"}' },
  "ssh-mcp-worker": { MCP_ACCESS_TOKEN: "portal", ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") },
  "remote-control-mcp-worker": { MCP_ACCESS_TOKEN: "portal" },
  "github-actions-mcp-worker": { MCP_ACCESS_TOKEN: "portal", ACTIONS_GITHUB_DISPATCH_TOKENS: "github-test-token" },
  "workflow-mcp-worker": { MCP_ACCESS_TOKEN: "portal", MCP_PORTAL_CLIENT_SECRET: "test-secret", WORKFLOW_GITHUB_DISPATCH_TOKEN: "x".repeat(24), SESSION_RUNTIME_DATA_KEY: Buffer.alloc(32, 9).toString("base64") },
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

test("SSH catalog key must be a canonical 32-byte Base64 key", () => {
  const input = fixtures["ssh-mcp-worker"];
  assert.throws(() => collectBootstrapSecrets("ssh-mcp-worker", { ...input, ENCRYPTION_KEY: "short" }), /32-byte key/);
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
      {...fixtures["workflow-mcp-worker"],SESSION_RUNTIME_DATA_KEY: invalid}),/SESSION_RUNTIME_DATA_KEY/);
  }
  const names=BOOTSTRAP_SECRETS["workflow-mcp-worker"];
  assert.ok(names.includes("WORKFLOW_GITHUB_DISPATCH_TOKEN"));
  for(const name of names)assert.doesNotMatch(name,/^GITHUB_/);
});

test("HTTP optional managed credentials are staged only when configured",()=>{
  const required={MCP_ACCESS_TOKEN:"synthetic-token"};
  assert.deepEqual(collectBootstrapSecrets("http-mcp-worker",required),required);
  const value="[]";
  assert.deepEqual(collectBootstrapSecrets("http-mcp-worker",{...required,HTTP_CREDENTIALS_JSON:value}),
    {...required,HTTP_CREDENTIALS_JSON:value});
  assert.throws(()=>collectBootstrapSecrets("http-mcp-worker",{...required,HTTP_CREDENTIALS_JSON:"{invalid"}),/Invalid/);
  assert.throws(()=>collectBootstrapSecrets("http-mcp-worker",{...required,HTTP_CREDENTIALS_JSON:"x".repeat(5200)}),/too large/);
});
