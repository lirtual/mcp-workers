import assert from "node:assert/strict";
import test from "node:test";
import { collectWorkerVars, remoteControlInstallOrigin, WORKER_VARIABLES } from "./worker-release-variables.mjs";

const dbOwner = { ACCESS_TEAM_DOMAIN: "owner.cloudflareaccess.com", ACCESS_AUD: "a".repeat(64), OWNER_EMAIL: "owner@example.com" };
const dbVars = (overrides = {}) => ({ ...dbOwner, ...overrides });
const dbOutput = Object.entries(dbOwner).map(([key, value]) => key + ":" + value);

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
  assert.deepEqual(WORKER_VARIABLES["email-mcp-worker"], ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "OWNER_EMAIL"]);
  assert.deepEqual(WORKER_VARIABLES["ssh-mcp-worker"], []);
  assert.deepEqual(WORKER_VARIABLES["workflow-mcp-worker"], ["MCP_PORTAL_CLIENT_ID", "ACTIONS_DEPLOYMENT_ID"]);
  assert.deepEqual(collectWorkerVars("workflow-mcp-worker",{ACTIONS_GITHUB_DISPATCH_TOKENS:"ignored", MCP_PORTAL_CLIENT_ID:"test-id"}).length,3);
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
    dbVars({ MAX_ROWS: "500", MAX_RESULT_BYTES: "", IMA_BASE_URL: "https://other.example" })), ["MAX_ROWS:500", ...dbOutput]);
  assert.deepEqual(collectWorkerVars("database-mcp-worker", dbVars()), dbOutput);
});

test("Database Owner Access variables must be explicitly configured", () => {
  assert.deepEqual(collectWorkerVars("database-mcp-worker", dbOwner), dbOutput);
  for (const name of Object.keys(dbOwner)) {
    const missing = dbVars();
    delete missing[name];
    assert.throws(() => collectWorkerVars("database-mcp-worker", missing), /Database Owner Access Variable/);
  }
  assert.throws(() => collectWorkerVars("database-mcp-worker",
    dbVars({ ACCESS_TEAM_DOMAIN: "https://owner.cloudflareaccess.com" })), /Database Owner Access Variable/);
});

test("reject multiline, excessive, or negative numeric configuration before Wrangler", () => {
  for (const value of ["-1", "5001", "1\nSECRET=oops", "NaN", "01", "0.5", "9999999999999999"]) {
    assert.throws(() => collectWorkerVars("database-mcp-worker", dbVars({ MAX_ROWS: value })), /MAX_ROWS/);
  }
  assert.deepEqual(collectWorkerVars("database-mcp-worker", dbVars({ QUERY_TIMEOUT_MS: "60000" })), ["QUERY_TIMEOUT_MS:60000", ...dbOutput]);
  assert.throws(() => collectWorkerVars("database-mcp-worker", dbVars({ QUERY_TIMEOUT_MS: "60001" })), /QUERY_TIMEOUT_MS/);
});

test("IMA URL must be HTTPS and cannot contain userinfo, hashes or newlines", () => {
  assert.deepEqual(collectWorkerVars("ima-mcp-worker", { IMA_CLIENT_ID: "ima-client-123", IMA_BASE_URL: "https://ima.example.com/api" }),
    ["IMA_CLIENT_ID:ima-client-123", "IMA_BASE_URL:https://ima.example.com/api"]);
  for (const value of ["http://ima.example.com", "https://user:pass@ima.example.com",
    "https://ima.example.com/#frag", "https://ima.example.com/\nX"]) {
    assert.throws(() => collectWorkerVars("ima-mcp-worker", { IMA_CLIENT_ID: "ima-client-123", IMA_BASE_URL: value }), /IMA_BASE_URL/);
  }
});

