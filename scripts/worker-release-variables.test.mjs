import assert from "node:assert/strict";
import test from "node:test";
import { collectWorkerVars as originalCollectWorkerVars, remoteControlInstallOrigin, WORKER_VARIABLES } from "./worker-release-variables.mjs";

const externalRepository = "alternate-owner/private-actions";
const externalIdentity = {repository:externalRepository,repositoryId:8090,ciWorkflowId:9010};
function collectWorkerVars(worker, env={}, options={}) {
  if (worker !== "workflow-mcp-worker") return originalCollectWorkerVars(worker,env,options);
  return originalCollectWorkerVars(worker,{
    WORKFLOW_GITHUB_ACTION_REPOSITORY:externalRepository,...env
  },{workflowExecutorIdentity:externalIdentity,...options});
}

const dbOwner = { ACCESS_TEAM_DOMAIN: "owner.cloudflareaccess.com", DATABASE_ACCESS_AUD: "a".repeat(64), OWNER_EMAIL: "owner@example.com" };
const dbVars = (overrides = {}) => ({ DATABASE_CONNECTIONS:"{}", ...dbOwner, ...overrides });
const dbOutput = ['DATABASE_CONNECTIONS:{}'];

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
  assert.deepEqual(WORKER_VARIABLES["workflow-mcp-worker"], ["WORKFLOW_MCP_PORTAL_CLIENT_ID"]);
  assert.deepEqual(collectWorkerVars("workflow-mcp-worker",{ACTIONS_GITHUB_DISPATCH_TOKENS:"ignored", WORKFLOW_MCP_PORTAL_CLIENT_ID:"test-id"}).length,4);
  assert.deepEqual(WORKER_VARIABLES["remote-control-mcp-worker"], ["RCA_PERMANENT_IDLE_DAYS"]);
  assert.deepEqual(collectWorkerVars("remote-control-mcp-worker",
    { DATABASE_MAX_ROWS: "100", REMOTE_CONTROL_V2_ONLY: "false", REMOTE_CONTROL_INSTALL_ORIGIN: "https://evil.example" }, { config: remoteConfig }),
    ["REMOTE_CONTROL_INSTALL_ORIGIN:https://rca.lirtual.dpdns.org"]);
  assert.throws(() => collectWorkerVars("not-a-worker", {}), /Unsupported/);
});

test("select only Worker-specific overrides; empty means source default", () => {
  assert.deepEqual(collectWorkerVars("raindrop-mcp-worker",
    { DATABASE_MAX_ROWS: "400", RAINDROP_RATE_LIMIT_MAX_RETRIES: "2" }), ["RAINDROP_RATE_LIMIT_MAX_RETRIES:2"]);
  assert.deepEqual(collectWorkerVars("database-mcp-worker",
    dbVars({ DATABASE_MAX_ROWS: "500", DATABASE_MAX_RESULT_BYTES: "", IMA_BASE_URL: "https://other.example" })), [...dbOutput,"DATABASE_MAX_ROWS:500"]);
  assert.deepEqual(collectWorkerVars("database-mcp-worker", dbVars()), dbOutput);
});

test("reject multiline, excessive, or negative numeric configuration before Wrangler", () => {
  for (const value of ["-1", "5001", "1\nSECRET=oops", "NaN", "01", "0.5", "9999999999999999"]) {
    assert.throws(() => collectWorkerVars("database-mcp-worker", dbVars({ DATABASE_MAX_ROWS: value })), /DATABASE_MAX_ROWS/);
  }
  assert.deepEqual(collectWorkerVars("database-mcp-worker", dbVars({ DATABASE_QUERY_TIMEOUT_MS: "60000" })), [...dbOutput,"DATABASE_QUERY_TIMEOUT_MS:60000"]);
  assert.throws(() => collectWorkerVars("database-mcp-worker", dbVars({ DATABASE_QUERY_TIMEOUT_MS: "60001" })), /DATABASE_QUERY_TIMEOUT_MS/);
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
    WORKFLOW_MCP_PORTAL_ENDPOINT:"https://attacker.invalid/mcp",
    WORKFLOW_MCP_PORTAL_CLIENT_ID:"test-id",
    GITHUB_EXECUTOR_REPOSITORY:"untrusted/other",
    MCP_CALL_ENABLED:"true",GITHUB_EXECUTION_ENABLED:"false"
  });
  assert.deepEqual(fixed,[
    "WORKFLOW_MCP_PORTAL_ENDPOINT:https://mcp.lirtual.dpdns.org/mcp",
    "WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE:workflow-github-action",
    "WORKFLOW_GITHUB_ACTION_IDENTITY:"+JSON.stringify(externalIdentity),
    "WORKFLOW_MCP_PORTAL_CLIENT_ID:test-id",
  ]);
  assert.deepEqual(collectWorkerVars("workflow-mcp-worker",{WORKFLOW_MCP_PORTAL_CLIENT_ID:"test-id"}),fixed);
});


