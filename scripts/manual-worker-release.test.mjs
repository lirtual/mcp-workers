import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptExists, activeVersion, verifyBindings, parseWranglerVersion, verifyPublishedVersion, verifyWorkflowReleaseConfig, verifyWorkflowD1Readiness, verifyWorkflowMigrationReadiness, verifyWorkflowCodeReleaseReadiness, verifyDatabaseCutoverSource, verifyDatabaseHyperdriveSource, WORKFLOW_MIGRATION_READINESS_SQL, retryReleaseReadback, readConfiguration } from "./manual-worker-release.mjs";

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

test("Workflow deployment readback retries only bounded propagation or read-only Cloudflare 5xx", async () => {
  let count = 0;
  const intervals = [];
  const result = await retryReleaseReadback(async () => {
    count++;
    if (count <= 2) throw Error("Required Secret binding missing: MCP_ACCESS_TOKEN");
    return { ready: true };
  }, async ms => {intervals.push(ms);});
  assert.deepEqual(result,{ready:true});
  assert.equal(count,3);
  assert.deepEqual(intervals,[2000,2000]);

  let immediate = 0;
  await assert.rejects(retryReleaseReadback(async () => {
    immediate++;
    throw Error("Workflow Action OIDC audience drift");
  }, async () => {throw Error("must not sleep");}), /OIDC audience drift/);
  assert.equal(immediate,1);

  let versions = 0;
  const expected = "11111111-1111-4111-8111-111111111111";
  const previous = {mode:"update",version_id:"00000000-0000-4000-8000-000000000000",
    deployment_id:"old-deployment"};
  const verified = await retryReleaseReadback(async () => {
    versions++;
    const observed = {version_id:versions < 3 ? previous.version_id : expected,
      deployment_id:versions < 3 ? previous.deployment_id : "new-deployment"};
    verifyPublishedVersion(previous,observed,expected);
    return observed;
  }, async () => {});
  assert.equal(verified.version_id,expected);
  assert.equal(versions,3);

  let max = 0;
  await assert.rejects(retryReleaseReadback(async () => {
    max++;
    throw Error("Required runtime Secret missing: WORKFLOW_MCP_PORTAL_CLIENT_SECRET");
  }, async () => {}), /runtime Secret missing/);
  assert.equal(max,6);

  // Post-deploy Cloudflare returned HTTP 500 for /secrets in protected run
  // #41206153826. No permission exception or production-binding bypass.
  let transient500 = 0;
  const recovered = await retryReleaseReadback(async () => {
    transient500++;
    if (transient500 < 3) throw Error("Cloudflare read-only /secrets HTTP 500");
    return {verified:true};
  }, async () => {});
  assert.deepEqual(recovered,{verified:true});
  assert.equal(transient500,3);

  for (const msg of ["Cloudflare read-only /secrets HTTP 401",
    "Cloudflare read-only /settings HTTP 403",
    "Cloudflare read-only /secrets HTTP 404",
    "Cloudflare read-only /unknown HTTP 503",
    "Workflow Portal Client ID must be exactly one plaintext Variable"]){
    let calls=0;
    await assert.rejects(retryReleaseReadback(async () => {
      calls++;throw Error(msg);
    }, async () => {throw Error("must not pause");}), err=>err.message===msg);
    assert.equal(calls,1,msg);
  }

  let exhausted=0;
  await assert.rejects(retryReleaseReadback(async () => {
    exhausted++;
    throw Error("Cloudflare read-only /script-settings HTTP 503");
  }, async () => {}), /HTTP 503/);
  assert.equal(exhausted,6);
});

test("code-only preflight requires already deployed Secrets, normal bootstrap is unchanged", () => {
  assert.equal(verifyBindings("raindrop-mcp-worker", goodSettings, [], {mode:"preflight"}), true);
  assert.throws(() => verifyBindings("raindrop-mcp-worker", goodSettings, [],
    {mode:"preflight",requireExistingSecrets:true}), /Required runtime Secret missing/);
  assert.equal(verifyBindings("raindrop-mcp-worker", goodSettings, secretList,
    {mode:"preflight",requireExistingSecrets:true}), true);
});

test("Active-version readback requires exactly one 100 percent version", () => {
  const good = { deployments: [{ id: "deployment-one", versions: [{ version_id: "version-one", percentage: 100 }] }] };
  assert.deepEqual(activeVersion(good), { deployment_id: "deployment-one", version_id: "version-one" });
  assert.throws(() => activeVersion({ deployments: [] }), /unambiguous/);
  assert.throws(() => activeVersion({ deployments: [{ id: "mixed", versions: [
    { version_id: "a", percentage: 50 }, { version_id: "b", percentage: 50 },
  ] }] }), /unambiguous/);
});

test("IMA accepts old CLIENT_ID Variable in preflight and requires new Variable after release", () => {
  const worker = "ima-mcp-worker";
  const names = ["MCP_ACCESS_TOKEN", "IMA_API_KEY"];
  const secrets = names.map(name => ({ name }));
  const durable = { name: "IMA_IMAGE_REFRESH_SHARD", type: "durable_object_namespace", class_name: "ImaImageRefreshShard" };
  const observability = { enabled: true, logs: { invocation_logs: true }, traces: { enabled: true } };
  const old = { bindings: [...names.map(name => ({ name, type: "secret_text" })),
    { name: "CLIENT_ID", type: "plain_text", text: "existing-client-id" }, durable], observability };
  assert.equal(verifyBindings(worker, old, secrets, { mode: "preflight" }), true);
  assert.throws(() => verifyBindings(worker, old, secrets, { mode: "readback" }), /IMA legacy CLIENT_ID|IMA_CLIENT_ID.*Variable/);
  const settings = { bindings: [...names.map(name => ({ name, type: "secret_text" })),
    { name: "IMA_CLIENT_ID", type: "plain_text", text: "ima-client-id" }, durable], observability };
  assert.equal(verifyBindings(worker, settings, secrets, { mode: "readback" }), true);
  assert.throws(() => verifyBindings(worker, { ...settings,
    bindings: settings.bindings.filter(x => x.name !== "IMA_CLIENT_ID") }, secrets, { mode: "readback" }), /IMA_CLIENT_ID.*Variable|IMA legacy CLIENT_ID/);
  assert.throws(() => verifyBindings(worker, { ...settings,
    bindings: settings.bindings.map(x => x.name === "IMA_CLIENT_ID" ? { ...x, text: " " } : x) },
    secrets, { mode: "readback" }), /IMA_CLIENT_ID.*Variable|IMA legacy CLIENT_ID/);
  assert.throws(() => verifyBindings(worker, settings,
    [...secrets, { name: "IMA_CLIENT_ID" }], { mode: "readback" }), /legacy IMA_CLIENT_ID Secret|Unexpected runtime Secret/);
  assert.throws(() => verifyBindings(worker, { ...settings, bindings: [
    ...settings.bindings, { name: "CLIENT_ID", type: "plain_text", text: "legacy" },
  ] }, secrets, { mode: "readback" }), /legacy CLIENT_ID/);

  assert.throws(() => verifyBindings(worker, { ...settings, bindings: [
    ...settings.bindings, { name: "R2_BUCKET", type: "r2_bucket" },
  ] }, secrets, { mode: "preflight" }), /Legacy IMA R2/);
  assert.throws(() => verifyBindings(worker, { ...settings, bindings:
    settings.bindings.filter(x => x.name !== "IMA_IMAGE_REFRESH_SHARD") }, secrets), /Durable Object/);
  assert.throws(() => verifyBindings(worker, { ...settings, observability: {
    enabled: true, logs: { invocation_logs: true },
  } }, secrets), /tracing drift/);
});