test("IMA IMA_CLIENT_ID must be present as a non-secret GitHub Variable", () => {
  assert.deepEqual(collectWorkerVars("ima-mcp-worker", { IMA_CLIENT_ID: "123456789" }),
    ["IMA_CLIENT_ID:123456789"]);
  for (const value of [undefined, "", " ", "\n", "\t", "a\nb", "a b", "a\u0000b", "a".repeat(513)]) {
    const env = value === undefined ? {} : { IMA_CLIENT_ID: value };
    assert.throws(() => collectWorkerVars("ima-mcp-worker", env), /IMA_CLIENT_ID/);
  }
  // Old GitHub Secrets must never satisfy the new required plain-text variable.
  assert.throws(() => collectWorkerVars("ima-mcp-worker",
    { IMA_API_KEY: "secret", IMA_BASE_URL: "https://ima.qq.com" }), /IMA_CLIENT_ID/);
});


test("GitHub Actions has no redundant repository allowlist variables", () => {
  assert.deepEqual(collectWorkerVars("github-actions-mcp-worker", {}), []);
  assert.deepEqual(collectWorkerVars("github-actions-mcp-worker", {
    GITHUB_REPOS: "ignored", GITHUB_REPOS_SECONDARY: "ignored",
  }), []);
});

test("Workflow has pinned MCP Portal and GitHub Action OIDC identity without rollout toggles",()=>{
  const fixed=collectWorkerVars("workflow-mcp-worker",{
    MCP_PORTAL_ENDPOINT:"https://attacker.invalid/mcp",
    MCP_PORTAL_CLIENT_ID:"test-id",
    GITHUB_EXECUTOR_REPOSITORY:"untrusted/other",
    MCP_CALL_ENABLED:"true",GITHUB_EXECUTION_ENABLED:"false"
  });
  assert.deepEqual(fixed,[
    "MCP_PORTAL_ENDPOINT:https://mcp.lirtual.dpdns.org/mcp",
    "GITHUB_ACTION_OIDC_AUDIENCE:workflow-github-action:production",
    "MCP_PORTAL_CLIENT_ID:test-id",
  ]);
  assert.deepEqual(collectWorkerVars("workflow-mcp-worker",{MCP_PORTAL_CLIENT_ID:"test-id"}),fixed);
});


test("Workflow Portal Client ID is a required validated Variable, never staged as Secret",()=>{
  assert.deepEqual(collectWorkerVars("workflow-mcp-worker",{MCP_PORTAL_CLIENT_ID:"example-client"}).at(-1),
    "MCP_PORTAL_CLIENT_ID:example-client");
  for(const value of [undefined,"", " ","a b","x\nsecret","x".repeat(513)]){
    const env=value===undefined?{}:{MCP_PORTAL_CLIENT_ID:value};
    assert.throws(()=>collectWorkerVars("workflow-mcp-worker",env),/MCP_PORTAL_CLIENT_ID/);
  }
});

test("Workflow Action repository grants are narrowly sourced from an explicit variable",()=>{
  const grants=[{repository:"lirtual/github-actions",repositoryId:1430925009,
    commitSha:"d0774dde3a87c7722a939403dbda45507f44b8e0"}];
  const pinned=collectWorkerVars("workflow-mcp-worker",{
    MCP_PORTAL_CLIENT_ID:"test-id",
    GITHUB_ACTION_APPROVED_REPOSITORIES:JSON.stringify(grants),
  });
  assert.equal(pinned.length,4);
  assert.deepEqual(JSON.parse(pinned[2].slice("GITHUB_ACTION_APPROVED_REPOSITORIES:".length)),
    grants);
  for(const invalid of [
    "not-json", "{}", JSON.stringify([{...grants[0],commitSha:"main"}]),
    JSON.stringify([{...grants[0],repositoryId:0}]),
    JSON.stringify([grants[0],grants[0]]),
    JSON.stringify([{...grants[0],extra:true}]),
    JSON.stringify([{...grants[0],repository:"other/../repo"}]),
  ]){
    assert.throws(()=>collectWorkerVars("workflow-mcp-worker",{
      MCP_PORTAL_CLIENT_ID:"test-id",
      GITHUB_ACTION_APPROVED_REPOSITORIES:invalid,
    }),/GITHUB_ACTION_APPROVED_REPOSITORIES/);
  }
  assert.equal(collectWorkerVars("raindrop-mcp-worker",{
    GITHUB_ACTION_APPROVED_REPOSITORIES:"garbage",
  }).length,0);
});