test("Workflow Portal Client ID is a required validated Variable, never staged as Secret",()=>{
  assert.deepEqual(collectWorkerVars("workflow-mcp-worker",{WORKFLOW_MCP_PORTAL_CLIENT_ID:"example-client"}).at(-1),
    "WORKFLOW_MCP_PORTAL_CLIENT_ID:example-client");
  for(const value of [undefined,"", " ","a b","x\nsecret","x".repeat(513)]){
    const env=value===undefined?{}:{WORKFLOW_MCP_PORTAL_CLIENT_ID:value};
    assert.throws(()=>collectWorkerVars("workflow-mcp-worker",env),/WORKFLOW_MCP_PORTAL_CLIENT_ID/);
  }
});

test("Workflow executor has one release-verified repository identity, not a JSON allowlist",()=>{
  const accepted=collectWorkerVars("workflow-mcp-worker",{WORKFLOW_MCP_PORTAL_CLIENT_ID:"test-id"});
  assert.ok(accepted.includes("WORKFLOW_GITHUB_ACTION_IDENTITY:"+JSON.stringify(externalIdentity)));
  assert.equal(accepted.length,4);
  for(const bad of ["x", "x/y/z", " [\"x/y\"]", "lirtual/github-actions"]){
    assert.throws(()=>collectWorkerVars("workflow-mcp-worker",{
      WORKFLOW_MCP_PORTAL_CLIENT_ID:"test-id",WORKFLOW_GITHUB_ACTION_REPOSITORY:bad
    }),/WORKFLOW_GITHUB_ACTION_REPOSITORY|not verified/);
  }
  assert.throws(()=>collectWorkerVars("workflow-mcp-worker",{
    WORKFLOW_MCP_PORTAL_CLIENT_ID:"test-id",
    WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES:"[]",
  }),/Obsolete/);
  assert.throws(()=>originalCollectWorkerVars("workflow-mcp-worker",{
    WORKFLOW_MCP_PORTAL_CLIENT_ID:"test-id"
  },{workflowExecutorIdentity:externalIdentity}),/WORKFLOW_GITHUB_ACTION_REPOSITORY/);
  assert.throws(()=>collectWorkerVars("workflow-mcp-worker",{
    WORKFLOW_MCP_PORTAL_CLIENT_ID:"test-id"
  },{workflowExecutorIdentity:{...externalIdentity,repository:"another/repo"}}),/not verified|WORKFLOW_GITHUB/);
});

test("No other Worker inherits the Workflow GitHub executor's variables",()=>{
  const other=collectWorkerVars("raindrop-mcp-worker",{
    GITHUB_EXECUTOR_REPOSITORY:"untrusted/other",
    WORKFLOW_MCP_PORTAL_ENDPOINT:"https://attacker.invalid/mcp"
  });
  assert.deepEqual(other,[]);
});



test("Workflow release never injects a deployment UUID from GitHub Variables",()=>{
 for(const value of ["33333333-3333-4333-8333-333333333333","latest","",
   "abc\nSECRET"]) {
  const vars=collectWorkerVars("workflow-mcp-worker",{
   WORKFLOW_MCP_PORTAL_CLIENT_ID:"test-id",ACTIONS_DEPLOYMENT_ID:value});
  assert.ok(!vars.some(x=>x.startsWith("ACTIONS_DEPLOYMENT_ID:")));
  assert.ok(vars.includes("WORKFLOW_MCP_PORTAL_CLIENT_ID:test-id"));
 }
});


