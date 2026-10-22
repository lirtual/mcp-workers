import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeVersion, verifyBindings, parseWranglerVersion, verifyPublishedVersion, verifyWorkflowReleaseConfig, verifyWorkflowD1Readiness } from "./manual-worker-release.mjs";

const required = [
  { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
  { name: "RAINDROP_ACCESS_TOKEN", type: "secret_text" },
];
const secretList = [{ name: "MCP_ACCESS_TOKEN" }, { name: "RAINDROP_ACCESS_TOKEN" }];
const goodSettings = { bindings: required, observability: { enabled: true, logs: { invocation_logs: true } } };

test("Raindrop required Secret names and bindings are preserved", () => {
  assert.equal(verifyBindings("raindrop-mcp-worker", goodSettings, secretList), true);
  assert.throws(() => verifyBindings("raindrop-mcp-worker", goodSettings, []), /Secret missing/);
  assert.throws(() => verifyBindings("raindrop-mcp-worker", { ...goodSettings, bindings: [] }, secretList),
    /binding missing/);
  assert.throws(() => verifyBindings("raindrop-mcp-worker", { ...goodSettings, observability: {} }, secretList),
    /Invocation Logs/);
  assert.throws(() => verifyBindings("not-a-worker", goodSettings, secretList), /target/);
});

test("Active-version readback requires exactly one 100 percent version", () => {
  const good = { deployments: [{ id: "deployment-one", versions: [{ version_id: "version-one", percentage: 100 }] }] };
  assert.deepEqual(activeVersion(good), { deployment_id: "deployment-one", version_id: "version-one" });
  assert.throws(() => activeVersion({ deployments: [] }), /unambiguous/);
  assert.throws(() => activeVersion({ deployments: [{ id: "mixed", versions: [
    { version_id: "a", percentage: 50 }, { version_id: "b", percentage: 50 },
  ] }] }), /unambiguous/);
});

test("IMA allows old CLIENT_ID Secret in preflight and requires Variable after release", () => {
  const worker = "ima-mcp-worker";
  const names = ["MCP_ACCESS_TOKEN", "API_KEY"];
  const secrets = names.map(name => ({ name }));
  const durable = { name: "IMA_IMAGE_REFRESH_SHARD", type: "durable_object_namespace", class_name: "ImaImageRefreshShard" };
  const observability = { enabled: true, logs: { invocation_logs: true }, traces: { enabled: true } };
  const old = { bindings: [...names.map(name => ({ name, type: "secret_text" })),
    { name: "CLIENT_ID", type: "secret_text" }, durable], observability };
  const oldSecrets = [...secrets, { name: "CLIENT_ID" }];
  assert.equal(verifyBindings(worker, old, oldSecrets, { mode: "preflight" }), true);
  assert.throws(() => verifyBindings(worker, old, oldSecrets, { mode: "readback" }), /CLIENT_ID.*Variable/);
  const settings = { bindings: [...names.map(name => ({ name, type: "secret_text" })),
    { name: "CLIENT_ID", type: "plain_text", text: "ima-client-id" }, durable], observability };
  assert.equal(verifyBindings(worker, settings, secrets, { mode: "readback" }), true);
  assert.throws(() => verifyBindings(worker, { ...settings,
    bindings: settings.bindings.filter(x => x.name !== "CLIENT_ID") }, secrets, { mode: "readback" }), /CLIENT_ID.*Variable/);
  assert.throws(() => verifyBindings(worker, { ...settings,
    bindings: settings.bindings.map(x => x.name === "CLIENT_ID" ? { ...x, text: " " } : x) },
    secrets, { mode: "readback" }), /CLIENT_ID.*Variable/);
  assert.throws(() => verifyBindings(worker, settings, oldSecrets, { mode: "readback" }), /legacy CLIENT_ID Secret/);
  assert.throws(() => verifyBindings(worker, { ...settings, bindings: [
    ...settings.bindings, { name: "R2_BUCKET", type: "r2_bucket" },
  ] }, secrets, { mode: "preflight" }), /Legacy IMA R2/);
  assert.throws(() => verifyBindings(worker, { ...settings, bindings:
    settings.bindings.filter(x => x.name !== "IMA_IMAGE_REFRESH_SHARD") }, secrets), /Durable Object/);
  assert.throws(() => verifyBindings(worker, { ...settings, observability: {
    enabled: true, logs: { invocation_logs: true },
  } }, secrets), /tracing drift/);
});

test("Database RATE_LIMITER and required runtime Secret names are a strict gate", () => {
  const names = ["MCP_ACCESS_TOKEN", "DATABASE_CONFIG"];
  const secrets = names.map((name) => ({ name }));
  const limiter = { name: "RATE_LIMITER", type: "ratelimit", namespace_id: "1001",
    simple: { limit: 120, period: 60 } };
  const settings = {
    bindings: [...names.map((name) => ({ name, type: "secret_text" })), limiter],
    observability: { enabled: true, logs: { invocation_logs: true } },
  };
  assert.equal(verifyBindings("database-mcp-worker", settings, secrets), true);
  assert.throws(() => verifyBindings("database-mcp-worker",
    { ...settings, bindings: settings.bindings.filter((x) => x.name !== "RATE_LIMITER") }, secrets), /RATE_LIMITER/);
  assert.throws(() => verifyBindings("database-mcp-worker",
    { ...settings, bindings: [...settings.bindings.slice(0, 2), { ...limiter, simple: { limit: 200, period: 60 } }] },
    secrets), /RATE_LIMITER/);
});

test("Remote production requires its own DO and rejects Preview namespace reuse", () => {
  const worker = "remote-control-mcp-worker";
  const previewNs = "c086eb6384ad41df9de13765d868324a";
  const productionNs = "abcd1234abcd1234abcd1234abcd1234";
  const prod = { bindings: [
    { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
    { name: "REMOTE_CONTROL_INSTALL_ORIGIN", type: "plain_text", text: "https://rca.lirtual.dpdns.org" },
    { name: "DEVICE_COORDINATOR", class_name: "DeviceCoordinator",
      type: "durable_object_namespace", namespace_id: productionNs },
  ], observability: { enabled: true, logs: { invocation_logs: false } } };
  const secrets = [{ name: "MCP_ACCESS_TOKEN" }];
  const options = { mode: "readback", previousNamespaceId: previewNs,
    sourceConfig: { routes: [{ pattern: "rca.lirtual.dpdns.org", custom_domain: true }] } };
  assert.equal(verifyBindings(worker, prod, secrets, options), true);
  assert.throws(() => verifyBindings(worker, prod, [], options), /Secret missing/);
  assert.throws(() => verifyBindings(worker, { ...prod,
    bindings: prod.bindings.filter(x => x.name !== "REMOTE_CONTROL_INSTALL_ORIGIN"),
  }, secrets, options), /installer origin/);
  assert.throws(() => verifyBindings(worker, { ...prod,
    bindings: prod.bindings.map(x => x.name === "REMOTE_CONTROL_INSTALL_ORIGIN"
      ? { ...x, text: "https://evil.example" } : x),
  }, secrets, options), /installer origin/);
  assert.throws(() => verifyBindings(worker, {
    ...prod, bindings: prod.bindings.map(x => x.name === "DEVICE_COORDINATOR"
      ? { ...x, namespace_id: previewNs } : x),
  }, secrets, options), /distinct from Preview/);
  assert.throws(() => verifyBindings(worker, {
    ...prod, bindings: [...prod.bindings,
      { name: "REMOTE_CONTROL_V2_ONLY", type: "plain_text", text: "true" }],
  }, secrets, options), /runtime switches/);
  assert.throws(() => verifyBindings(worker, {
    ...prod, bindings: [...prod.bindings,
      { name: "REMOTE_CONTROL_DEVICE", type: "vpc_service" }],
  }, secrets, options), /VPC/);
  const previous = { ...prod, bindings: [
    { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
    { name: "REMOTE_CONTROL_V2_ONLY", type: "plain_text", text: "true" },
    { name: "V2_OWNER", type: "durable_object_namespace", namespace_id: previewNs,
      class_name: "V2OwnerCoordinator", script_name: "remote-control-v2-preview" },
  ] };
  assert.equal(verifyBindings(worker, previous, secrets,
    { mode: "preflight", previousNamespaceId: previewNs }), true);
  assert.throws(() => verifyBindings(worker, previous, secrets, options), /DeviceCoordinator/);
  // A former Preview script and its DO can be deleted after cutover. Readback
  // compares against the saved preflight namespace, not a live Preview call.
  assert.equal(verifyBindings(worker, prod, secrets,
    options), true);
  assert.equal(verifyBindings(worker, prod, secrets,
    { mode: "preflight" }), true, "subsequent releases need no Preview worker");
  assert.throws(() => verifyBindings(worker, { ...prod,
    bindings: prod.bindings.map(x => x.name === "DEVICE_COORDINATOR"
      ? { ...x, script_name: "remote-control-v2-preview" } : x),
  }, secrets, options), /distinct from Preview/);
  assert.throws(() => verifyBindings(worker, { ...previous,
    bindings: previous.bindings.map(x => x.name === "V2_OWNER"
      ? { ...x, script_name: "unknown-worker" } : x),
  }, secrets, { mode: "preflight" }), /DeviceCoordinator/,
    "legacy preflight requires the known old Preview source");
});

test("Wrangler output requires a parseable release id, not upload-only success", () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  assert.equal(parseWranglerVersion("Current Version ID: " + id), id);
  assert.throws(() => parseWranglerVersion("Uploaded script"), /release Version ID/);
});

test("readback must match exact newly published Wrangler version", () => {
  const old = { version_id: "00000000-0000-4000-8000-000000000000", deployment_id: "old" };
  const id = "12345678-1234-4234-8234-123456789abc";
  const current = { version_id: id, deployment_id: "new" };
  assert.equal(verifyPublishedVersion(old, current, id), true);
  assert.throws(() => verifyPublishedVersion(old, current, "22222222-2222-4222-8222-222222222222"), /does not match/);
  assert.throws(() => verifyPublishedVersion(old, current, ""), /missing or malformed/);
  assert.throws(() => verifyPublishedVersion(old, current, undefined), /missing or malformed/);
  assert.throws(() => verifyPublishedVersion(old, old, old.version_id), /did not change/);
  assert.equal(verifyPublishedVersion({ mode: "bootstrap" }, current, id), true);
  assert.throws(() => verifyPublishedVersion({ mode: "bootstrap" }, current,
    "22222222-2222-4222-8222-222222222222"), /does not match/);
});

test("manual release scope stages the pinned Agent only for Remote Control", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes("      - id: scope\n") && workflow.includes("        run: node scripts/select-affected-apps.mjs"), "manual scope entry exists");
  const selector = new URL("./select-affected-apps.mjs", import.meta.url);
  function runManual(worker, ref = "refs/heads/main") {
    const dir = mkdtempSync(join(tmpdir(), "remote-release-scope-"));
    const output = join(dir, "outputs");
    try {
      execFileSync(process.execPath, [selector.pathname], {
        env: { ...process.env, EVENT_NAME: "workflow_dispatch", MANUAL_WORKER: worker,
          MANUAL_REF: ref, BEFORE_SHA: "", PR_BASE_SHA: "",
          GITHUB_OUTPUT: output, GITHUB_SHA: "not-read-for-manual" },
        encoding: "utf8",
      });
      return readFileSync(output, "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  for (const worker of ["remote-control-mcp-worker", "database-mcp-worker",
    "ima-mcp-worker", "raindrop-mcp-worker", "ssh-mcp-worker", "github-actions-mcp-worker"]) {
    const values = runManual(worker);
    assert.match(values, new RegExp("^apps=" + worker + "$", "m"));
    assert.match(values, new RegExp("^remote_control_changed=" +
      (worker === "remote-control-mcp-worker" ? "true" : "false") + "$", "m"));
    assert.match(values, new RegExp("^database_changed=" +
      (worker === "database-mcp-worker" ? "true" : "false") + "$", "m"));
  }
  assert.throws(() => runManual("missing-worker"), (error) => error.status !== 0);
  assert.throws(() => runManual("remote-control-mcp-worker", "refs/heads/feature"), (error) => error.status !== 0);
});

test("SSH production release requires Broker service, own DO, and least-privileged secret bindings", () => {
  const worker = "ssh-mcp-worker";
  const secrets = [{ name: "MCP_ACCESS_TOKEN" }, { name: "MCP_BROKER_TOKEN" }];
  const settings = {
    bindings: [
      { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
      { name: "MCP_BROKER_TOKEN", type: "secret_text" },
      { name: "EDGE_SSH_BROKER", type: "service", service: "edgessh",
        entrypoint: "HostBrokerEntrypoint" },
      { name: "SSH_OPERATIONS", type: "durable_object_namespace", class_name: "SshOperationsDO" },
    ],
    observability: { enabled: false },
  };
  assert.equal(verifyBindings(worker, settings, secrets), true);
  assert.throws(() => verifyBindings(worker, { ...settings, bindings: settings.bindings.slice(0, 3) },
    secrets), /SSH Durable Object/);
  assert.throws(() => verifyBindings(worker, { ...settings,
    bindings: [...settings.bindings, { name: "ENCRYPTION_KEY", type: "secret_text" }] },
    secrets), /SSH must not copy/);
  assert.throws(() => verifyBindings(worker, { ...settings,
    bindings: settings.bindings.map(x => x.name === "EDGE_SSH_BROKER" ?
      { ...x, service: "wrong" } : x) }, secrets), /SSH Broker/);
  assert.throws(() => verifyBindings(worker, settings, [{ name: "MCP_ACCESS_TOKEN" }]),
    /Secret missing/);
});

test("manual release selects GitHub Environment directly from the allowlisted Worker name", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes("      name: ${{ inputs.worker }}"),
    "selected Worker must resolve the same-named GitHub Environment");
  assert.doesNotMatch(workflow, /WORKER_CONFIG_SCOPE/,
    "no duplicated manually configured Environment name marker");
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/,
    "only manually dispatched workflow can publish");
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/,
    "only main branch may publish");
  assert.match(workflow, /Stage selected Worker Secrets for every release/,
    "every selected Worker must stage required secret values before deploy");
});