test("Remote production requires its own DO and rejects Preview namespace reuse", () => {
  const worker = "remote-control-mcp-worker";
  const previewNs = "c086eb6384ad41df9de13765d868324a";
  const productionNs = "abcd1234abcd1234abcd1234abcd1234";
  const sessionRpc={name:"WORKFLOW_SESSION_AUTHORIZATION",type:"service",
    service:"workflow-mcp-worker",entrypoint:"SessionAuthorization"};
  const prod = { bindings: [
    sessionRpc,
    { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
    { name: "REMOTE_CONTROL_INSTALL_ORIGIN", type: "plain_text", text: "https://rca.lirtual.dpdns.org" },
    { name: "DEVICE_COORDINATOR", class_name: "DeviceCoordinator",
      type: "durable_object_namespace", namespace_id: productionNs },
  ], observability: { enabled: true, logs: { invocation_logs: false } } };
  const secrets = [{name:"MCP_ACCESS_TOKEN"}];
  const options = { mode: "readback", previousNamespaceId: previewNs,
    sourceConfig: { routes: [{ pattern: "rca.lirtual.dpdns.org", custom_domain: true }] } };
  const reviewed=readConfiguration(worker,
    readFileSync(new URL('../apps/remote-control-mcp-worker/wrangler.jsonc',import.meta.url),'utf8'));
  assert.deepEqual(reviewed.services,[{
    binding:"WORKFLOW_SESSION_AUTHORIZATION",service:"workflow-mcp-worker",
    entrypoint:"SessionAuthorization"}]);
  for(const sourceBindings of [[],[{...reviewed.services[0],service:"untrusted-worker"}],
    [{...reviewed.services[0],entrypoint:"OtherEntrypoint"}],
    [...reviewed.services,reviewed.services[0]]])
    assert.throws(()=>readConfiguration(worker,JSON.stringify({...reviewed,
      services:sourceBindings})),/Session Service Binding/);
  assert.equal(verifyBindings(worker, prod, secrets, options), true);
  assert.equal(verifyBindings(worker,{...prod,bindings:prod.bindings.filter(
    b=>b.name!==sessionRpc.name)},secrets,{mode:"preflight"}),true);
  assert.throws(()=>verifyBindings(worker,{...prod,bindings:prod.bindings.filter(
    b=>b.name!==sessionRpc.name)},secrets,options),/Session Authorization Service Binding|Duplicate runtime binding/);
  for(const wrong of [{...sessionRpc,service:"untrusted-worker"},
    {...sessionRpc,entrypoint:"OtherEntrypoint"},
    {...sessionRpc,type:"plain_text"}])
    assert.throws(()=>verifyBindings(worker,{...prod,bindings:prod.bindings.map(
      b=>b.name===sessionRpc.name?wrong:b)},secrets,options),
      /Session Authorization Service Binding|Duplicate runtime binding/);
  assert.throws(()=>verifyBindings(worker,{...prod,
    bindings:[...prod.bindings,sessionRpc]},secrets,options),
    /Session Authorization Service Binding|Duplicate runtime binding/);
  assert.throws(() => verifyBindings(worker, prod, [], options), /Secret missing/);
  for (const name of ["BROWSER_APPROVAL_ACCESS_ISSUER",
    "BROWSER_APPROVAL_ACCESS_AUD","BROWSER_APPROVAL_ALLOWED_EMAIL",
    "BROWSER_APPROVAL_PUBLIC_ORIGIN"]) {
    assert.throws(() => verifyBindings(worker, { ...prod, bindings: [...prod.bindings,
      { name, type: name === "BROWSER_APPROVAL_PUBLIC_ORIGIN" ? "plain_text" : "secret_text" }] },
      secrets, options), /Retired Remote Control approval bindings|Unexpected runtime Secret/);
  }
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
    ...["BROWSER_APPROVAL_ACCESS_ISSUER","BROWSER_APPROVAL_ACCESS_AUD","BROWSER_APPROVAL_ALLOWED_EMAIL"].map(name=>({name,type:"secret_text"})),
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

test("Wrangler Prepare failure diagnostic reports only stage and error code", () => {
  const dir = mkdtempSync(join(tmpdir(), "spec733-safe-diagnostic-"));
  const log = join(dir, "wrangler.log");
  try {
    writeFileSync(log, "Secret=confidential-sample\nCloudflare error code: 10000\n");
    const result = spawnSync(process.execPath,
      ["scripts/manual-worker-release.mjs", "diagnostic", log, "prepare"],
      { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /Wrangler diagnostic: stage=prepare; code=10000/);
    assert.doesNotMatch(result.stderr, /confidential-sample|Secret=/);
    assert.equal(result.stdout, "");
    const legacy = spawnSync(process.execPath,
      ["scripts/manual-worker-release.mjs", "diagnostic", log],
      { encoding: "utf8" });
    assert.equal(legacy.status, 0);
    assert.match(legacy.stderr, /stage=deploy; code=10000/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Wrangler output requires a parseable release id, not upload-only success", () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  assert.equal(parseWranglerVersion("Current Version ID: " + id), id);
  assert.throws(() => parseWranglerVersion("Uploaded script"), /release Version ID/);
});

test("Wrangler 4.151 versioned bulk Secret cleanup parses exactly one candidate UUID", () => {
  const id = 'c28c0af8-e773-4400-9106-425779932fcf';
  const other = '6e6bdc39-dce9-4549-be78-c853c98e6853';
  assert.equal(parseWranglerVersion('✨ Success! Created version ' + id +
    ' with 0 secrets created and 3 secrets deleted.\n' +
    '➡️ To deploy this version use wrangler versions deploy.'), id);
  assert.equal(parseWranglerVersion('Current Version ID: '+id+'\n' +
    '✨ Success! Created version '+id+' with 0 secrets created and 3 secrets deleted.'), id);
  for (const invalid of [
    'Uploaded script '+id, 'Created version '+id,
    'Success! Created version '+id, 'Success! Created version abc with 0 secrets created',
    'Current Version ID: '+id+'\nSuccess! Created version '+other+' with 0 secrets created',
  ]) assert.throws(() => parseWranglerVersion(invalid), /unique release Version ID/);
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

test("SSH release requires EdgeSSH D1, own DO and scoped key", () => {
  const worker = "ssh-mcp-worker";
  const source = JSON.parse(readFileSync(new URL("../apps/ssh-mcp-worker/wrangler.jsonc", import.meta.url), "utf8"));
  assert.deepEqual(source.secrets?.required, ["MCP_ACCESS_TOKEN", "SSH_ENCRYPTION_KEY"]);
  const secrets = [{ name: "MCP_ACCESS_TOKEN" }, { name: "SSH_ENCRYPTION_KEY" }];
  const bindings = [
    { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
    { name: "SSH_ENCRYPTION_KEY", type: "secret_text" },
    { name: "EDGE_SSH_DB", type: "d1", id: "bd5cfdc5-3db0-4af7-8e95-cbf3d65cfa94" },
    { name: "SSH_OPERATIONS", type: "durable_object_namespace", class_name: "SshOperationsDO" },
  ];
  const settings = { bindings, observability: { enabled: true, logs: { invocation_logs: true } } };
  assert.equal(verifyBindings(worker, settings, secrets), true);
  assert.throws(() => verifyBindings(worker, {
    ...settings, bindings: bindings.filter(b => b.name !== "SSH_OPERATIONS"),
  }, secrets), /SSH Durable Object/);
  assert.throws(() => verifyBindings(worker, {
    ...settings, bindings: bindings.filter(b => b.name !== "EDGE_SSH_DB"),
  }, secrets), /D1 binding/);
  assert.throws(() => verifyBindings(worker, {
    ...settings, bindings: [...bindings, { name: "EDGE_SSH_BROKER", type: "service" }],
  }, secrets), /legacy broker/);
  assert.throws(() => verifyBindings(worker, settings, secrets.slice(0, 1)), /Secret missing/);
});

test("Workflow code-only release never stages secrets or runs migrations, preserves variables and rejects drift", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_code_only:\n\s*description:.*no D1 migrations or secret upload/);
  assert.match(workflow, /WORKFLOW_CODE_ONLY: \$\{\{ inputs.workflow_code_only \}\}/);
  const releaseScript = readFileSync(new URL("./manual-worker-release.mjs", import.meta.url), "utf8");
  assert.match(releaseScript, /requireExistingSecrets: mode === "preflight"/,
    "existing Secret names checked in read-only preflight");
  assert.match(releaseScript, /Code-only release requires an existing Workflow Worker/);
  assert.match(workflow, /if: inputs.worker == 'workflow-mcp-worker' && inputs.workflow_code_only == true/);
  assert.match(workflow, /WORKFLOW_REQUIRE_COMPLETE_SCHEMA: \$\{\{ inputs.workflow_code_only && 'true' \|\| '' \}\}/);
  assert.match(workflow, /if: inputs.worker == 'workflow-mcp-worker' && inputs.workflow_code_only != true/);
  const deployment = workflow.slice(workflow.indexOf('      - name: Publish exactly selected Worker'));
  assert.match(deployment, /\[\[ ! -e "\$RUNNER_TEMP\/mcp-worker-secrets.json" \]\]/);
  assert.match(deployment, /deploy_args=\(--keep-vars\)/);
  assert.match(deployment, /deploy_args=\(--secrets-file "\$RUNNER_TEMP\/mcp-worker-secrets.json"\)/);
  assert.match(deployment, /if \[\[ "\$WORKFLOW_CODE_ONLY" == "true" \]\]/);
  assert.match(workflow, /ACTIONS_OLD_INGRESS_QUIESCED.*!= "true"/);
  for (const job of ["workflow-actions-migration-prepare","workflow-actions-gate-reopen"]) {
    const block = workflow.slice(workflow.indexOf("  "+job+":"));
    assert.match(block.slice(0,550), /inputs.workflow_code_only != true/,
      "code-only selection must not enter maintenance job "+job);
  }
  assert.match(workflow, /Require complete Workflow code-only migration inventory/);
});

test("manual release retains Owner/main and selected-Worker deployment gates without an Environment", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /^ {4}environment:/gm);
  assert.doesNotMatch(workflow, /WORKER_CONFIG_SCOPE/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /Stage selected Worker Secrets for every release/);
});

test("Repository-scoped jobs never bind an Environment and staging limits app Secrets to the selected Worker", () => {
  for (const name of ["release", "acceptance", "agent-release", "spec775-business-acceptance"]) {
    const source = readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /^ {4}environment:/gm, `${name} must not bind a GitHub Environment`);
  }
  const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const secretStep = release.split("      - name: Stage selected Worker Secrets for every release")[1]
    ?.split("      - name: Stage approved Worker variables")[0];
  assert.ok(secretStep);
  for (const [name,worker] of [
    ["RAINDROP_ACCESS_TOKEN","raindrop-mcp-worker"],
    ["IMA_API_KEY","ima-mcp-worker"],
    ["ACTIONS_GITHUB_DISPATCH_TOKENS","github-actions-mcp-worker"],
    ["WORKFLOW_GITHUB_DISPATCH_TOKEN","workflow-mcp-worker"],
  ]) {
    const expression = `          ${name}: ` + '$' +
      `{{ inputs.worker == '${worker}' && secrets.${name} || '' }}`;
    assert.ok(secretStep.includes(expression), `${name} must be nonblank only for ${worker}`);
    assert.equal(secretStep.split(`          ${name}:`).length - 1, 1,
      `${name} must have exactly one staging source`);
  }
});

test("manual release always syncs selected Worker Secrets from GitHub and never silently falls back", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const secretStart = workflow.indexOf("      - name: Stage selected Worker Secrets for every release");
  const variableStart = workflow.indexOf("      - name: Stage approved Worker variables", secretStart);
  assert.ok(secretStart > 0 && variableStart > secretStart);
  const secretStep = workflow.slice(secretStart, variableStart);
  assert.match(secretStep, /if: inputs.worker != 'workflow-mcp-worker' \|\| inputs.workflow_code_only != true/,
    "only explicitly selected Workflow code-only release may omit Secret staging");
  for (const name of ["MCP_ACCESS_TOKEN", "RAINDROP_ACCESS_TOKEN", "IMA_API_KEY",
    "DATABASE_B2B_PASSWORD", "DATABASE_SCRAPE_RELAY_PASSWORD", "ACTIONS_GITHUB_DISPATCH_TOKENS"]) {
    assert.ok(secretStep.includes("secrets." + name), "GitHub must provide " + name);
  }
  assert.ok(secretStep.includes("SSH_ENCRYPTION_KEY: ${{ inputs.worker == 'ssh-mcp-worker' && secrets.SSH_ENCRYPTION_KEY || '' }}"),
    "SSH Repository Secret source and runtime binding must use the same canonical name");
  assert.ok(secretStep.includes("WORKFLOW_MCP_PORTAL_CLIENT_SECRET: ${{ inputs.worker == 'workflow-mcp-worker' && secrets.WORKFLOW_MCP_PORTAL_CLIENT_SECRET || '' }}"),
    "Workflow Portal Secret source and runtime binding must use the same canonical name");
  assert.ok(!secretStep.includes("WORKFLOW_SESSION_RUNTIME_DATA_KEY:") &&
    !secretStep.includes("secrets.SESSION_RUNTIME_DATA_KEY"),
    "retired UU GitHub source must not be restored during normal Worker releases");
  assert.equal(secretStep.includes('DATABASE_KEY_ID'),false,'retired D1 key is not staged');
  assert.equal(secretStep.includes("secrets.DATABASE_CONFIG"), false,
    "releases must never restage the retired whole-catalog Secret");
  assert.equal(secretStep.includes("secrets.IMA_CLIENT_ID"), false,
    "IMA_CLIENT_ID must not be staged as a Secret");
  const variableStep = workflow.slice(variableStart,
    workflow.indexOf("      - name: Recheck current main inside acquired release lock", variableStart));
  assert.ok(variableStep.includes("vars.IMA_CLIENT_ID"),
    "IMA_CLIENT_ID must be provided by the GitHub Repository Variable");
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
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
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
  const secrets = [{ name: "MCP_ACCESS_TOKEN" }, { name: "ACTIONS_GITHUB_DISPATCH_TOKENS" }];
  const bindings = [
    { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
    { name: "ACTIONS_GITHUB_DISPATCH_TOKENS", type: "secret_text" },
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
  const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.ok(release.includes("ACTIONS_GITHUB_DISPATCH_TOKENS: ${{ inputs.worker == 'github-actions-mcp-worker' && secrets.ACTIONS_GITHUB_DISPATCH_TOKENS || '' }}"));
  assert.ok(!release.includes("GH_TOKEN: ${{ secrets.GH_TOKEN }}"));
  assert.ok(!release.includes("ACTIONS_MCP_TOKENS: ${{ secrets.ACTIONS_MCP_TOKENS }}"));
  assert.ok(!release.includes("MCP_BROKER_TOKEN: ${{ secrets.MCP_BROKER_TOKEN }}"));
  assert.ok(!release.includes("GH_TOKEN_SECONDARY"));
  assert.throws(() => verifyBindings(worker, { ...settings,
    bindings: [...bindings, { name: "DANGEROUS_RESOURCE", type: "service" }] },
    secrets, { mode: "readback" }), /Unexpected production resource/);
});

test("Workflow production smoke SQL uses the currently reviewed D1 binding", () => {
  const source=JSON.parse(readFileSync(new URL("../apps/workflow-mcp-worker/wrangler.jsonc",import.meta.url),"utf8"));
  const smoke=readFileSync(new URL("../apps/workflow-mcp-worker/tests/production-smoke.mjs",import.meta.url),"utf8");
  const target=source.d1_databases?.[0]?.database_name;
  assert.equal(target,"workflow-mcp-db");
  assert.ok(smoke.includes("'"+target+"', '--remote', '--json', '--command', statement"));
  assert.ok(!smoke.includes("'workflow-mcp-worker', '--remote', '--json', '--command', statement"));
});

test("Workflow production release must preserve exact reviewed resource and runtime boundaries", () => {
  const owner = JSON.parse(readFileSync(new URL("../apps/workflow-mcp-worker/wrangler.jsonc", import.meta.url), "utf8"));
    assert.equal(verifyWorkflowReleaseConfig(owner), true);
  const brokenOwners = [
    [{ ...owner, routes: [{ pattern: "wrong.lirtual.dpdns.org", custom_domain: true }] }, /public route/],
    [{ ...owner, d1_databases: [{ ...owner.d1_databases[0], database_id: "00000000-0000-0000-0000-000000000000" }] }, /production D1/],
    [{ ...owner, services: [] }, /Service Binding/],
    [{ ...owner, services: [{binding:"UNEXPECTED",service:"fake"}] }, /Service Binding/],
    [{ ...owner, services: [{...owner.services[0],entrypoint:"UnreviewedEntrypoint"}] }, /Service Binding/],
    [{ ...owner, services: [...owner.services,{...owner.services[0],binding:"SECOND"}] }, /Service Binding/],
    [{ ...owner, workflows: [] }, /Workflow binding/],
    [{ ...owner, secrets: { required: [] } }, /Secret/],
    [{ ...owner, vars: { MCP_CALL_ENABLED: "true" } }, /MCP/],
    [{ ...owner, compatibility_flags: ["global_fetch_strictly_public"] }, /MCP/],
  ];
  for(const [cfg,err] of brokenOwners)assert.throws(()=>verifyWorkflowReleaseConfig(cfg),err);

});

test("Workflow remote D1 checks the exact old, intermediate and full schema", () => {
  const result = row => [{success:true,results:[row]}];
  const baseline = {
    migration_count:5,migration_v1:1,migration_v2:1,migration_v3:1,
    migration_v4:1,migration_v5:1,migration_v6:0,migration_v7:0,migration_v8:0,migration_v9:0,migration_v10:0,migration_v11:0,migration_v12:0,migration_v14:0,migration_v15:0,migration_v16:0,migration_v17:0,migration_v18:0,migration_v19:0,migration_v20:0,resolved_sha_column:0,rca_duration_column:0,portal_auth_table:0,mcp_fence_table:0,http_auth_table:0,cloudflare_gate_table:0,deleted_column:0,event_receipts_table:0,runtime_table:0,approval_gates_table:0,approvals_table:0,
    capacity_column:0,parent_column:0,parent_step_column:0,child_index:0,child_cancel_table:0,
    child_terminate_fence_column:0,capacity_guard_trigger:0,
    locator_column:0,fixed_column:0,fixed_index:0,
    attempt_table:1,receipt_table:1,native_column:1,
    session_table:0,cancellation_table:0,
    active_runs:0,active_sessions:0,run_count:0,workflow_count:0,
  };
  const partial = {...baseline,migration_count:6,migration_v6:1};
  const current = {...partial,migration_count:7,migration_v7:1,
    session_table:1,cancellation_table:1};
  const completed = {...current,migration_count:8,migration_v8:1,locator_column:1};
  const oldComplete = {...completed,migration_count:9,migration_v9:1,fixed_column:1,fixed_index:1};
  const upgraded = {...oldComplete,migration_count:10,migration_v10:1,runtime_table:1};
  const previousComplete = {...upgraded,migration_count:11,migration_v11:1,
    capacity_column:1,parent_column:1,parent_step_column:1,child_index:1,child_cancel_table:1,
    child_terminate_fence_column:1,capacity_guard_trigger:1};
  const latest = {...previousComplete,migration_count:12,migration_v12:1,event_receipts_table:1};
  const cloudflareComplete = {...latest,migration_count:13,migration_v13:1,
    invocations_table:1,cloudflare_cancel_table:1};
  const deletedComplete = {...cloudflareComplete,migration_count:14,migration_v14:1,deleted_column:1};
  const approvalComplete={...deletedComplete,migration_count:15,migration_v15:1,approval_gates_table:1,approvals_table:1};
  assert.equal(verifyWorkflowD1Readiness(result(baseline),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(partial),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(current),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(completed),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(oldComplete),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(upgraded),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(previousComplete),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(latest),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(cloudflareComplete),false),true);
  assert.equal(verifyWorkflowD1Readiness(result(deletedComplete),false),true);
  const portalComplete={...approvalComplete,migration_count:16,migration_v16:1,portal_auth_table:1,mcp_fence_table:1};
  assert.equal(verifyWorkflowD1Readiness(result(approvalComplete),false),true);
  const httpComplete={...portalComplete,migration_count:17,migration_v17:1,http_auth_table:1};
  assert.equal(verifyWorkflowD1Readiness(result(portalComplete),false),true);
  assert.throws(()=>verifyWorkflowD1Readiness(result(portalComplete),false,true),/schema migrations/);
  const actionsComplete={...httpComplete,migration_count:18,migration_v18:1,cloudflare_gate_table:1};
  assert.equal(verifyWorkflowD1Readiness(result(httpComplete),false),true);
  const sessionComplete={...actionsComplete,migration_count:19,migration_v19:1,rca_duration_column:1};
  assert.equal(verifyWorkflowD1Readiness(result(actionsComplete),false),true);
  assert.throws(()=>verifyWorkflowD1Readiness(result(actionsComplete),false,true),/schema migrations/);
  assert.equal(verifyWorkflowD1Readiness(result(sessionComplete),false),true);
  assert.throws(()=>verifyWorkflowD1Readiness(result(sessionComplete),false,true),/schema migrations/);
  const mainComplete={...sessionComplete,migration_count:20,migration_v20:1,resolved_sha_column:1};
  assert.equal(verifyWorkflowD1Readiness(result(mainComplete),false,true),true);
  const uuRetired={...mainComplete,migration_count:21,migration_v21:1,runtime_table:0};
  assert.equal(verifyWorkflowD1Readiness(result(uuRetired),false,true,true),true);
  assert.throws(()=>verifyWorkflowD1Readiness(result(mainComplete),false,true,true),
    /UU retirement post-migration/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...uuRetired,runtime_table:1}),false,true,true),
    /UU retirement/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...uuRetired,migration_v21:0}),false,true,true),
    /UU retirement/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...uuRetired,active_sessions:1}),false,true,true),
    /active physical Sessions/);
  // v21 is already fully applied. Code-only releases may keep a healthy Ready
  // Session; the separate code-release-check still rejects unresolved activity.
  assert.throws(()=>verifyWorkflowD1Readiness(
    result({...uuRetired,active_sessions:1}),false,true),/active physical Sessions/);
  assert.equal(verifyWorkflowD1Readiness(
    result({...uuRetired,active_sessions:1}),false,true,false,true),true);
  assert.throws(()=>verifyWorkflowD1Readiness(
    result({...uuRetired,active_sessions:1,active_runs:1}),false,true,false,true),
    /active or indeterminate/);
  assert.throws(()=>verifyWorkflowD1Readiness(
    result({...uuRetired,active_sessions:1,rca_duration_column:0}),false,true,false,true),
    /UU retirement migration\/schema drift/);
  assert.throws(()=>verifyWorkflowD1Readiness(
    result({...uuRetired,active_sessions:1}),false,true,true,true),
    /active physical Sessions/);
  assert.throws(()=>verifyWorkflowD1Readiness(
    result({...mainComplete,active_sessions:1,migration_count:19}),false,true,false,true),
    /schema migrations/);
  assert.throws(()=>verifyWorkflowD1Readiness(
    result({...uuRetired,active_sessions:1,migration_count:19}),false,true,false,true),
    /UU retirement migration\/schema drift/);

  for(const broken of [{migration_v16:0},{portal_auth_table:0},{mcp_fence_table:0},
    {migration_v17:0},{http_auth_table:0},{migration_v18:0},{cloudflare_gate_table:0},
    {migration_v19:0},{rca_duration_column:0},{migration_v20:0},
    {resolved_sha_column:0},{migration_count:19},{migration_count:18},{migration_count:17}])
    assert.throws(()=>verifyWorkflowD1Readiness(result({...mainComplete,...broken}),false,true),/schema migrations/);
  assert.throws(()=>verifyWorkflowD1Readiness(result(deletedComplete),false,true),/schema migrations/);
  assert.throws(()=>verifyWorkflowD1Readiness(result(cloudflareComplete),false,true),/schema migrations/);
  assert.throws(()=>verifyWorkflowD1Readiness(result(latest),false,true),/schema migrations/);
  for(const row of [
    {...cloudflareComplete,migration_count:12},
    {...cloudflareComplete,migration_v13:0},
    {...cloudflareComplete,invocations_table:0},
    {...cloudflareComplete,cloudflare_cancel_table:0},
    {...deletedComplete,migration_count:13},
    {...deletedComplete,migration_v14:0},
    {...deletedComplete,deleted_column:0},
    {...approvalComplete,migration_v15:0},
    {...approvalComplete,approval_gates_table:0},
    {...approvalComplete,approvals_table:0},
  ]) assert.throws(()=>verifyWorkflowD1Readiness(result(row),false,true),/schema migrations/);
  assert.throws(()=>verifyWorkflowD1Readiness(result(previousComplete),false,true),/schema migrations/);
  for(const row of [baseline,partial,current,completed,oldComplete,upgraded]){
    assert.throws(()=>verifyWorkflowD1Readiness(result(row),false,true),
      /schema migrations/);
  }
  for(const row of [
    {...baseline,migration_count:4,migration_v5:0},
    {...baseline,migration_count:6},
    {...partial,migration_v6:0},
    {...completed,migration_v4:0},
    {...completed,migration_v7:0},
    {...current,migration_count:8},
    {...completed,migration_v8:0},
    {...completed,locator_column:0},
    {...completed,session_table:0},
    {...completed,cancellation_table:0},
    {...completed,receipt_table:0},
    {...completed,migration_count:9},
    {...completed,migration_v9:1},
    {...oldComplete,migration_count:10},
    {...upgraded,migration_v10:0},
    {...upgraded,runtime_table:0},
    {...upgraded,migration_v11:1},
    {...latest,migration_count:10},
    {...latest,migration_count:11},
    {...latest,migration_v11:0},
    {...latest,migration_v12:0},
    {...latest,event_receipts_table:0},
    {...previousComplete,migration_v12:1},
    {...previousComplete,event_receipts_table:1},
    {...latest,capacity_column:0},
    {...latest,parent_column:0},
    {...latest,parent_step_column:0},
    {...latest,child_index:0},
    {...latest,child_cancel_table:0},
    {...latest,child_terminate_fence_column:0},
    {...latest,capacity_guard_trigger:0},
    {...upgraded,fixed_index:0},
    {...upgraded,fixed_column:0},
    {...completed,native_column:0},
  ]){
    assert.throws(()=>verifyWorkflowD1Readiness(result(row),false),
      /schema migrations/);
  }
  assert.equal(verifyWorkflowD1Readiness(result({...mainComplete,run_count:3,
    workflow_count:1}),false,true),true);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...upgraded,active_runs:1}),false),
    /active or indeterminate/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...oldComplete,active_sessions:1}),false),
    /active physical Sessions/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...completed,active_sessions:1}),false),
    /active physical Sessions/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...upgraded,active_sessions:1}),false),/active physical Sessions/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...approvalComplete,active_sessions:1}),false,true),/schema migrations/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...portalComplete,active_sessions:1}),false),/active physical Sessions/);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...actionsComplete,active_sessions:1}),false),/active physical Sessions/);
  assert.equal(verifyWorkflowD1Readiness(result({...mainComplete,active_sessions:1}),false,true),true);
  assert.throws(()=>verifyWorkflowD1Readiness(result({...upgraded,run_count:1}),true),
    /empty production/);
  assert.throws(()=>verifyWorkflowD1Readiness([],true),/readback unavailable/);
});
test("Workflow migration preflight requires all independent physical states settled", () => {
  const ready = {
    migration_count: 12, expected_migrations: 12,
    workflow_count: 7, run_count: 58, session_count: 49,
    attempt_count: 31, callback_count: 4, cancellation_count: 31,
    nonterminal_runs: 0, unresolved_starts: 0, unresolved_steps: 0, invalid_cancelled_steps: 0,
    nonterminal_attempts: 0, nonterminated_sessions: 0, undelivered_callbacks: 0,
  };
  const response = row => [{success: true, results: [row]}];
  for (const count of [18,19,20,21]) assert.deepEqual(
    verifyWorkflowMigrationReadiness(response({...ready,migration_count:count,expected_migrations:count})),
    {workflows:7,runs:58,sessions:49,attempts:31,callbacks:4,cancellations:31});
  for (const wrong of [
    {migration_count:22,expected_migrations:22},
    {migration_count:19,expected_migrations:18},
  ]) assert.throws(()=>verifyWorkflowMigrationReadiness(response({...ready,...wrong})),/exact reviewed/);
  assert.deepEqual(verifyWorkflowMigrationReadiness(response(ready)), {
    workflows: 7, runs: 58, sessions: 49, attempts: 31, callbacks: 4,
    cancellations: 31,
  });
  for (const name of [
    "nonterminal_runs","unresolved_starts","unresolved_steps","invalid_cancelled_steps",
    "nonterminal_attempts","nonterminated_sessions","undelivered_callbacks",
  ]) {
    assert.throws(() => verifyWorkflowMigrationReadiness(
      response({...ready,[name]:1})), new RegExp(name));
    assert.throws(() => verifyWorkflowMigrationReadiness(
      response({...ready,[name]:-1})), /count unavailable or invalid/);
  }
  for (const key of Object.keys(ready)) {
    const broken = {...ready};
    delete broken[key];
    assert.throws(() => verifyWorkflowMigrationReadiness(
      response(broken)), /count unavailable or invalid/);
  }
  for (const invalid of [[],[{}],[{success:false,results:[ready]}],
    [{success:true,results:[ready,ready]}]]) {
    assert.throws(() => verifyWorkflowMigrationReadiness(invalid),
      /readback unavailable/);
  }
  for (const wrong of [{migration_count:9},{migration_count:11},
    {expected_migrations:11}]) {
    assert.throws(() => verifyWorkflowMigrationReadiness(
      response({...ready,...wrong})), /exact reviewed/);
  }
  for (const invalid of [null,NaN,1.5,"0",true]) {
    assert.throws(() => verifyWorkflowMigrationReadiness(
      response({...ready,undelivered_callbacks:invalid})),
      /count unavailable or invalid/);
  }
  for (const requiredTable of [
    "runs","run_steps","step_attempts","session_executions",
    "callback_receipts","github_action_cancellations","d1_migrations",
  ]) assert.ok(WORKFLOW_MIGRATION_READINESS_SQL.includes(requiredTable));
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/state != 'terminated'/);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/notification_delivered != 1/);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/0012_event_wait_receipts.sql/);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/0013_cloudflare_action_invocations.sql/);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/0014_workflow_deletion.sql/);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/0016_portal_connection_revocation.sql/);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/0017_http_connection_auth.sql/);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/0019_session_rca_duration.sql/);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/0020_github_action_main_sha.sql/);
  const release=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  assert.equal((release.match(/AS migration_v17/g)??[]).length,2);
  assert.equal((release.match(/AS http_auth_table/g)??[]).length,2);
  assert.equal((release.match(/AS migration_v19/g)??[]).length,2);
  assert.equal((release.match(/AS migration_v20/g)??[]).length,2);
  assert.equal((release.match(/AS migration_v21/g)??[]).length,2);
  assert.equal((release.match(/AS resolved_sha_column/g)??[]).length,2);
  assert.match(release,/migrations\[@\].*eq 21/);
  assert.equal((release.match(/AS rca_duration_column/g)??[]).length,2);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/invalid_cancelled_steps/);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/reviewed_terminal_artifact_attempts/);
  assert.match(WORKFLOW_MIGRATION_READINESS_SQL,/0 AS reviewed_terminal_artifact_attempts/);

});