const sharedBrowser = {ACCESS_TEAM_DOMAIN:'owner.cloudflareaccess.com', OWNER_EMAIL:'owner@example.com'};
const browserConfig = {routes:[{pattern:'browser.lirtual.dpdns.org',custom_domain:true}]};
const browserBase = [
  'BROWSER_ACCESS_ISSUER:https://owner.cloudflareaccess.com',
  'BROWSER_OWNER_EMAIL:owner@example.com'
];

test('Browser activation is derived from the reviewed Custom Domain and rejects stale inputs',()=>{
  const env = {...sharedBrowser, BROWSER_ACTIVATION_AUDIENCE:'b'.repeat(64)};
  assert.deepEqual(collectWorkerVars('browser-mcp-worker',env,{config:browserConfig}),
    [...browserBase, 'BROWSER_ACTIVATION_ORIGIN:https://browser.lirtual.dpdns.org',
      'BROWSER_ACTIVATION_AUDIENCE:'+'b'.repeat(64)]);
  for(const bad of [
    {...env,BROWSER_ACTIVATION_AUDIENCE:'bad'},
    {...env,BROWSER_ACTIVATION_ORIGIN:'https://evil.example'},
    {...env,BROWSER_OWNER_EMAIL:'someone@example.com'},
    {...env,ACCESS_TEAM_DOMAIN:'https://owner.cloudflareaccess.com'},
    {...env,OWNER_EMAIL:'invalid'},
  ]) assert.throws(()=>collectWorkerVars('browser-mcp-worker',bad,{config:browserConfig}),
    /activation|shared|obsolete/i);
  assert.throws(()=>collectWorkerVars('browser-mcp-worker',env), /Custom Domain/);
});

test('legacy review isolation input cannot alter new browser identity',()=>{
  const input={...sharedBrowser,BROWSER_ACTIVATION_AUDIENCE:'c'.repeat(64)};
  assert.deepEqual(collectWorkerVars('browser-mcp-worker',{
    ...input,BROWSER_APPROVAL_ORIGIN:'https://wrong.example'}, {config:browserConfig}),
    [...browserBase,'BROWSER_ACTIVATION_ORIGIN:https://browser.lirtual.dpdns.org',
      'BROWSER_ACTIVATION_AUDIENCE:'+'c'.repeat(64)]);
});

test('Browser remembered idle setting is optional, scoped and validated',()=>{
  assert.deepEqual(collectWorkerVars('browser-mcp-worker',sharedBrowser,{config:browserConfig}),browserBase);
  assert.deepEqual(collectWorkerVars('browser-mcp-worker',
    {...sharedBrowser,BROWSER_REMEMBERED_IDLE_DAYS:''},{config:browserConfig}),browserBase);
  for(const days of ['1','7','14','30','90']){
    assert.deepEqual(collectWorkerVars('browser-mcp-worker',
      {...sharedBrowser,BROWSER_REMEMBERED_IDLE_DAYS:days},{config:browserConfig}),
      [...browserBase,'BROWSER_REMEMBERED_IDLE_DAYS:'+days]);
  }
  for(const days of ['0','91','-1','1.0',' 14','14 ','bad','001']){
    assert.throws(()=>collectWorkerVars('browser-mcp-worker',
      {...sharedBrowser,BROWSER_REMEMBERED_IDLE_DAYS:days},{config:browserConfig}), /BROWSER_REMEMBERED_IDLE_DAYS/);
  }
  assert.deepEqual(collectWorkerVars('ssh-mcp-worker',{BROWSER_REMEMBERED_IDLE_DAYS:'30'}),[]);
});

test('RCA idle release duration is selected-worker scoped, validated and never permissive', () => {
  const expected = ['REMOTE_CONTROL_INSTALL_ORIGIN:https://rca.lirtual.dpdns.org'];
  assert.deepEqual(collectWorkerVars('remote-control-mcp-worker', {}, { config: remoteConfig }), expected);
  for (const days of ['1','7','14','30','90']) {
    assert.deepEqual(collectWorkerVars('remote-control-mcp-worker', { RCA_PERMANENT_IDLE_DAYS: days }, { config: remoteConfig }),
      [...expected, 'RCA_PERMANENT_IDLE_DAYS:' + days]);
    assert.deepEqual(collectWorkerVars('ssh-mcp-worker', { RCA_PERMANENT_IDLE_DAYS: days }), []);
  }
  for (const days of ['0','91','-1','2.5',' 7','07','7 ','Infinity','x','999999999999999999999']) {
    assert.throws(() => collectWorkerVars('remote-control-mcp-worker', { RCA_PERMANENT_IDLE_DAYS: days }, { config: remoteConfig }), /RCA_PERMANENT_IDLE_DAYS/);
  }
});