test("manual release always syncs selected Worker Secrets from GitHub and never silently falls back", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const secretStart = workflow.indexOf("      - name: Stage selected Worker Secrets for every release");
  const variableStart = workflow.indexOf("      - name: Stage approved Worker variables", secretStart);
  assert.ok(secretStart > 0 && variableStart > secretStart);
  const secretStep = workflow.slice(secretStart, variableStart);
  assert.doesNotMatch(secretStep, /^\s*if:/m, "existing Workers must never skip Secret staging");
  for (const name of ["MCP_ACCESS_TOKEN", "RAINDROP_ACCESS_TOKEN", "API_KEY",
    "DATABASE_CONFIG", "MCP_BROKER_TOKEN", "GH_TOKEN"]) {
    assert.ok(secretStep.includes("secrets." + name), "GitHub must provide " + name);
  }
  assert.equal(secretStep.includes("secrets.CLIENT_ID"), false,
    "CLIENT_ID must not be staged as a Secret");
  const variableStep = workflow.slice(variableStart,
    workflow.indexOf("      - name: Recheck current main inside acquired release lock", variableStart));
  assert.ok(variableStep.includes("vars.CLIENT_ID"),
    "CLIENT_ID must be provided by the GitHub Environment Variable");
  const deployStart = workflow.indexOf("      - name: Publish exactly selected Worker");
  const deployEnd = workflow.indexOf("      - name: Remove temporary deployment configuration", deployStart);
  assert.ok(deployStart > 0 && deployEnd > deployStart);
  const deployStep = workflow.slice(deployStart, deployEnd);
  assert.ok(deployStep.includes('test -s "$RUNNER_TEMP/mcp-worker-secrets.json"'),
    "do not allow publishing when staged Secrets are missing");
  assert.ok(deployStep.includes('deploy_args=(--secrets-file "$RUNNER_TEMP/mcp-worker-secrets.json")'),
    "must upload Secrets alongside every code deployment");
  assert.doesNotMatch(deployStep, /steps\.preflight\.outputs\.bootstrap/,
    "Secret upload must not be limited to bootstrap");
  assert.equal(workflow.includes("mcp-bootstrap-secrets.json"), false);
  assert.ok(workflow.includes('run: rm -f "$RUNNER_TEMP/mcp-worker-secrets.json"'),
    "temporary secret material must always be deleted");
});