test("Task-only production acceptance reuses confirmed Ready Session gate and scoped cleanup",()=>{
  const source=readFileSync(new URL("../apps/workflow-mcp-worker/tests/production-smoke.mjs",import.meta.url),"utf8");
  const fn=source.slice(source.indexOf("async function runActionTaskSmoke()"),
    source.indexOf("async function runWebhookSmoke()"));
  assert.match(fn,/verifyWorkflowCodeReleaseReadiness\(\[\{/);
  assert.match(fn,/sql\(WORKFLOW_MIGRATION_READINESS_SQL\)/);
  assert.doesNotMatch(fn,/session_executions WHERE state != 'terminated'/);
  assert.match(source,/DELETE FROM step_attempts WHERE run_id IN \(SELECT id FROM runs WHERE workflow_id = /);
  assert.match(source,/DELETE FROM mcp_dispatch_fences WHERE run_id IN \(SELECT id FROM runs WHERE workflow_id = /);
  assert.match(source,/Refusing GitHub cleanup until physical GitHub Job is completed/);
});

test('cancelled Workflow Steps count as terminal only with matched cancelled Run receipt',()=>{
  const start=WORKFLOW_MIGRATION_READINESS_SQL.indexOf('(SELECT count(*) FROM run_steps s JOIN runs r');
  const end=WORKFLOW_MIGRATION_READINESS_SQL.indexOf(' AS invalid_cancelled_steps',start);
  assert.ok(start>=0&&end>start);
  const query='SELECT '+WORKFLOW_MIGRATION_READINESS_SQL.slice(start,end+ ' AS invalid_cancelled_steps'.length);
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY,outcome TEXT,error_code TEXT);');
    db.exec('CREATE TABLE run_steps(run_id TEXT,status TEXT,error_code TEXT);');
    db.prepare('INSERT INTO runs VALUES(?,?,?)').run('r','cancelled','approval_cancel_requested');
    db.prepare('INSERT INTO run_steps VALUES(?,?,?)').run('r','cancelled','approval_cancel_requested');
    const count=()=>db.prepare(query).get()?.invalid_cancelled_steps;
    assert.equal(count(),0);
    db.exec("UPDATE runs SET outcome='running'");assert.equal(count(),1);
    db.exec("UPDATE runs SET outcome='cancelled',error_code=NULL");assert.equal(count(),1);
    db.exec("UPDATE runs SET error_code='approval_cancel_requested';UPDATE run_steps SET error_code=NULL");assert.equal(count(),1);
    db.exec("UPDATE run_steps SET error_code='approval_cancel_requested'");assert.equal(count(),0);
    // Event Wait cancellation is a separate supported, durable Run/Step pair.
    db.exec("UPDATE runs SET error_code='event_wait_cancel_requested';UPDATE run_steps SET error_code='event_wait_cancel_requested'");
    assert.equal(count(),0);
    db.exec("UPDATE run_steps SET error_code='approval_cancel_requested'");assert.equal(count(),1);
    db.exec("UPDATE run_steps SET error_code='event_wait_cancel_requested';UPDATE runs SET error_code='unknown_cancel_requested'");
    assert.equal(count(),1);
    db.exec("UPDATE runs SET error_code='event_wait_cancel_requested';UPDATE run_steps SET error_code=NULL");
    assert.equal(count(),1);
    db.exec("UPDATE run_steps SET error_code='event_wait_cancel_requested';UPDATE runs SET error_code=NULL");
    assert.equal(count(),1);
    db.exec("UPDATE runs SET error_code='event_wait_cancel_requested'");assert.equal(count(),0);
  }finally{db.close();}
});

test("code-only release admits only confirmed Ready Sessions, not migrations",()=>{
  const row={
    migration_count:20,expected_migrations:20,resolved_sha_column:1,
    nonterminal_runs:0,unresolved_starts:0,unresolved_steps:0,invalid_cancelled_steps:0,
    nonterminal_attempts:1,nonterminated_sessions:1,
    undelivered_callbacks:0,confirmed_ready_sessions:1,reviewed_terminal_artifact_attempts:0,verified_terminal_saga_receipts:0,
  };
  const make=value=>[{success:true,results:[value]}];
  assert.deepEqual(verifyWorkflowCodeReleaseReadiness(make(row)),
    {confirmed_ready_sessions:1});
  assert.throws(()=>verifyWorkflowMigrationReadiness(make({
    ...row,workflow_count:5,run_count:53,session_count:1,
    attempt_count:10,callback_count:1,cancellation_count:0,
  })),/nonterminal_attempts/);
  assert.deepEqual(verifyWorkflowCodeReleaseReadiness(make({
    ...row,nonterminal_attempts:0,nonterminated_sessions:0,confirmed_ready_sessions:0,
  })),{confirmed_ready_sessions:0});
  const historical={...row,nonterminal_attempts:2,reviewed_terminal_artifact_attempts:1};
  assert.deepEqual(verifyWorkflowCodeReleaseReadiness(make(historical),true),
    {confirmed_ready_sessions:1});
  assert.throws(()=>verifyWorkflowCodeReleaseReadiness(make(historical)),/unconfirmed/);
  assert.throws(()=>verifyWorkflowCodeReleaseReadiness(make({
    ...historical,nonterminal_attempts:3,
  }),true),/unconfirmed/);
  assert.throws(()=>verifyWorkflowCodeReleaseReadiness(make({
    ...historical,reviewed_terminal_artifact_attempts:0,
  }),true),/historical Artifact/);
  assert.throws(()=>verifyWorkflowCodeReleaseReadiness(make({
    ...historical,reviewed_terminal_artifact_attempts:2,
  }),true),/historical Artifact/);
  // Code-only publish can proceed when every remaining unresolved record
  // is an exact Saga request whose Session and GitHub Attempt both have
  // verified physical terminal evidence. Schema migrations stay strict.
  assert.deepEqual(verifyWorkflowCodeReleaseReadiness(make({
    ...row,nonterminal_attempts:0,nonterminated_sessions:0,confirmed_ready_sessions:0,
    unresolved_steps:1,verified_terminal_saga_receipts:1,
  })),{confirmed_ready_sessions:0});
  for(const broken of [
    {migration_count:19},{expected_migrations:19},{resolved_sha_column:0},
    {migration_count:18},{expected_migrations:18},
    {migration_count:12},{expected_migrations:12},
    {migration_count:13},{expected_migrations:13},
    {migration_count:14},{expected_migrations:14},
    {nonterminal_runs:1},{unresolved_starts:1},{unresolved_steps:1},{invalid_cancelled_steps:1},
    {unresolved_steps:2,verified_terminal_saga_receipts:1},
    {verified_terminal_saga_receipts:1},{verified_terminal_saga_receipts:-1},
    {verified_terminal_saga_receipts:'1'},{verified_terminal_saga_receipts:undefined},
    {undelivered_callbacks:1},{nonterminal_attempts:2},
    {nonterminated_sessions:2},{confirmed_ready_sessions:0},
    {confirmed_ready_sessions:-1},{confirmed_ready_sessions:"1"},
  ]) assert.throws(()=>verifyWorkflowCodeReleaseReadiness(
    make({...row,...broken})),/blocked|unavailable/);
  assert.throws(()=>verifyWorkflowCodeReleaseReadiness([]),/readback unavailable/);
});

test('code-only gate proves terminal Saga receipts using exact physical Session and Attempt',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY,outcome TEXT);
      CREATE TABLE run_steps(run_id TEXT,step_id TEXT,status TEXT);
      CREATE TABLE session_executions(run_id TEXT,step_id TEXT,state TEXT);
      CREATE TABLE step_attempts(run_id TEXT,step_id TEXT,capability_id TEXT,state TEXT);
      INSERT INTO runs VALUES('r','failed');
      INSERT INTO run_steps VALUES('r','__saga_ubuntu','requested');
      INSERT INTO session_executions VALUES('r','ubuntu','terminated');
      INSERT INTO step_attempts VALUES('r','ubuntu','github.action','cancelled');`);
    const begin=WORKFLOW_MIGRATION_READINESS_SQL.indexOf('(SELECT count(*) FROM run_steps receipt');
    const end=WORKFLOW_MIGRATION_READINESS_SQL.indexOf(' AS verified_terminal_saga_receipts',begin);
    assert.ok(begin>=0&&end>begin);
    const query='SELECT '+WORKFLOW_MIGRATION_READINESS_SQL.slice(begin,end+ ' AS verified_terminal_saga_receipts'.length);
    const count=()=>db.prepare(query).get()?.verified_terminal_saga_receipts;
    assert.equal(count(),1);
    db.exec("UPDATE step_attempts SET state='claimed'");
    assert.equal(count(),0,'claimed Job is never physical terminal');
    db.exec("UPDATE step_attempts SET state='cancelled'; UPDATE session_executions SET state='stopping'");
    assert.equal(count(),0,'cancel ACK cannot substitute physical Session terminal');
    db.exec("UPDATE session_executions SET state='terminated';UPDATE runs SET outcome='running'");
    assert.equal(count(),0,'parent must have a terminal business outcome');
    db.exec("UPDATE runs SET outcome='failed';UPDATE run_steps SET step_id='other'");
    assert.equal(count(),0,'non-Saga Step cannot be accepted');
  }finally{db.close();}
});

const executorIdentity={repository:'alternate-owner/private-actions',
  repositoryId:987654321,ciWorkflowId:456789012};
const executorBinding={name:'WORKFLOW_GITHUB_ACTION_IDENTITY',
  type:'plain_text',text:JSON.stringify(executorIdentity)};

test("Workflow active executor source must match the immutable 100 percent Version, not only Settings",async()=>{
  const {verifyWorkflowActiveExecutorBaseline}=await import('./manual-worker-release.mjs');
  const identity=executorBinding;
  const legacy={name:"WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES",
    type:"plain_text",text:"[]"};
  assert.deepEqual(verifyWorkflowActiveExecutorBaseline([legacy],[legacy]),{
    name:legacy.name,text:legacy.text
  });
  assert.deepEqual(verifyWorkflowActiveExecutorBaseline([identity],[identity]),{
    name:identity.name,text:identity.text
  });
  assert.throws(()=>verifyWorkflowActiveExecutorBaseline([legacy],[identity]),
    /active Version and Settings/);
  assert.throws(()=>verifyWorkflowActiveExecutorBaseline([identity],[]),
    /missing or ambiguous/);
  assert.throws(()=>verifyWorkflowActiveExecutorBaseline([identity],[identity,legacy]),
    /missing or ambiguous/);
  assert.throws(()=>verifyWorkflowActiveExecutorBaseline([legacy],
    [{...legacy,text:"[{}]"}]),/active Version and Settings/);
});

test("Workflow readback verifies one integrated runtime, GitHub Action audience and Portal",()=>{
  const bindings=[executorBinding,
    {name:"MCP_ACCESS_TOKEN",type:"secret_text"},
    {name:"WORKFLOW_MCP_PORTAL_CLIENT_ID",type:"plain_text",text:"test-id"},
    {name:"WORKFLOW_MCP_PORTAL_CLIENT_SECRET",type:"secret_text"},
    {name:"WORKFLOW_GITHUB_DISPATCH_TOKEN",type:"secret_text"},
    {name:"DB",type:"d1",id:"a4a477cd-6339-478c-ab7c-f7d87bb0d772"},
    {name:"WORKFLOW",type:"workflow",workflow_name:"workflow-mcp-orchestrator",class_name:"WorkflowOrchestrator"},
    {name:"ACTIONS",type:"service",service:"cloudflare-actions",entrypoint:"ActionsEntrypoint"},
    {name:"WORKFLOW_MCP_PORTAL_ENDPOINT",type:"plain_text",text:"https://mcp.lirtual.dpdns.org/mcp"},
    {name:"WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE",type:"plain_text",text:"workflow-github-action"},
  ];
  const settings={bindings,observability:{enabled:true,logs:{invocation_logs:true}}};
  const secrets=["MCP_ACCESS_TOKEN","WORKFLOW_MCP_PORTAL_CLIENT_SECRET",
    "WORKFLOW_GITHUB_DISPATCH_TOKEN"].map(name=>({name}));
  const check=(list=bindings,ss=secrets)=>
    verifyBindings("workflow-mcp-worker",{...settings,bindings:list},ss,{mode:"readback",expectedWorkflowIdentity:executorIdentity});
  assert.equal(check(),true);
  // A code-only release preserves deployed Variables: reject Audience drift
  // BEFORE deploy, not only during post-publication readback.
  const codeOnlyPreflight=(list=bindings)=>verifyBindings("workflow-mcp-worker",
    {...settings,bindings:list},secrets,{mode:"preflight",requireExistingSecrets:true});
  assert.equal(codeOnlyPreflight(),true);
  for(const value of ["workflow-github-action:production", "workflow-github-action:staging", ""]){
    assert.throws(()=>codeOnlyPreflight(bindings.map(binding=>
      binding.name==="WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE"?{...binding,text:value}:binding)),
    /Workflow code-only Action OIDC audience drift/);
  }
  assert.throws(()=>codeOnlyPreflight(bindings.filter(binding=>
    binding.name!=="WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE")),
  /Workflow code-only release blocked/);
  assert.throws(()=>check([...bindings,{name:"WORKFLOW_SESSION_RUNTIME_DATA_KEY",type:"secret_text"}],
    [...secrets,{name:"WORKFLOW_SESSION_RUNTIME_DATA_KEY"}]),/Unexpected runtime Secret/);
  assert.throws(()=>check([...bindings,{name:"WEIXIN_ACTION_PROVIDER",type:"service",service:"weixin-mcp-worker"}]),
    /Service Binding/);
  assert.throws(()=>check(bindings.map(x=>x.name==="ACTIONS"?{...x,entrypoint:"UnexpectedEntrypoint"}:x)),
    /Service Binding/);
  const oldPin={name:"ACTIONS_DEPLOYMENT_ID",type:"plain_text",
    text:"33333333-3333-4333-8333-333333333333"};
  assert.equal(verifyBindings("workflow-mcp-worker",
    {...settings,bindings:[...bindings,oldPin]},secrets,{mode:"preflight"}),true);
  assert.throws(()=>check([...bindings,oldPin]),/legacy Provider deployment pin/);
  assert.throws(()=>check([...bindings,{...oldPin,text:"latest"}]),/legacy Provider deployment pin/);
  assert.throws(()=>check([...bindings,{name:"WORKFLOW_LEGACY",type:"workflow",workflow_name:"workflow-mcp-runner",class_name:"WorkflowRunner"}]),/Unexpected production resource binding/);
  assert.throws(()=>check(bindings.filter(x=>x.name!=="WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE")),
    /Action OIDC audience/);
  assert.throws(()=>check(bindings.map(x=>x.name==="WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE"
    ? {...x,text:"workflow-github-action:staging"} : x)),/Action OIDC audience/);
  for(const name of ["DB","WORKFLOW"]){
    assert.throws(()=>check(bindings.filter(x=>x.name!==name)),/binding drift/);
  }
  for(const name of ["WORKFLOW_MCP_PORTAL_CLIENT_SECRET","WORKFLOW_GITHUB_DISPATCH_TOKEN"]){
    assert.throws(()=>check(bindings,secrets.filter(x=>x.name!==name)),/Secret missing/);
  }
  assert.throws(()=>check(bindings.map(x=>x.name==="WORKFLOW_MCP_PORTAL_CLIENT_ID" ?
    {...x,type:"secret_text"}:x)),/plaintext Variable|Unexpected runtime Secret|Duplicate runtime binding/);
  assert.throws(()=>check([...bindings,{name:"WORKFLOW_MCP_PORTAL_CLIENT_ID",type:"plain_text",text:"duplicate"}]),
    /plaintext Variable|Unexpected runtime Secret|Duplicate runtime binding/);
  assert.throws(()=>check([...bindings,{name:"WORKFLOW_MCP_PORTAL_CLIENT_ID",type:"secret_text"}]),
    /plaintext Variable|Unexpected runtime Secret|Duplicate runtime binding/);
  assert.throws(()=>check(bindings,[...secrets,{name:"WORKFLOW_MCP_PORTAL_CLIENT_ID"}]),
    /plaintext Variable|Unexpected runtime Secret|Duplicate runtime binding/);
  assert.throws(()=>check([...bindings,{name:"MCP_CALL_ENABLED",type:"plain_text",text:"true"}]),/Obsolete stage flag/);
});


test("Workflow manual GitHub Actions requires D1 checks before Owner", () => {
  const ci=readFileSync(new URL("../.github/workflows/release.yml",import.meta.url),"utf8");
  const pre=ci.indexOf("      - name: Verify Workflow release configuration and remote D1 readiness");
  const migration=ci.indexOf("      - name: Apply complete Workflow D1 migrations");
  const publish=ci.indexOf("      - name: Publish exactly selected Worker");
  assert.ok(pre>0 && migration>pre && publish>migration);
  assert.match(ci,/wrangler d1 migrations apply workflow-mcp-db --remote/);
  const finalQuiescence=ci.indexOf("      - name: Verify code-only Workflow D1 gate at publication (Ready Sessions preserved)");
  assert.ok(finalQuiescence>migration && finalQuiescence<publish);
  const pin=ci.indexOf("      - name: Pin the reviewed unified Actions Worker (read-only)");
  const recheck=ci.indexOf("      - name: Recheck unified Actions Worker before Workflow publication (read-only)");
  const freeze=ci.indexOf("      - name: Verify unified Actions binding transition (read-only)");
  assert.ok(pin>0 && recheck>pin && freeze>recheck && freeze<publish);
  assert.match(ci,/node scripts\/actions-consumer-cutover-gate\.mjs/);
  assert.equal(ci.split('0018_cloudflare_action_migration_fence.sql').length,3);
  assert.match(ci,/pnpm exec wrangler d1 execute workflow-mcp-db --remote --json --command "\$query"/);

  for(const name of ["0006_action_attempt_capabilities.sql","0007_session_executions.sql","0009_fixed_sessions.sql","0010_session_runtime_data.sql","0011_awaited_child_capacity.sql"]){
    assert.equal(ci.split(name).length,3);
  }
  assert.ok(ci.includes("WORKFLOW_GITHUB_ACTION_REPOSITORY: " + String.fromCharCode(36)) && ci.includes("vars.WORKFLOW_GITHUB_ACTION_REPOSITORY"));
  assert.ok(!ci.includes("vars.WORKFLOW_ACTION_APPROVED_REPOSITORIES"), "Legacy grants must not shadow canonical release inputs");
  assert.match(ci,/WORKFLOW_REQUIRE_COMPLETE_SCHEMA: 'true'/);
  assert.ok(ci.includes("WORKFLOW_FIRST_DEPLOY: " + String.fromCharCode(36) + "{{ steps.preflight.outputs.bootstrap }}"));
  assert.match(ci,/node scripts\/manual-worker-release\.mjs d1-check workflow-mcp-worker/);
  assert.match(ci,/\(cd apps\/workflow-mcp-worker &&/);
  assert.match(ci,/mcp_endpoint="https:\/\/workflow\.lirtual\.dpdns\.org\/mcp"/);
  assert.match(ci,/health_endpoint="https:\/\/workflow\.lirtual\.dpdns\.org\/health"/);
  assert.match(ci,/body\.scope !== "workflow"/);
  assert.match(ci,/github\.ref == 'refs\/heads\/main'/);
});

test("Spec 733: scoped GitHub Secret inputs map directly to canonical runtime bindings",()=> {
  const release=readFileSync(new URL("../.github/workflows/release.yml",import.meta.url),"utf8");
  // The separate cleanup job reads approved identity Variables for read-only checks;
  // normal release stages them at the original three protected steps only.
  const normalRelease=release.split('  legacy-secret-cleanup:\n')[0];
  const lines=normalRelease.split(/\r?\n/);
  // Canonical nonsecret Variables are the only supported release inputs.
  for(const [binding,canonical,legacy] of [
    ["WORKFLOW_MCP_PORTAL_CLIENT_ID","vars.WORKFLOW_MCP_PORTAL_CLIENT_ID","vars.MCP_PORTAL_CLIENT_ID"],
    ["WORKFLOW_GITHUB_ACTION_REPOSITORY","vars.WORKFLOW_GITHUB_ACTION_REPOSITORY","vars.WORKFLOW_ACTION_APPROVED_REPOSITORIES"],
  ]) {
    const matched=lines.filter(line=>line.trimStart().startsWith(binding+": "));
    assert.equal(matched.length,binding==="WORKFLOW_GITHUB_ACTION_REPOSITORY"?4:3,
      binding+" must be staged only at reviewed release gates");
    const expected=binding+": "+String.fromCharCode(36)+"{{ inputs.worker == 'workflow-mcp-worker' && "+
      canonical+" || '' }}";
    for(const line of matched) {
      if(binding==="WORKFLOW_GITHUB_ACTION_REPOSITORY" &&
         line.includes("vars.WORKFLOW_GITHUB_ACTION_REPOSITORY") &&
         !line.includes("inputs.worker"))continue;
      assert.equal(line.trim(),expected);
    }
    assert.equal(normalRelease.split(legacy).length-1,0,
      legacy+" must not be referenced in release expressions");
  }
  // Canonical GitHub Secret inputs match the runtime binding names, without aliases.
  for(const [canonical,legacy,worker] of [
    ["WORKFLOW_MCP_PORTAL_CLIENT_SECRET","MCP_PORTAL_CLIENT_SECRET","workflow-mcp-worker"],
    ["SSH_ENCRYPTION_KEY","ENCRYPTION_KEY","ssh-mcp-worker"],
  ]) {
    const selected=lines.filter(line=>line.trimStart().startsWith(canonical+": "));
    assert.equal(selected.length,1,canonical);
    const expected=canonical+": "+String.fromCharCode(36)+
      "{{ inputs.worker == '"+worker+"' && secrets."+canonical+" || '' }}";
    assert.equal(selected[0].trim(),expected);
    assert.equal(lines.filter(line=>line.trimStart().startsWith(legacy+": ")).length,0,
      "Do not stage an independent legacy-named runtime entry: "+legacy);
    assert.ok(!normalRelease.includes("secrets."+legacy),
      "Retired GitHub Secret name must not be consumed: "+legacy);
  }
  assert.match(release,/if: inputs.worker != 'workflow-mcp-worker' \|\| inputs.workflow_code_only != true/);
  assert.match(release,/node scripts\/bootstrap-worker-secrets\.mjs/);
  assert.match(release,/node scripts\/worker-release-variables\.mjs/);
  const worker=readFileSync(new URL("../apps/workflow-mcp-worker/wrangler.jsonc",import.meta.url),"utf8");
  assert.ok(!worker.includes('"MCP_PORTAL_CLIENT_SECRET"'));
  assert.ok(!worker.includes('"SESSION_RUNTIME_DATA_KEY"'));
});

test("Workflow release pins the exact Portal and rejects target drift",()=>{
  const bindings=[executorBinding,
    {name:"MCP_ACCESS_TOKEN",type:"secret_text"},{name:"WORKFLOW_MCP_PORTAL_CLIENT_ID",type:"plain_text",text:"test-id"},
    {name:"WORKFLOW_MCP_PORTAL_CLIENT_SECRET",type:"secret_text"},{name:"WORKFLOW_GITHUB_DISPATCH_TOKEN",type:"secret_text"},
    {name:"DB",type:"d1",id:"a4a477cd-6339-478c-ab7c-f7d87bb0d772"},
    {name:"WORKFLOW",type:"workflow",workflow_name:"workflow-mcp-orchestrator",class_name:"WorkflowOrchestrator"},
    {name:"ACTIONS",type:"service",service:"cloudflare-actions",entrypoint:"ActionsEntrypoint"},
    {name:"WORKFLOW_MCP_PORTAL_ENDPOINT",type:"plain_text",text:"https://mcp.lirtual.dpdns.org/mcp"},
    {name:"WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE",type:"plain_text",text:"workflow-github-action"},
  ];
  const settings={observability:{enabled:true,logs:{invocation_logs:true}}};
  const secrets=["MCP_ACCESS_TOKEN","WORKFLOW_MCP_PORTAL_CLIENT_SECRET",
    "WORKFLOW_GITHUB_DISPATCH_TOKEN"].map(name=>({name}));
  const check=(updated)=>verifyBindings("workflow-mcp-worker",{...settings,bindings:updated},secrets,{mode:"readback",expectedWorkflowIdentity:executorIdentity});
  assert.equal(check(bindings),true);
  assert.throws(()=>check(bindings.map(x=>x.name==="WORKFLOW_MCP_PORTAL_ENDPOINT"
    ?{...x,text:"https://retired.example.org/mcp"}:x)),/pinned Workflow MCP Portal|Pinned Workflow MCP Portal/);
  assert.throws(()=>check([...bindings,{name:"MCP_DIRECT_TARGETS_ENABLED",type:"plain_text",text:"true"}]),
    /Obsolete stage flag/);
});


test("Workflow production readback rejects retired fixed executor pins",()=>{
  const bindings=[executorBinding,
    {name:"MCP_ACCESS_TOKEN",type:"secret_text"},
    {name:"WORKFLOW_MCP_PORTAL_CLIENT_ID",type:"plain_text",text:"test-id"},
    {name:"WORKFLOW_MCP_PORTAL_CLIENT_SECRET",type:"secret_text"},
    {name:"WORKFLOW_GITHUB_DISPATCH_TOKEN",type:"secret_text"},
    {name:"DB",type:"d1",id:"a4a477cd-6339-478c-ab7c-f7d87bb0d772"},
    {name:"WORKFLOW",type:"workflow",workflow_name:"workflow-mcp-orchestrator",class_name:"WorkflowOrchestrator"},
    {name:"ACTIONS",type:"service",service:"cloudflare-actions",entrypoint:"ActionsEntrypoint"},
    {name:"WORKFLOW_MCP_PORTAL_ENDPOINT",type:"plain_text",text:"https://mcp.lirtual.dpdns.org/mcp"},
    {name:"WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE",type:"plain_text",text:"workflow-github-action"},
  ];
  const secrets=["MCP_ACCESS_TOKEN","WORKFLOW_MCP_PORTAL_CLIENT_SECRET","WORKFLOW_GITHUB_DISPATCH_TOKEN"].map(name=>({name}));
  const settings={observability:{enabled:true,logs:{invocation_logs:true}}};
  const verify=list=>verifyBindings("workflow-mcp-worker",{...settings,bindings:list},secrets,{mode:"readback",expectedWorkflowIdentity:executorIdentity});
  assert.equal(verify(bindings),true);
  for(const name of ["GITHUB_EXECUTOR_REPOSITORY","GITHUB_EXECUTOR_REPOSITORY_ID","GITHUB_EXECUTOR_REF","GITHUB_EXECUTOR_AUDIENCE"])
    assert.throws(()=>verify([...bindings,{name,type:"plain_text",text:"obsolete"}]),/Retired fixed GitHub executor variables/);
});

test("Workflow preflight tolerates removed service bindings, readback rejects them",()=>{
  const secrets=["MCP_ACCESS_TOKEN","WORKFLOW_MCP_PORTAL_CLIENT_SECRET",
    "WORKFLOW_GITHUB_DISPATCH_TOKEN"].map(name=>({name}));
  const bindings=[executorBinding,
    {name:"MCP_ACCESS_TOKEN",type:"secret_text"},
    {name:"WORKFLOW_MCP_PORTAL_CLIENT_SECRET",type:"secret_text"},
    {name:"WORKFLOW_GITHUB_DISPATCH_TOKEN",type:"secret_text"},
    {name:"WORKFLOW_MCP_PORTAL_CLIENT_ID",type:"plain_text",text:"test-id"},
    {name:"DB",type:"d1",id:"a4a477cd-6339-478c-ab7c-f7d87bb0d772"},
    {name:"WORKFLOW",type:"workflow",workflow_name:"workflow-mcp-s1",class_name:"WorkflowOrchestrator"},
    {name:"OLD_TEST_SERVICE",type:"service",service:"unused-test-worker"},
    {name:"MCP_CALL_ENABLED",type:"plain_text",text:"true"}
  ];
  const settings={bindings,observability:{enabled:true,logs:{invocation_logs:true}}};
  assert.equal(verifyBindings("workflow-mcp-worker",settings,secrets,{mode:"preflight"}),true);
  assert.throws(()=>verifyBindings("workflow-mcp-worker",settings,secrets,{mode:"readback",expectedWorkflowIdentity:executorIdentity}),/Workflow native Workflow binding drift/);
});


test("worker release documentation stays aligned with the selected-Worker contract", async () => {
  const { BOOTSTRAP_SECRETS } = await import("./bootstrap-worker-secrets.mjs");
  const { WORKER_VARIABLES } = await import("./worker-release-variables.mjs");
  const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const options = release.match(/\n\s+options:\n([\s\S]*?)\n\s+[a-z][a-z_]+:/);
  assert.ok(options, "missing worker release choice options");
  const selected = [...options[1].matchAll(/^\s+- ([a-z-]+-worker)$/gm)].map(m => m[1]).sort();
  const { RELEASE_WORKERS } = await import("./select-affected-apps.mjs");
  assert.deepEqual(selected, [...RELEASE_WORKERS].sort());
  assert.ok(selected.every(worker => Object.hasOwn(BOOTSTRAP_SECRETS, worker)));
  assert.ok(selected.every(worker => Object.hasOwn(WORKER_VARIABLES, worker)));

  for (const path of ["../docs/MANUAL-WORKER-BOOTSTRAP.md",
    "../docs/runtime-configuration.md", "../docs/mcp-shared-token-runbook.md",
    "../docs/ingress-policy.md"]) {
    const doc = readFileSync(new URL(path, import.meta.url), "utf8");
    for (const worker of selected) assert.ok(doc.includes("`" + worker + "`"), path + " omits " + worker);
  }
  const bootstrap = readFileSync(new URL("../docs/MANUAL-WORKER-BOOTSTRAP.md", import.meta.url), "utf8");
  for (const [worker, secrets] of Object.entries(BOOTSTRAP_SECRETS)) {
    const row = bootstrap.split("\n").find(line => line.startsWith("| `" + worker + "` |"));
    assert.ok(row, "missing Worker Environment row for " + worker);
    for (const secret of secrets.filter(x => x !== "MCP_ACCESS_TOKEN")) {
      const githubName=secret;
      assert.ok(row.includes("`" + githubName + "`"),
        worker + " docs omit GitHub Secret input " + githubName);
      assert.ok(row.includes("`" + secret + "`"),
        worker + " docs omit runtime binding " + secret);
    }
  }
  const actions = readFileSync(new URL("../apps/github-actions-mcp-worker/README.md", import.meta.url), "utf8");
  assert.match(actions, /"worker":"github-actions-mcp-worker","deploy_to_production":"true"/);
  assert.doesNotMatch(actions, /"worker":"remote-control-mcp-worker"/);
  const imaConfig = JSON.parse(readFileSync(new URL("../apps/ima-mcp-worker/wrangler.jsonc", import.meta.url), "utf8"));
  assert.ok(!imaConfig.secrets.required.includes("IMA_CLIENT_ID"));
  for (const path of ["../apps/ima-mcp-worker/README.md",
    "../apps/ima-mcp-worker/DEPLOY_CLOUDFLARE.md", "../apps/ima-mcp-worker/docs/mcp-portal.md"]) {
    const doc = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(doc, /IMA_CLIENT_ID/);
    assert.match(doc, /Variable/);
    assert.doesNotMatch(doc, /Worker Secrets:.*IMA_CLIENT_ID/);
  }
  const ingress = readFileSync(new URL("../docs/ingress-policy.md", import.meta.url), "utf8");
  for (const worker of ["workflow-mcp-worker"])
    assert.match(ingress, new RegExp(worker));
  assert.match(ingress, /workers_dev: false/);
});

test("current MCP token runbook lists canonical SSH/Workflow Secret sources", () => {
  const runbook = readFileSync(new URL("../docs/mcp-shared-token-runbook.md", import.meta.url), "utf8");
  const rows = runbook.split("\n");
  for (const [worker, expected, retired] of [
    ["ssh-mcp-worker", "SSH_ENCRYPTION_KEY", "ENCRYPTION_KEY"],
    ["workflow-mcp-worker", "WORKFLOW_MCP_PORTAL_CLIENT_SECRET", "MCP_PORTAL_CLIENT_SECRET"],
  ]) {
    const row = rows.find(line => line.startsWith("| `" + worker + "` |"));
    assert.ok(row?.includes("`" + expected + "`"), worker + " must document the current source");
    assert.ok(!row.includes("`" + retired + "`"), worker + " must not document retired sources");
  }
  assert.match(runbook, /`WORKFLOW_MCP_PORTAL_CLIENT_ID`/);
  assert.doesNotMatch(runbook, /`MCP_PORTAL_CLIENT_ID`/);
  assert.match(runbook, /`DB_HOST` is optional/);
});

test("Database Hyperdrive mapping requires exactly matching unique Wrangler IDs", () => {
  const manifest = [{ binding: "HYPERDRIVE_APP", id: "11111111-2222-3333-4444-555555555555" }];
  assert.equal(verifyDatabaseHyperdriveSource({ hyperdrive: [...manifest] }, manifest), true);
  assert.throws(() => verifyDatabaseHyperdriveSource({ hyperdrive: manifest }, []), /manifest\/source mismatch/);
  assert.throws(() => verifyDatabaseHyperdriveSource({ hyperdrive: [...manifest, { ...manifest[0], binding: "HYPERDRIVE_OTHER" }] },
    [...manifest, { ...manifest[0], binding: "HYPERDRIVE_OTHER" }]), /not uniquely/);
});

test("Database Hyperdrive config readback is fail-closed before and after release", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const before = workflow.indexOf("Verify Database Hyperdrive TLS, CA, origin and cache before publication");
  const publish = workflow.indexOf("Publish exactly selected Worker");
  const after = workflow.indexOf("Verify Database Hyperdrive TLS, CA, origin and cache after publication");
  assert.ok(before > 0 && before < publish && after > publish);
  for (const name of [
    "Verify Database Hyperdrive TLS, CA, origin and cache before publication",
    "Verify Database Hyperdrive TLS, CA, origin and cache after publication"
  ]) {
    const section = workflow.slice(workflow.indexOf("- name: " + name), workflow.indexOf("run: node scripts/verify-database-hyperdrive.mjs", workflow.indexOf("- name: " + name)) + 55);
    assert.match(section, /if: inputs.worker == 'database-mcp-worker'/);
    assert.match(section, /CLOUDFLARE_API_TOKEN/);
  }
});

test('Browser release retains identity, DO, Assets and Bearer under canonical owner settings', async()=>{
  const worker='browser-mcp-worker';
  const conf=readConfiguration(worker, readFileSync(new URL('../apps/browser-mcp-worker/wrangler.jsonc',import.meta.url),'utf8'));
  const fixed=[{name:'MCP_ACCESS_TOKEN',type:'secret_text'},
    {name:'BROWSER_OWNER',type:'durable_object_namespace',class_name:'BrowserOwner',namespace_id:'browser-original'},
    {name:'ASSETS',type:'assets'}];
  const identity={BROWSER_ACCESS_ISSUER:'https://lirtualzero.cloudflareaccess.com',BROWSER_OWNER_EMAIL:'lirtual@outlook.com'};
  const audience='b'.repeat(64);
  const activation={BROWSER_ACTIVATION_ORIGIN:'https://browser.lirtual.dpdns.org',BROWSER_ACTIVATION_AUDIENCE:audience};
  const secret=[{name:'MCP_ACCESS_TOKEN'}];
  const settings=vars=>({bindings:[...fixed,...Object.entries(vars).map(([name,text])=>({name,type:'plain_text',text}))],
    observability:{enabled:true,logs:{invocation_logs:false,head_sampling_rate:0}}});
  const options={mode:'readback',sourceConfig:conf,browserNamespaceId:'browser-original',
    sharedAccessTeamDomain:'lirtualzero.cloudflareaccess.com',sharedOwnerEmail:'lirtual@outlook.com'};
  assert.equal(verifyBindings(worker,settings(identity),secret,options),true);
  assert.throws(()=>verifyBindings(worker,settings({}),secret,options),/Browser live bindings differ/);
  assert.throws(()=>verifyBindings(worker,settings({}),secret,{...options,mode:'preflight'}),/identity baseline/);
  const browserIdentity={accountId:'c'.repeat(32),appId:'77945f97-e1ea-4b2b-b89a-ec71c0472afa',
    teamDomain:'lirtualzero.cloudflareaccess.com',ownerEmail:'lirtual@outlook.com',
    audience,origin:'https://browser.lirtual.dpdns.org'};
  assert.equal(verifyBindings(worker,settings({...identity,...activation}),secret,
    {...options,mode:'preflight',browserIdentity,expectedBrowserActivationAudience:audience}),true);
  assert.throws(()=>verifyBindings(worker,settings({...identity,...activation,BROWSER_ACTIVATION_AUDIENCE:'c'.repeat(64)}),secret,
    {...options,mode:'preflight',browserIdentity,expectedBrowserActivationAudience:audience}),/production identity/);
  assert.equal(verifyBindings(worker,settings({...identity,...activation}),secret,
    {...options,expectedBrowserActivationAudience:audience}),true);
  assert.throws(()=>verifyBindings(worker,settings({...identity,BROWSER_OWNER_EMAIL:'wrong@example.com'}),secret,options),/Browser live bindings differ/);
  assert.throws(()=>verifyBindings(worker,settings({...identity,...activation}),secret,
    {...options,expectedBrowserActivationAudience:'c'.repeat(64)}),/Browser live bindings differ/);
  const noAssets={...settings(identity),bindings:settings(identity).bindings.filter(x=>x.name!=='ASSETS')};
  assert.throws(()=>verifyBindings(worker,noAssets,secret,options),/Assets binding/);
  assert.throws(()=>verifyBindings(worker,settings(identity),[],options),/Secret missing/);
  assert.throws(()=>verifyBindings(worker,settings(identity),secret,{...options,browserNamespaceId:'changed'}),/namespace changed/);
  const {collectBootstrapSecrets}=await import('./bootstrap-worker-secrets.mjs');
  assert.deepEqual(collectBootstrapSecrets(worker,{MCP_ACCESS_TOKEN:'independent',IMA_API_KEY:'unused'}),{MCP_ACCESS_TOKEN:'independent'});
  assert.throws(()=>readConfiguration(worker,JSON.stringify({...conf,migrations:[]})),/persistence drift/);
});

test('production release external actions use immutable commit SHAs', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const references = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)]
    .map(match => match[1])
    .filter(reference => !reference.startsWith('./'));
  assert.ok(references.length > 0, 'expected third-party actions in release workflow');
  for (const reference of references) {
    assert.match(reference, /^[^@\s]+@[a-f0-9]{40}$/, `unlocked release action: ${reference}`);
  }
});

test('Spec 733: Workflow migration may retain only reviewed old Secrets, cleanup requires negative readback', () => {
  const required=['MCP_ACCESS_TOKEN','WORKFLOW_MCP_PORTAL_CLIENT_SECRET',
    'WORKFLOW_GITHUB_DISPATCH_TOKEN'];
  const secrets=required.map(name=>({name}));
  const old=['MCP_PORTAL_CLIENT_SECRET','SESSION_RUNTIME_DATA_KEY'];
  const bindings=[executorBinding,...required.map(name=>({name,type:'secret_text'})),
    {name:'WORKFLOW_MCP_PORTAL_CLIENT_ID',type:'plain_text',text:'test-id'},
    {name:'DB',type:'d1',id:'a4a477cd-6339-478c-ab7c-f7d87bb0d772'},
    {name:'WORKFLOW',type:'workflow',workflow_name:'workflow-mcp-orchestrator',class_name:'WorkflowOrchestrator'},
    {name:'ACTIONS',type:'service',service:'cloudflare-actions',entrypoint:'ActionsEntrypoint'},
    {name:'WORKFLOW_MCP_PORTAL_ENDPOINT',type:'plain_text',text:'https://mcp.lirtual.dpdns.org/mcp'},
    {name:'WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE',type:'plain_text',text:'workflow-github-action'}];
  const wrap=x=>({bindings:x,observability:{enabled:true,logs:{invocation_logs:true}}});
  const inventory=[...bindings,...old.map(name=>({name,type:'secret_text'}))];
  const listed=[...secrets,...old.map(name=>({name}))];
  assert.equal(verifyBindings('workflow-mcp-worker',wrap(inventory),listed,{mode:'readback',expectedWorkflowIdentity:executorIdentity}),true);
  assert.throws(()=>verifyBindings('workflow-mcp-worker',wrap(inventory),listed,
    {mode:'readback',expectedWorkflowIdentity:executorIdentity,cleanupVerified:true}),/Legacy Secret cleanup not complete/);
  assert.equal(verifyBindings('workflow-mcp-worker',wrap(bindings),secrets,
    {mode:'readback',expectedWorkflowIdentity:executorIdentity,cleanupVerified:true}),true);
  assert.throws(()=>verifyBindings('workflow-mcp-worker',wrap([...bindings,
    {name:'UNREVIEWED_SECRET',type:'secret_text'}]),[...secrets,{name:'UNREVIEWED_SECRET'}],
    {mode:'readback',expectedWorkflowIdentity:executorIdentity}),/Unexpected runtime Secret/);
});

test('Spec 733 Database cleanup readback is exact and does not narrow normal migration readback', () => {
  const worker='database-mcp-worker';
  const config=readConfiguration(worker,readFileSync('apps/database-mcp-worker/wrangler.jsonc','utf8'));
  const catalog=JSON.stringify({
    b2b:'mysql://u:${DATABASE_B2B_PASSWORD}@#{DB_HOST}:3306/b2b',
    scrape:'mysql://u:${DATABASE_SCRAPE_RELAY_PASSWORD}@#{DB_HOST}:3306/scrape',
  });
  const secretNames=['MCP_ACCESS_TOKEN','DATABASE_B2B_PASSWORD','DATABASE_SCRAPE_RELAY_PASSWORD'];
  const limits={DATABASE_MAX_ROWS:'500',DATABASE_MAX_RESULT_BYTES:'1048576',DATABASE_MAX_SCHEMA_BYTES:'524288',DATABASE_QUERY_TIMEOUT_MS:'15000',DATABASE_MAX_WRITE_AFFECTED_ROWS:'20'};
  const bindings=[...secretNames.map(name=>({name,type:'secret_text'})),
    {name:'DATABASE_CONNECTIONS',type:'plain_text',text:catalog},{name:'DB_HOST',type:'plain_text',text:'db.example.invalid'},
    ...Object.entries(limits).map(([name,text])=>({name,type:'plain_text',text})),
    {name:'RATE_LIMITER',type:'ratelimit',namespace_id:'1001',simple:{limit:120,period:60}}];
  const wrap=items=>({bindings:items,observability:{enabled:true,logs:{invocation_logs:true}}});
  const listed=secretNames.map(name=>({name}));
  const options={mode:'readback',cleanupVerified:true,sourceConfig:config,databaseConnections:catalog,
    databaseVariables:{DB_HOST:'db.example.invalid'},expectedDatabaseLimits:limits};
  assert.equal(verifyBindings(worker,wrap(bindings),listed,options),true);
  assert.throws(()=>verifyBindings(worker,wrap([...bindings,{name:'DATABASE_ENCRYPTION_KEY',type:'secret_text'}]),
    [...listed,{name:'DATABASE_ENCRYPTION_KEY'}],options),/Legacy Secret cleanup/);
  assert.throws(()=>verifyBindings(worker,wrap([...bindings,{name:'DATABASE_CONFIG',type:'secret_text'}]),
    [...listed,{name:'DATABASE_CONFIG'}],options),/Unexpected runtime Secret/);
  assert.throws(()=>verifyBindings(worker,wrap(bindings.map(binding=>binding.name==='DB_HOST'?{...binding,text:'changed'}:binding)),listed,options),/reference Variable/);
  assert.throws(()=>verifyBindings(worker,wrap(bindings.map(binding=>binding.name==='RATE_LIMITER'?{...binding,simple:{limit:1,period:60}}:binding)),listed,options),/RATE_LIMITER/);
  assert.throws(()=>verifyBindings(worker,wrap(bindings.filter(binding=>binding.name!=='DATABASE_B2B_PASSWORD')),
    listed.filter(secret=>secret.name!=='DATABASE_B2B_PASSWORD'),options),/named Secret is missing/);
  const ordinary=[...listed,{name:'DATABASE_CONFIG'}];
  const ordinaryBindings=[...bindings,{name:'DATABASE_CONFIG',type:'secret_text'}];
  assert.equal(verifyBindings(worker,wrap(ordinaryBindings),ordinary,{...options,cleanupVerified:false}),true);
});

test('Workflow intentional executor migration preserves old baseline but requires exactly the new identity at readback', () => {
  const req=['MCP_ACCESS_TOKEN','WORKFLOW_MCP_PORTAL_CLIENT_SECRET','WORKFLOW_GITHUB_DISPATCH_TOKEN'];
  const secrets=req.map(name=>({name}));
  const grants=JSON.stringify([{repository:'lirtual/github-actions',repositoryId:1430925009,
    commitSha:'d0774dde3a87c7722a939403dbda45507f44b8e0'}]);
  const common=[...req.map(name=>({name,type:'secret_text'})),
    {name:'DB',type:'d1',id:'a4a477cd-6339-478c-ab7c-f7d87bb0d772'},
    {name:'WORKFLOW',type:'workflow',workflow_name:'workflow-mcp-orchestrator',class_name:'WorkflowOrchestrator'},
    {name:'ACTIONS',type:'service',service:'cloudflare-actions',entrypoint:'ActionsEntrypoint'},
    {name:'WORKFLOW_MCP_PORTAL_ENDPOINT',type:'plain_text',text:'https://mcp.lirtual.dpdns.org/mcp'},
    {name:'WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE',type:'plain_text',text:'workflow-github-action'}];
  const legacy={name:'WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES',type:'plain_text',text:grants};
  const previous=[...common,{name:'WORKFLOW_MCP_PORTAL_CLIENT_ID',type:'plain_text',text:'approved-client'},legacy];
  const next=[...common,{name:'WORKFLOW_MCP_PORTAL_CLIENT_ID',type:'plain_text',text:'approved-client'},executorBinding];
  const verify=(bindings,options)=>verifyBindings('workflow-mcp-worker',
    {bindings,observability:{enabled:true,logs:{invocation_logs:true}}},secrets,
    {expectedWorkflowPortalClientId:'approved-client',expectedWorkflowIdentity:executorIdentity,...options});
  const baseline={name:legacy.name,text:legacy.text};
  assert.equal(verify(previous,{mode:'preflight',workflowExecutorBaseline:baseline}),true);
  assert.equal(verify(next,{mode:'readback'}),true);
  assert.throws(()=>verify(previous,{mode:'readback'}),/new executor|baseline|identity invalid/);
  assert.throws(()=>verify(next,{mode:'readback',expectedWorkflowIdentity:{...executorIdentity,repositoryId:9}}),
    /new executor/);
  assert.throws(()=>verify(previous,{mode:'preflight',
    workflowExecutorBaseline:{...baseline,text:'[]'}}),/baseline changed/);
  assert.throws(()=>verify(next,{mode:'readback',expectedWorkflowPortalClientId:''}),/Portal client identity/);
});

test('Spec #804 prepublication gate rejects Access and active Worker drift without resetting state',async()=>{
  const {verifyBrowserPrepublicationCandidate}=await import('./manual-worker-release.mjs');
  const {readFileSync}=await import('node:fs');
  const source=readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  const candidate={worker:'browser-mcp-worker',version_id:'12345678-1234-1234-1234-123456789abc',
    deployment_id:'original-100-percent',browserIdentity:{
      accountId:'c'.repeat(32),appId:'77945f97-e1ea-4b2b-b89a-ec71c0472afa',
      teamDomain:'owner.cloudflareaccess.com',ownerEmail:'owner@example.com',
      audience:'a'.repeat(64),origin:'https://browser.lirtual.dpdns.org',
      policyId:'a9ad0c55-9533-4391-ad59-60018b264401',
      identityProviders:['otp-id']
    }};
  assert.equal(verifyBrowserPrepublicationCandidate(candidate,{
    version_id:candidate.version_id,deployment_id:candidate.deployment_id
  },{...candidate.browserIdentity}),true);
  assert.throws(()=>verifyBrowserPrepublicationCandidate(candidate,{
    version_id:'another',deployment_id:candidate.deployment_id
  },candidate.browserIdentity),/production baseline/);
  assert.throws(()=>verifyBrowserPrepublicationCandidate(candidate,{
    version_id:candidate.version_id,deployment_id:candidate.deployment_id
  },{...candidate.browserIdentity,audience:'b'.repeat(64)}),/identity_drift/);
  assert.ok(source.indexOf('manual-worker-release.mjs identity-recheck')<
    source.indexOf('Publish exactly selected Worker'));
});

test('Gateway source and live bindings are verified by the same protected release gate', () => {
  const path = new URL('../apps/mcp-gateway-worker/wrangler.jsonc', import.meta.url);
  const source = readFileSync(path, 'utf8');
  assert.equal(readConfiguration('mcp-gateway-worker', source).workers_dev, false);
  const names = ['CLERK_SECRET_KEY', 'CF_ACCESS_CLIENT_SECRET'];
  const settings = {
    bindings: [
      ...names.map(name => ({ name, type: 'secret_text' })),
      { name: 'CLERK_ISSUER', type: 'plain_text', text: 'https://clerk.lirtual.dpdns.org' },
      ...['CLERK_PUBLISHABLE_KEY', 'CLERK_OWNER_USER_ID', 'GATEWAY_ORIGIN', 'PORTAL_MCP_URL', 'CF_ACCESS_CLIENT_ID'].map(name => ({ name, type: 'plain_text', text: 'test' })),
    ],
    observability: { enabled: true, logs: { invocation_logs: true } },
  };
  const inventory = names.map(name => ({ name }));
  assert.equal(verifyBindings('mcp-gateway-worker', settings, inventory, { mode: 'readback' }), true);
  assert.throws(() => verifyBindings('mcp-gateway-worker', settings, [], { mode: 'readback' }), /Secret/);
  assert.throws(() => verifyBindings('mcp-gateway-worker', {
    ...settings, bindings: [...settings.bindings, { name: 'UNREVIEWED', type: 'plain_text', text: 'untrusted' }],
  }, inventory, { mode: 'readback' }), /Gateway/);
  const tampered = JSON.parse(source);
  tampered.routes[0].pattern = 'any-other.example.com';
  assert.throws(() => readConfiguration('mcp-gateway-worker', JSON.stringify(tampered)), /Gateway/);
  tampered.routes[0].pattern = 'gateway.lirtual.dpdns.org';
  tampered.workers_dev = true;
  assert.throws(() => readConfiguration('mcp-gateway-worker', JSON.stringify(tampered)), /Gateway/);
});

test('Gateway release secrets and variables are selected without leaking them into other workers', () => {
  const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(release, /MCP_GATEWAY_PORTAL_CLIENT_SECRET: \$\{\{ inputs\.worker == 'mcp-gateway-worker' && secrets\.MCP_GATEWAY_PORTAL_CLIENT_SECRET/);
  assert.match(release, /MCP_GATEWAY_PORTAL_CLIENT_ID: \$\{\{ inputs\.worker == 'mcp-gateway-worker' && vars\.MCP_GATEWAY_PORTAL_CLIENT_ID/);
  assert.match(release, /github\.actor == 'lirtual'/);
  assert.match(release, /github\.ref == 'refs\/heads\/main'/);
  assert.match(release, /needs\.checks\.outputs\.release_ready == 'true'/);
});

test('Gateway manual release checks the exact Clerk-protected custom-domain resource, not workers.dev', () => {
  const yaml = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const smoke = yaml.split('      - name: Check unauthenticated MCP surface without credentials')[1]?.split('\n      - name: ')[0];
  assert.ok(smoke, 'manual release unauthenticated smoke is missing');
  assert.match(smoke, /elif \[\[ "\$SELECTED_WORKER" == "mcp-gateway-worker" \]\]; then\s+mcp_endpoint="https:\/\/gateway\.lirtual\.dpdns\.org\/mcp\/raindrop"/);
  assert.match(smoke, /"\$SELECTED_WORKER" == "mcp-gateway-worker" && "\$FIRST_DEPLOY" == "true"/);
  assert.match(smoke, /401\|403\)/);
});