test('Spec 733: Browser derives Access identity and activation origin from shared source and reviewed route', () => {
  const browser = { routes: [{pattern: 'browser.lirtual.dpdns.org', custom_domain: true}] };
  assert.deepEqual(collectWorkerVars('browser-mcp-worker', {
    ACCESS_TEAM_DOMAIN: 'owner.cloudflareaccess.com', OWNER_EMAIL: 'owner@example.com',
    BROWSER_ACTIVATION_AUDIENCE: 'a'.repeat(64),
  }, {config:browser}), [
    'BROWSER_ACCESS_ISSUER:https://owner.cloudflareaccess.com',
    'BROWSER_OWNER_EMAIL:owner@example.com',
    'BROWSER_ACTIVATION_ORIGIN:https://browser.lirtual.dpdns.org',
    'BROWSER_ACTIVATION_AUDIENCE:'+'a'.repeat(64),
  ]);
  assert.throws(() => collectWorkerVars('browser-mcp-worker', {
    ACCESS_TEAM_DOMAIN:'owner.cloudflareaccess.com', OWNER_EMAIL:'owner@example.com',
    BROWSER_ACCESS_ISSUER:'https://wrong.cloudflareaccess.com'
  }, {config:browser}), /independent|obsolete|source/i);
});

test('Database retains prefixed limits while removing Setup Access variables', () => {
  assert.deepEqual(collectWorkerVars('database-mcp-worker',dbVars({DATABASE_MAX_ROWS:'35'})),
    ['DATABASE_CONNECTIONS:{}','DATABASE_MAX_ROWS:35']);
});

test('Spec #804 stages Browser runtime values only from protected candidate state',async()=>{
  const {mkdtempSync,writeFileSync,readFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {spawnSync}=await import('node:child_process');
  const root=mkdtempSync(join(tmpdir(),'spec804-browser-'));
  try {
    const sha='a'.repeat(40), account='c'.repeat(32);
    const state=join(root,'release.json'),output=join(root,'stage.txt');
    const env={...process.env,RUNNER_TEMP:root,RELEASE_STATE_FILE:state,
      GITHUB_SHA:sha,CLOUDFLARE_ACCOUNT_ID:account,OWNER_EMAIL:'owner@example.com'};
    delete env.ACCESS_TEAM_DOMAIN;
    delete env.BROWSER_ACTIVATION_AUDIENCE;
    const candidate={worker:'browser-mcp-worker',sourceSha:sha,browserIdentity:{
      accountId:account,appId:'77945f97-e1ea-4b2b-b89a-ec71c0472afa',
      teamDomain:'owner.cloudflareaccess.com',ownerEmail:env.OWNER_EMAIL,
      audience:'a'.repeat(64),origin:'https://browser.lirtual.dpdns.org'
    }};
    const run=()=>spawnSync(process.execPath,['scripts/worker-release-variables.mjs',
      'browser-mcp-worker',output],{cwd:new URL('..',import.meta.url),env,encoding:'utf8'});
    writeFileSync(state,JSON.stringify(candidate));
    assert.equal(run().status,0);
    assert.deepEqual(readFileSync(output,'utf8').trim().split('\n'),[
      'BROWSER_ACCESS_ISSUER:https://owner.cloudflareaccess.com',
      'BROWSER_OWNER_EMAIL:owner@example.com',
      'BROWSER_ACTIVATION_ORIGIN:https://browser.lirtual.dpdns.org',
      'BROWSER_ACTIVATION_AUDIENCE:'+'a'.repeat(64)
    ]);
    rmSync(output);
    writeFileSync(state,JSON.stringify({...candidate,sourceSha:'b'.repeat(40)}));
    assert.notEqual(run().status,0);
    assert.throws(()=>readFileSync(output,'utf8'));
  } finally {rmSync(root,{recursive:true,force:true});}
});