test("Wrangler never preserves unmanaged dashboard Variables on any selected Worker", () => {
  for (const worker of ["raindrop-mcp-worker", "ima-mcp-worker", "database-mcp-worker",
    "ssh-mcp-worker", "remote-control-mcp-worker", "github-actions-mcp-worker"]) {
    const file = readFileSync(new URL("../apps/" + worker + "/wrangler.jsonc", import.meta.url), "utf8");
    assert.match(file, /"keep_vars": false/, worker);
  }
});

test("preflight allows GitHub to restore a missing runtime Secret, but readback fails closed", () => {
  const settings = {
    bindings: [{ name: "RAINDROP_ACCESS_TOKEN", type: "secret_text" }],
    observability: { enabled: true, logs: { invocation_logs: true } },
  };
  assert.equal(verifyBindings("raindrop-mcp-worker", settings,
    [{ name: "RAINDROP_ACCESS_TOKEN" }], { mode: "preflight" }), true);
  assert.throws(() => verifyBindings("raindrop-mcp-worker", settings,
    [{ name: "RAINDROP_ACCESS_TOKEN" }], { mode: "readback" }), /Required runtime Secret missing/);
  const filled = { ...settings, bindings: [
    { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
    { name: "RAINDROP_ACCESS_TOKEN", type: "secret_text" },
  ] };
  assert.equal(verifyBindings("raindrop-mcp-worker", filled,
    [{ name: "MCP_ACCESS_TOKEN" }, { name: "RAINDROP_ACCESS_TOKEN" }],
    { mode: "readback" }), true);
});


test("first GitHub Actions Worker release retries only transient 404s without weakening ingress check", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const step = workflow.slice(workflow.indexOf("      - name: Check unauthenticated MCP surface without credentials"));
  assert.match(step, /FIRST_DEPLOY: \$\{\{ steps\.preflight\.outputs\.bootstrap \}\}/);
  assert.match(step, /\[\[ "\$SELECTED_WORKER" == "github-actions-mcp-worker" && "\$FIRST_DEPLOY" == "true" \]\]/);
  assert.match(step, /max_attempts=1/);
  assert.match(step, /max_attempts=12/);
  assert.match(step, /401\|403\)/);
  assert.match(step, /404\)/);
  assert.match(step, /attempt < max_attempts/);
  assert.match(step, /Unexpected unauthenticated MCP status/);
});