test("No other Worker inherits the Workflow GitHub executor's variables",()=>{
  const other=collectWorkerVars("raindrop-mcp-worker",{
    GITHUB_EXECUTOR_REPOSITORY:"untrusted/other",
    MCP_PORTAL_ENDPOINT:"https://attacker.invalid/mcp"
  });
  assert.deepEqual(other,[]);
});


test("Email Access Variables must match exact approved values", () => {
  const approved = { ACCESS_TEAM_DOMAIN: "lirtualzero.cloudflareaccess.com",
    ACCESS_AUD: "cea1cd806f0f68552c5bed2acd917afcaf8e18a7eda3fb19f5c9704c3a00cd1b",
    OWNER_EMAIL: "lirtual@outlook.com" };
  assert.deepEqual(collectWorkerVars("email-mcp-worker", { ...approved, MCP_ACCESS_TOKEN: "ignored" }),
    Object.entries(approved).map(([name,value]) => name + ":" + value));
  for (const name of Object.keys(approved)) {
    const missing = { ...approved }; delete missing[name];
    assert.throws(() => collectWorkerVars("email-mcp-worker", missing), /Email production Access Variable mismatch/);
    assert.throws(() => collectWorkerVars("email-mcp-worker",
      { ...approved, [name]: "bad-value" }), /Email production Access Variable mismatch/);
  }
});

test("Workflow Provider version variable accepts one reviewed immutable Worker Version ID only",()=>{
 const good="33333333-3333-4333-8333-333333333333";
 const values=collectWorkerVars("workflow-mcp-worker",{MCP_PORTAL_CLIENT_ID:"test-id",
  ACTIONS_DEPLOYMENT_ID:good});
 assert.ok(values.includes("ACTIONS_DEPLOYMENT_ID:"+good));
 for(const value of ["main","latest","", "00000000-0000-0000-0000-000000000000",
   "abc\nSECRET","33333333-3333-4333-8333-333333333333 extra"]) {
  if(!value)continue; // Absence rejected by the production CLI release entrypoint.
  assert.throws(()=>collectWorkerVars("workflow-mcp-worker",{MCP_PORTAL_CLIENT_ID:"test-id",
   ACTIONS_DEPLOYMENT_ID:value}),/ACTIONS_DEPLOYMENT_ID/);
 }
});


test("Browser activation requires two independent validated Access Variables",()=>{
  const good={BROWSER_ACCESS_ISSUER:"https://lirtualzero.cloudflareaccess.com",BROWSER_OWNER_EMAIL:"lirtual@outlook.com",BROWSER_ACTIVATION_ORIGIN:"https://browser.lirtual.dpdns.org",BROWSER_ACTIVATION_AUDIENCE:"b".repeat(64)};
  assert.deepEqual(collectWorkerVars("browser-mcp-worker",good),Object.entries(good).map(([k,v])=>k+":"+v));
  for(const bad of [
    {...good,BROWSER_ACTIVATION_AUDIENCE:undefined},
    {...good,BROWSER_ACTIVATION_ORIGIN:undefined},
    {...good,BROWSER_ACTIVATION_ORIGIN:"https://evil.example"},
    {...good,BROWSER_ACTIVATION_AUDIENCE:"invalid"},
    {...good,BROWSER_ACCESS_AUDIENCE:good.BROWSER_ACTIVATION_AUDIENCE}
  ])assert.throws(()=>collectWorkerVars("browser-mcp-worker",bad),/activation|approval/);
});


test("activation identity does not require an unverified high-impact approval isolation assertion",()=>{
  const env={BROWSER_ACCESS_ISSUER:"https://lirtualzero.cloudflareaccess.com",BROWSER_OWNER_EMAIL:"lirtual@outlook.com",BROWSER_ACTIVATION_ORIGIN:"https://browser.lirtual.dpdns.org",BROWSER_ACTIVATION_AUDIENCE:"c".repeat(64)};
  assert.equal(collectWorkerVars("browser-mcp-worker",env).length,4);
  assert.throws(()=>collectWorkerVars("browser-mcp-worker",{...env,BROWSER_APPROVAL_ORIGIN:"https://browser.lirtual.dpdns.org"}),/approval/);
});