test("GitHub Actions deploy requires only one PAT Secret and no repository lists", () => {
  const worker = "github-actions-mcp-worker";
  const secrets = [{ name: "MCP_ACCESS_TOKEN" }, { name: "GH_TOKEN" }];
  const bindings = [
    { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
    { name: "GH_TOKEN", type: "secret_text" },
  ];
  const settings = { bindings, observability: { enabled: true,
    logs: { invocation_logs: true } } };
  assert.equal(verifyBindings(worker, settings, secrets, { mode: "readback" }), true);
  assert.throws(() => verifyBindings(worker, { ...settings,
    bindings: [...bindings, { name: "GITHUB_REPOS", type: "plain_text",
      text: "autoactions/tsrv" }],
  }, secrets, { mode: "readback" }), /Legacy GitHub Actions repository allowlists/);
  assert.throws(() => verifyBindings(worker, settings,
    [{ name: "MCP_ACCESS_TOKEN" }], { mode: "readback" }), /Required runtime Secret missing/);
  const release = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.ok(release.includes("GH_TOKEN: ${{ secrets.GH_TOKEN }}"));
  assert.ok(!release.includes("GH_TOKEN_SECONDARY"));
  assert.throws(() => verifyBindings(worker, { ...settings,
    bindings: [...bindings, { name: "DANGEROUS_RESOURCE", type: "service" }] },
    secrets, { mode: "readback" }), /Unexpected production resource/);
});

test("Workflow production release must preserve exact reviewed resource and runtime boundaries", () => {
  const owner = JSON.parse(readFileSync(new URL("../apps/workflow-mcp-worker/wrangler.jsonc", import.meta.url), "utf8"));
    assert.equal(verifyWorkflowReleaseConfig(owner), true);
  const brokenOwners = [
    [{ ...owner, routes: [{ pattern: "wrong.lirtual.dpdns.org", custom_domain: true }] }, /public route/],
    [{ ...owner, d1_databases: [{ ...owner.d1_databases[0], database_id: "00000000-0000-0000-0000-000000000000" }] }, /production D1/],
    [{ ...owner, services: [{binding:"UNEXPECTED",service:"fake"}] }, /Service Bindings/],
    [{ ...owner, workflows: [] }, /Workflow binding/],
    [{ ...owner, secrets: { required: [] } }, /Portal Secret/],
    [{ ...owner, vars: { MCP_CALL_ENABLED: "true" } }, /MCP/],
    [{ ...owner, compatibility_flags: ["global_fetch_strictly_public"] }, /MCP/],
  ];
  for(const [cfg,err] of brokenOwners)assert.throws(()=>verifyWorkflowReleaseConfig(cfg),err);

});

test("Workflow remote D1 readback blocks missing migrations, nonempty first-run and unresolved Runs", () => {
  const row = { migration_count:2,migration_v1:1,migration_v2:1,
    migration_v3:0,migration_v4:0,attempt_table:0,receipt_table:0,
    native_column:1,active_runs:0,run_count:0,workflow_count:0 };
  const result = (value) => [{success:true,results:[value]}];
  assert.equal(verifyWorkflowD1Readiness(result(row),true),true);
  const migrated = {...row,migration_count:4,migration_v3:1,migration_v4:1,
    attempt_table:1,receipt_table:1};
  assert.equal(verifyWorkflowD1Readiness(result(migrated),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(migrated),false,true),true);
  assert.throws(()=>verifyWorkflowD1Readiness(result(row),false,true),
    /schema migrations/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...migrated,migration_v4:0}),false),
    /schema migrations/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...migrated,receipt_table:0}),false),
    /schema migrations/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...row,migration_count:3,migration_v3:1,
    attempt_table:1}),false),/schema migrations/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...row,migration_count:5}),false),
    /schema migrations/);
  assert.equal(verifyWorkflowD1Readiness(result({...row,run_count:3,workflow_count:1}),false),true);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...row,migration_v2:0}),false),/schema migrations/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...row,active_runs:1}),false),/active or indeterminate/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...row,run_count:1}),true),/empty production/);
  assert.throws(()=>verifyWorkflowD1Readiness([],true),/readback unavailable/);
});

test("Workflow readback verifies one integrated runtime, registered GitHub identity and Portal",()=>{
  const bindings=[
    {name:"MCP_ACCESS_TOKEN",type:"secret_text"},
    {name:"MCP_PORTAL_CLIENT_ID",type:"secret_text"},
    {name:"MCP_PORTAL_CLIENT_SECRET",type:"secret_text"},
    {name:"WORKFLOW_EXECUTOR_GITHUB_TOKEN",type:"secret_text"},
    {name:"DB",type:"d1",id:"c76850db-b5e3-4128-9150-849a1c9e8d74"},
    {name:"WORKFLOW",type:"workflow",workflow_name:"workflow-mcp-runner",class_name:"WorkflowRunner"},
    {name:"MCP_PORTAL_ENDPOINT",type:"plain_text",text:"https://mcp.lirtual.dpdns.org/mcp"},
    {name:"GITHUB_EXECUTOR_REPOSITORY",type:"plain_text",text:"lirtual/mcp-workers"},
    {name:"GITHUB_EXECUTOR_REPOSITORY_ID",type:"plain_text",text:"1414936394"},
    {name:"GITHUB_EXECUTOR_REF",type:"plain_text",text:"refs/heads/main"},
    {name:"GITHUB_EXECUTOR_AUDIENCE",type:"plain_text",text:"workflow-github-claim:production"},
  ];
  const settings={bindings,observability:{enabled:true,logs:{invocation_logs:true}}};
  const secrets=["MCP_ACCESS_TOKEN","MCP_PORTAL_CLIENT_ID","MCP_PORTAL_CLIENT_SECRET",
    "WORKFLOW_EXECUTOR_GITHUB_TOKEN"].map(name=>({name}));
  const check=(list=bindings,ss=secrets)=>
    verifyBindings("workflow-mcp-worker",{...settings,bindings:list},ss,{mode:"readback"});
  assert.equal(check(),true);
  for(const name of ["DB","WORKFLOW"]){
    assert.throws(()=>check(bindings.filter(x=>x.name!==name)),/binding drift/);
  }
  for(const name of ["MCP_PORTAL_CLIENT_ID","MCP_PORTAL_CLIENT_SECRET","WORKFLOW_EXECUTOR_GITHUB_TOKEN"]){
    assert.throws(()=>check(bindings,secrets.filter(x=>x.name!==name)),/binding missing/);
  }
  assert.throws(()=>check([...bindings,{name:"MCP_CALL_ENABLED",type:"plain_text",text:"true"}]),/Obsolete stage flag/);
});


test("Workflow manual GitHub Actions requires D1 checks before Owner", () => {
  const ci=readFileSync(new URL("../.github/workflows/ci.yml",import.meta.url),"utf8");
  const pre=ci.indexOf("      - name: Verify Workflow release configuration and remote D1 readiness");
  const migration=ci.indexOf("      - name: Apply complete Workflow D1 migrations");
  const publish=ci.indexOf("      - name: Publish exactly selected Worker");
  assert.ok(pre>0 && migration>pre && publish>migration);
  assert.match(ci,/wrangler d1 migrations apply workflow-mcp-worker --remote/);
  assert.match(ci,/WORKFLOW_REQUIRE_COMPLETE_SCHEMA: 'true'/);
  assert.ok(ci.includes("WORKFLOW_FIRST_DEPLOY: " + String.fromCharCode(36) + "{{ steps.preflight.outputs.bootstrap }}"));
  assert.match(ci,/node scripts\/manual-worker-release\.mjs d1-check workflow-mcp-worker/);
  assert.match(ci,/\(cd apps\/workflow-mcp-worker &&/);
  assert.match(ci,/mcp_endpoint="https:\/\/workflow\.lirtual\.dpdns\.org\/mcp"/);
  assert.match(ci,/health_endpoint="https:\/\/workflow\.lirtual\.dpdns\.org\/health"/);
  assert.match(ci,/body\.scope !== "workflow"/);
  assert.match(ci,/github\.ref == 'refs\/heads\/main'/);
});

test("Workflow release pins the exact Portal and rejects target drift",()=>{
  const bindings=[
    {name:"MCP_ACCESS_TOKEN",type:"secret_text"},{name:"MCP_PORTAL_CLIENT_ID",type:"secret_text"},
    {name:"MCP_PORTAL_CLIENT_SECRET",type:"secret_text"},{name:"WORKFLOW_EXECUTOR_GITHUB_TOKEN",type:"secret_text"},
    {name:"DB",type:"d1",id:"c76850db-b5e3-4128-9150-849a1c9e8d74"},
    {name:"WORKFLOW",type:"workflow",workflow_name:"workflow-mcp-runner",class_name:"WorkflowRunner"},
    {name:"MCP_PORTAL_ENDPOINT",type:"plain_text",text:"https://mcp.lirtual.dpdns.org/mcp"},
    {name:"GITHUB_EXECUTOR_REPOSITORY",type:"plain_text",text:"lirtual/mcp-workers"},
    {name:"GITHUB_EXECUTOR_REPOSITORY_ID",type:"plain_text",text:"1414936394"},
    {name:"GITHUB_EXECUTOR_REF",type:"plain_text",text:"refs/heads/main"},
    {name:"GITHUB_EXECUTOR_AUDIENCE",type:"plain_text",text:"workflow-github-claim:production"},
  ];
  const settings={observability:{enabled:true,logs:{invocation_logs:true}}};
  const secrets=["MCP_ACCESS_TOKEN","MCP_PORTAL_CLIENT_ID","MCP_PORTAL_CLIENT_SECRET",
    "WORKFLOW_EXECUTOR_GITHUB_TOKEN"].map(name=>({name}));
  const check=(updated)=>verifyBindings("workflow-mcp-worker",{...settings,bindings:updated},secrets,{mode:"readback"});
  assert.equal(check(bindings),true);
  assert.throws(()=>check(bindings.map(x=>x.name==="MCP_PORTAL_ENDPOINT"
    ?{...x,text:"https://test-mcp.lirtual.dpdns.org/mcp"}:x)),/pinned Workflow MCP Portal|Pinned Workflow MCP Portal/);
  assert.throws(()=>check([...bindings,{name:"MCP_DIRECT_TARGETS_ENABLED",type:"plain_text",text:"true"}]),
    /Obsolete stage flag/);
});


test("GitHub execution is integral but still pins repository, ref and OIDC audience",()=>{
  const base=[
    {name:"MCP_ACCESS_TOKEN",type:"secret_text"},
    {name:"DB",type:"d1",id:"c76850db-b5e3-4128-9150-849a1c9e8d74"},
    {name:"WORKFLOW",type:"workflow",workflow_name:"workflow-mcp-runner",class_name:"WorkflowRunner"},
    {name:"MCP_PORTAL_ENDPOINT",type:"plain_text",text:"https://mcp.lirtual.dpdns.org/mcp"},
    {name:"GITHUB_EXECUTOR_REPOSITORY",type:"plain_text",text:"lirtual/mcp-workers"},
    {name:"GITHUB_EXECUTOR_REPOSITORY_ID",type:"plain_text",text:"1414936394"},
    {name:"GITHUB_EXECUTOR_REF",type:"plain_text",text:"refs/heads/main"},
    {name:"GITHUB_EXECUTOR_AUDIENCE",type:"plain_text",text:"workflow-github-claim:production"},
  ];
  const secrets=["MCP_ACCESS_TOKEN","MCP_PORTAL_CLIENT_ID","MCP_PORTAL_CLIENT_SECRET",
    "WORKFLOW_EXECUTOR_GITHUB_TOKEN"].map(name=>({name}));
  const pins=["MCP_PORTAL_CLIENT_ID","MCP_PORTAL_CLIENT_SECRET","WORKFLOW_EXECUTOR_GITHUB_TOKEN"]
    .map(name=>({name,type:"secret_text"}));
  const check=(bindings)=>verifyBindings("workflow-mcp-worker",{
    bindings,observability:{enabled:true,logs:{invocation_logs:true}}},secrets,{mode:"readback"});
  assert.equal(check([...base,...pins]),true);
  for(const name of ["GITHUB_EXECUTOR_REPOSITORY","GITHUB_EXECUTOR_REPOSITORY_ID","GITHUB_EXECUTOR_REF","GITHUB_EXECUTOR_AUDIENCE"]){
    assert.throws(()=>check([...base,...pins].map(x=>x.name===name?{...x,text:"wrong"}:x)),
      /executor identity drift/);
  }
});


test("Workflow preflight tolerates removed service bindings, readback rejects them",()=>{
  const secrets=["MCP_ACCESS_TOKEN","MCP_PORTAL_CLIENT_ID","MCP_PORTAL_CLIENT_SECRET",
    "WORKFLOW_EXECUTOR_GITHUB_TOKEN"].map(name=>({name}));
  const bindings=[
    {name:"MCP_ACCESS_TOKEN",type:"secret_text"},
    {name:"DB",type:"d1",id:"c76850db-b5e3-4128-9150-849a1c9e8d74"},
    {name:"WORKFLOW",type:"workflow",workflow_name:"workflow-mcp-s1",class_name:"WorkflowRunner"},
    {name:"OLD_TEST_SERVICE",type:"service",service:"unused-test-worker"},
    {name:"MCP_CALL_ENABLED",type:"plain_text",text:"true"}
  ];
  const settings={bindings,observability:{enabled:true,logs:{invocation_logs:true}}};
  assert.equal(verifyBindings("workflow-mcp-worker",settings,secrets,{mode:"preflight"}),true);
  assert.throws(()=>verifyBindings("workflow-mcp-worker",settings,secrets,{mode:"readback"}),/Workflow binding drift/);
});
