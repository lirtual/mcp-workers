import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptExists, activeVersion, verifyBindings, parseWranglerVersion, verifyPublishedVersion, verifyWorkflowReleaseConfig, verifyDatabaseCutoverSource, verifyDatabaseHyperdriveSource, retryReleaseReadback, readConfiguration, workflowReleaseIO } from "./manual-worker-release.mjs";

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
  const clerkIdentity={CLERK_PUBLISHABLE_KEY:"pk_live_"+Buffer.from("clerk.lirtual.dpdns.org$").toString("base64"),CLERK_OWNER_USER_ID:"user_fixture"};
  const prod = { bindings: [
    ...Object.entries(clerkIdentity).map(([name,text])=>({name,type:"plain_text",text})),
    sessionRpc,
    { name: "MCP_ACCESS_TOKEN", type: "secret_text" },
    { name: "REMOTE_CONTROL_INSTALL_ORIGIN", type: "plain_text", text: "https://rca.lirtual.dpdns.org" },
    { name: "DEVICE_COORDINATOR", class_name: "DeviceCoordinator",
      type: "durable_object_namespace", namespace_id: productionNs },
  ], observability: { enabled: true, logs: { invocation_logs: false } } };
  const secrets = [{name:"MCP_ACCESS_TOKEN"}];
  const options = { mode: "readback", previousNamespaceId: previewNs, expectedRcaClerkIdentity:clerkIdentity,
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
  for(const name of Object.keys(clerkIdentity)){
    assert.throws(()=>verifyBindings(worker,{...prod,bindings:prod.bindings.filter(x=>x.name!==name)},secrets,options),/Clerk public identity/);
    assert.throws(()=>verifyBindings(worker,{...prod,bindings:prod.bindings.map(x=>x.name===name?{...x,text:"wrong"}:x)},secrets,options),/Clerk public identity/);
  }
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

test("Workflow code-only release preserves Secrets and other Variables, pins Portal and rejects drift", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_code_only:\n\s*description:.*no D1 migrations or secret upload/);
  assert.match(workflow, /WORKFLOW_CODE_ONLY: \$\{\{ inputs.workflow_code_only \}\}/);
  const releaseScript = readFileSync(new URL("./manual-worker-release.mjs", import.meta.url), "utf8");
  assert.match(releaseScript, /requireExistingSecrets: mode === "preflight"/,
    "existing Secret names checked in read-only preflight");
  assert.match(releaseScript, /Code-only release requires an existing Workflow Worker/);
  assert.match(workflow, /inputs.worker == 'workflow-mcp-worker' && inputs.actions_ingress_quiesced == true && inputs.workflow_code_only != true/);
  assert.match(workflow, /if: inputs.worker == 'workflow-mcp-worker' && inputs.actions_ingress_quiesced == true && inputs.workflow_code_only != true/);
  const deployment = workflow.slice(workflow.indexOf('      - name: Publish exactly selected Worker'));
  assert.match(deployment, /\[\[ ! -e "\$RUNNER_TEMP\/mcp-worker-secrets.json" \]\]/);
  assert.ok(deployment.includes('mapfile -t portal_pins < <(grep'));
  assert.ok(deployment.includes('WORKFLOW_MCP_PORTAL_ENDPOINT:https://mcp-portal.lirtual.dpdns.org/mcp'));
  assert.ok(deployment.includes('deploy_args=(--keep-vars --var "${portal_pins[0]}")'));
  assert.match(deployment, /deploy_args=\(--secrets-file "\$RUNNER_TEMP\/mcp-worker-secrets.json"\)/);
  assert.match(deployment, /if \[\[ "\$WORKFLOW_CODE_ONLY" == "true" \]\]/);
  assert.match(workflow, /ACTIONS_INGRESS_QUIESCED.*!= "true"/);
  for (const job of ["workflow-actions-gate-freeze","workflow-actions-gate-reopen"]) {
    const block = workflow.slice(workflow.indexOf("  "+job+":"));
    assert.match(block.slice(0,550), /inputs.workflow_code_only != true/,
      "code-only selection must not enter maintenance job "+job);
  }
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

test("Task-only production acceptance reuses confirmed Ready Session gate and scoped cleanup",()=>{
  const source=readFileSync(new URL("../apps/workflow-mcp-worker/tests/production-smoke.mjs",import.meta.url),"utf8");
  const fn=source.slice(source.indexOf("async function runActionTaskSmoke()"),
    source.indexOf("async function runWebhookSmoke()"));
  assert.match(fn,/await workflowReleaseProof\('workflow-check',workflowReleaseIO\(\)/);
  assert.doesNotMatch(fn,/session_executions WHERE state != 'terminated'/);
  assert.match(source,/DELETE FROM step_attempts WHERE run_id IN \(SELECT id FROM runs WHERE workflow_id = /);
  assert.match(source,/DELETE FROM mcp_dispatch_fences WHERE run_id IN \(SELECT id FROM runs WHERE workflow_id = /);
  assert.match(source,/Refusing GitHub cleanup until physical GitHub Job is completed/);
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
    {name:"WORKFLOW_MCP_PORTAL_ENDPOINT",type:"plain_text",text:"https://mcp-portal.lirtual.dpdns.org/mcp"},
    {name:"WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE",type:"plain_text",text:"workflow-github-action"},
  ];
  const settings={bindings,observability:{enabled:true,logs:{invocation_logs:true}}};
  const secrets=["MCP_ACCESS_TOKEN","WORKFLOW_MCP_PORTAL_CLIENT_SECRET",
    "WORKFLOW_GITHUB_DISPATCH_TOKEN"].map(name=>({name}));
  const check=(list=bindings,ss=secrets)=>
    verifyBindings("workflow-mcp-worker",{...settings,bindings:list},ss,{mode:"readback",expectedWorkflowIdentity:executorIdentity});
  assert.equal(check(),true);
  const dropNames=["WORKFLOW_GITHUB_DROP_PUBLIC_KEY", "WORKFLOW_GITHUB_DROP_RECEIPT_PRIVATE_KEY"];
  const dropBindings=dropNames.map(name=>({name,type:"secret_text"}));
  const dropSecrets=dropNames.map(name=>({name}));
  assert.equal(check([...bindings,...dropBindings],[...secrets,...dropSecrets]),true);
  for(const missing of dropNames){
    assert.throws(()=>check([...bindings,...dropBindings.filter(x=>x.name!==missing)],
      [...secrets,...dropSecrets.filter(x=>x.name!==missing)]),/complete pair/);
    assert.throws(()=>check([...bindings,...dropBindings],
      [...secrets,...dropSecrets.filter(x=>x.name!==missing)]),/complete pair/);
    assert.throws(()=>check([...bindings,...dropBindings.map(x=>x.name===missing?{...x,type:"plain_text"}:x)],
      [...secrets,...dropSecrets]),/Unexpected runtime Secret/);
  }
  // A Drop key name must not bypass the pair gate by being exposed as a plain-text Variable.
  assert.throws(()=>check([...bindings,...dropNames.map(name=>({name,type:"plain_text",text:"unexpected"}))],secrets),
    /complete pair/);
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


test("Workflow protected release retains independent identity, schema and health gates", () => {
 const ci=readFileSync(new URL("../.github/workflows/release.yml",import.meta.url),"utf8");
 const prepare=ci.indexOf("      - name: Prepare strict Workflow cutover and record recovery point");
 const migrate=ci.indexOf("      - name: Apply only the reviewed v23 Workflow D1 migration");
 const backfill=ci.indexOf("      - name: Conditionally backfill terminal facts");
 const publish=ci.indexOf("      - name: Publish exactly selected Worker");
 const deploy=ci.indexOf('pnpm exec wrangler deploy',publish);
 const health=ci.indexOf("      - name: Check existing public health endpoint");
 const activate=ci.indexOf("      - name: Reopen only the now-verified unified Action admission gate");
 const check=ci.indexOf("node scripts/manual-worker-release.mjs workflow-check workflow-mcp-worker",publish);
 assert.ok(prepare>0&&migrate>prepare&&backfill>migrate&&publish>backfill&&check>publish&&deploy>check&&health>deploy&&activate>health);
 assert.match(ci.slice(prepare,migrate),/d1 time-travel info workflow-mcp-db --json/);
 assert.match(ci.slice(migrate,backfill),/workflow-cutover-recheck workflow-mcp-worker[\s\S]*wrangler d1 migrations apply workflow-mcp-db --remote/);
 assert.match(ci.slice(backfill,publish),/workflow-backfill workflow-mcp-worker/);
 const pin=ci.indexOf("      - name: Pin the reviewed unified Actions Worker (read-only)");
 const recheck=ci.indexOf("      - name: Recheck unified Actions Worker before Workflow publication (read-only)");
 const freeze=ci.indexOf("      - name: Verify current unified Actions binding and gate (read-only)");
 assert.ok(pin>0&&recheck>pin&&freeze>recheck&&freeze<publish);
 assert.match(ci,/node scripts\/actions-consumer-cutover-gate\.mjs/);
 assert.ok(ci.includes("vars.WORKFLOW_GITHUB_ACTION_REPOSITORY"));
 assert.ok(!ci.includes("vars.WORKFLOW_ACTION_APPROVED_REPOSITORIES"));
 assert.match(ci,/mcp_endpoint="https:\/\/workflow\.lirtual\.dpdns\.org\/mcp"/);
 assert.match(ci,/health_endpoint="https:\/\/workflow\.lirtual\.dpdns\.org\/health"/);
 assert.match(ci,/body\.scope !== "workflow"/);
 assert.match(ci,/github\.ref == 'refs\/heads\/main'/);
 assert.doesNotMatch(ci,/WORKFLOW_(?:[A-Z_]+_)?TERMINAL_RUN_ID|steps\.terminal|migration-check workflow-mcp-worker/);
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
    {name:"WORKFLOW_MCP_PORTAL_ENDPOINT",type:"plain_text",text:"https://mcp-portal.lirtual.dpdns.org/mcp"},
    {name:"WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE",type:"plain_text",text:"workflow-github-action"},
  ];
  const settings={observability:{enabled:true,logs:{invocation_logs:true}}};
  const secrets=["MCP_ACCESS_TOKEN","WORKFLOW_MCP_PORTAL_CLIENT_SECRET",
    "WORKFLOW_GITHUB_DISPATCH_TOKEN"].map(name=>({name}));
  const check=(updated)=>verifyBindings("workflow-mcp-worker",{...settings,bindings:updated},secrets,{mode:"readback",expectedWorkflowIdentity:executorIdentity});
  assert.equal(check(bindings),true);
  assert.throws(()=>check(bindings.map(x=>x.name==="WORKFLOW_MCP_PORTAL_ENDPOINT"
    ?{...x,text:"https://retired.example.org/mcp"}:x)),/pinned Workflow MCP Portal|Pinned Workflow MCP Portal/);
  assert.throws(()=>check(bindings.map(x=>x.name==="WORKFLOW_MCP_PORTAL_ENDPOINT"
    ?{...x,text:"https://mcp.lirtual.dpdns.org/mcp"}:x)),/pinned Workflow MCP Portal|Pinned Workflow MCP Portal/);
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
    {name:"WORKFLOW_MCP_PORTAL_ENDPOINT",type:"plain_text",text:"https://mcp-portal.lirtual.dpdns.org/mcp"},
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

test('Workflow ordinary readback rejects retired Secret bindings', () => {
  const required=['MCP_ACCESS_TOKEN','WORKFLOW_MCP_PORTAL_CLIENT_SECRET',
    'WORKFLOW_GITHUB_DISPATCH_TOKEN'];
  const secrets=required.map(name=>({name}));
  const old=['MCP_PORTAL_CLIENT_SECRET','SESSION_RUNTIME_DATA_KEY'];
  const bindings=[executorBinding,...required.map(name=>({name,type:'secret_text'})),
    {name:'WORKFLOW_MCP_PORTAL_CLIENT_ID',type:'plain_text',text:'test-id'},
    {name:'DB',type:'d1',id:'a4a477cd-6339-478c-ab7c-f7d87bb0d772'},
    {name:'WORKFLOW',type:'workflow',workflow_name:'workflow-mcp-orchestrator',class_name:'WorkflowOrchestrator'},
    {name:'ACTIONS',type:'service',service:'cloudflare-actions',entrypoint:'ActionsEntrypoint'},
    {name:'WORKFLOW_MCP_PORTAL_ENDPOINT',type:'plain_text',text:'https://mcp-portal.lirtual.dpdns.org/mcp'},
    {name:'WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE',type:'plain_text',text:'workflow-github-action'}];
  const wrap=x=>({bindings:x,observability:{enabled:true,logs:{invocation_logs:true}}});
  const inventory=[...bindings,...old.map(name=>({name,type:'secret_text'}))];
  const listed=[...secrets,...old.map(name=>({name}))];
  assert.throws(()=>verifyBindings('workflow-mcp-worker',wrap(inventory),listed,
    {mode:'readback',expectedWorkflowIdentity:executorIdentity}),/Unexpected runtime Secret/);
  assert.equal(verifyBindings('workflow-mcp-worker',wrap(bindings),secrets,
    {mode:'readback',expectedWorkflowIdentity:executorIdentity}),true);
  assert.throws(()=>verifyBindings('workflow-mcp-worker',wrap([...bindings,
    {name:'UNREVIEWED_SECRET',type:'secret_text'}]),[...secrets,{name:'UNREVIEWED_SECRET'}],
    {mode:'readback',expectedWorkflowIdentity:executorIdentity}),/Unexpected runtime Secret/);
});

test('Database ordinary readback accepts only current Secret contracts', () => {
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
  const options={mode:'readback',sourceConfig:config,databaseConnections:catalog,
    databaseVariables:{DB_HOST:'db.example.invalid'},expectedDatabaseLimits:limits};
  assert.equal(verifyBindings(worker,wrap(bindings),listed,options),true);
  assert.throws(()=>verifyBindings(worker,wrap([...bindings,{name:'DATABASE_ENCRYPTION_KEY',type:'secret_text'}]),
    [...listed,{name:'DATABASE_ENCRYPTION_KEY'}],options),/Unexpected runtime Secret/);
  assert.throws(()=>verifyBindings(worker,wrap([...bindings,{name:'DATABASE_CONFIG',type:'secret_text'}]),
    [...listed,{name:'DATABASE_CONFIG'}],options),/Unexpected runtime Secret/);
  assert.throws(()=>verifyBindings(worker,wrap(bindings.map(binding=>binding.name==='DB_HOST'?{...binding,text:'changed'}:binding)),listed,options),/reference Variable/);
  assert.throws(()=>verifyBindings(worker,wrap(bindings.map(binding=>binding.name==='RATE_LIMITER'?{...binding,simple:{limit:1,period:60}}:binding)),listed,options),/RATE_LIMITER/);
  assert.throws(()=>verifyBindings(worker,wrap(bindings.filter(binding=>binding.name!=='DATABASE_B2B_PASSWORD')),
    listed.filter(secret=>secret.name!=='DATABASE_B2B_PASSWORD'),options),/named Secret is missing/);
  const ordinary=[...listed,{name:'DATABASE_CONFIG'}];
  const ordinaryBindings=[...bindings,{name:'DATABASE_CONFIG',type:'secret_text'}];
  assert.throws(()=>verifyBindings(worker,wrap(ordinaryBindings),ordinary,options),/Unexpected runtime Secret/);
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
    {name:'WORKFLOW_MCP_PORTAL_ENDPOINT',type:'plain_text',text:'https://mcp-portal.lirtual.dpdns.org/mcp'},
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
  tampered.routes[0].pattern = 'renamed-gateway.example.org';
  assert.doesNotThrow(() => readConfiguration('mcp-gateway-worker', JSON.stringify(tampered)));
  tampered.routes[0].pattern = '*.example.org';
  assert.throws(() => readConfiguration('mcp-gateway-worker', JSON.stringify(tampered)), /Gateway/);
  tampered.routes[0].pattern = 'renamed-gateway.example.org';
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
  assert.match(smoke, /elif \[\[ "\$SELECTED_WORKER" == "mcp-gateway-worker" \]\]; then/);
  assert.match(smoke, /readFileSync\("apps\/mcp-gateway-worker\/wrangler\.jsonc"/);
  assert.match(smoke, /gatewayOriginFromConfig\(config\) \+ "\/mcp\/raindrop"/);
  assert.match(smoke, /"\$SELECTED_WORKER" == "mcp-gateway-worker" && "\$FIRST_DEPLOY" == "true"/);
  assert.match(smoke, /401\|403\)/);
});

// #1046: reconstruct the old release obstruction from the audited pre-CAS
// projection in issue comment 7166814978. Unreported input/plan content is
// deliberately synthetic; the release gate does not depend on it.
test('historical Ubuntu terminal execution reproduces the old Unknown release obstruction (#1046)', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const migrationDir = new URL('../apps/workflow-mcp-worker/migrations/', import.meta.url);
    const files = readdirSync(migrationDir).filter(f=>/^\d{4}_.+\.sql$/.test(f)).sort();
    db.exec('CREATE TABLE d1_migrations(name TEXT PRIMARY KEY)');
    for (const file of files.filter(f=>f.slice(0,4)<='0022')) {
      db.exec('BEGIN');
      db.exec(readFileSync(new URL(file,migrationDir),'utf8'));
      db.prepare('INSERT INTO d1_migrations VALUES(?)').run(file);
      db.exec('COMMIT');
    }
    const id='77a9ef72-7e08-47ba-8f85-90f82f1656e8';
    const version='5a3d7d4b-99ff-40a1-bb4f-50675b5c1f4b';
    const attempt='81fc4de2-4936-496a-b51a-7c4f8cac75a3';
    db.prepare("INSERT INTO workflows(id,name,draft,created_at,updated_at) VALUES('fixture','ubuntu','{}',0,0)").run();
    db.prepare("INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES(?,'fixture','fixture','{}',0)").run(version);
    db.prepare("INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,start_state,outcome,result,error_code,created_at,updated_at) VALUES(?,'fixture',?,?,'fixture','{}','started','indeterminate','null','github_session_no_ready',0,1795401799113)").run(id,version,id);
    db.prepare("INSERT INTO run_steps(run_id,step_id,status,error_code,updated_at) VALUES(?,'ubuntu_session','indeterminate','github_session_no_ready',1795401798923),(?,'notify_bark','skipped',NULL,1795401799065)").run(id,id);
    db.prepare("INSERT INTO session_executions(run_id,step_id,slot,state,created_at,updated_at) VALUES(?,'ubuntu_session',1,'terminated',0,0)").run(id);
    db.prepare("INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,state,repository,repository_id,workflow_ref,ref,candidate_run_id,candidate_run_attempt,owner_run_id,owner_run_attempt,created_at,updated_at,resolved_sha) VALUES(?,?,'ubuntu_session','github.action','fixture','cancelled','autoactions/github-actions','1452488311','autoactions/github-actions/.github/workflows/ubuntu.yml@refs/heads/main','refs/heads/main',45101764677,1,45101764677,1,0,0,'dee9dbaf71c3c2e48bf31a8ad20bb24d21d31c27')").run(attempt,id);
    // Reconstruct only the retired gate's two blocking predicates, not its
    // old operational compatibility code.
    const row=db.prepare(`SELECT
      (SELECT count(*) FROM runs WHERE outcome NOT IN ('succeeded','failed','cancelled')) AS nonterminal_runs,
      (SELECT count(*) FROM run_steps WHERE status NOT IN ('succeeded','failed','skipped','cancelled')) AS unresolved_steps,
      (SELECT count(*) FROM step_attempts WHERE state NOT IN ('rejected','succeeded','failed','cancelled')) AS nonterminal_attempts,
      (SELECT count(*) FROM session_executions WHERE state!='terminated') AS nonterminated_sessions,
      (SELECT count(*) FROM callback_receipts WHERE notification_delivered!=1) AS undelivered_callbacks`).get();
    assert.deepEqual(Object.values(row),[1,1,0,0,0]);
    assert.equal(db.prepare('SELECT outcome FROM runs WHERE id=?').get(id).outcome,'indeterminate');
  } finally {db.close();}
});

// This seam is the shared release verification boundary, not a Worker
// status mutation. Source: #1046 comment 7166814978 and current Attempt readback.
test('verified terminal execution is independent of Unknown business result (#1046)',async()=>{
  const {verifyWorkflowTerminalEvidence}=await import('./manual-worker-release.mjs');
  const id='77a9ef72-7e08-47ba-8f85-90f82f1656e8';
  const run={id,instance_id:id,start_state:'started',outcome:'indeterminate'};
  const native={instance_id:id,status:'complete',observed_at:1795402100881};
  const attempt={attempt_id:'81fc4de2-4936-496a-b51a-7c4f8cac75a3',run_id:id,
    step_id:'ubuntu_session',capability_id:'github.action',state:'cancelled',
    repository_id:'1452488311',candidate_run_id:45101764677,candidate_run_attempt:1,
    owner_run_id:45101764677,owner_run_attempt:1};
  const evidence={
    steps:[{run_id:id,step_id:'ubuntu_session',status:'indeterminate'},
      {run_id:id,step_id:'notify_bark',status:'skipped'}],
    attempts:[attempt],sessions:[{run_id:id,step_id:'ubuntu_session',state:'terminated'}],
    callbacks:[],children:[],invocations:[],mcpFences:[],githubCancellations:[],
    cloudflareCancellations:[],childCancellations:[],gates:[],approvals:[],waits:[],
  };
  assert.deepEqual(verifyWorkflowTerminalEvidence(run,native,evidence),
    {instance_id:id,status:'complete',observed_at:1795402100881});
  assert.equal(run.outcome,'indeterminate');
  // A cancellation intent/ACK is retained even after a verified physical
  // termination; it is neither a new active execution nor terminal proof.
  const cancellation={run_id:id,step_id:attempt.step_id,attempt_id:attempt.attempt_id,
    cancel_ack:'accepted',force_ack:null};
  for(const ack of ['accepted','unknown']){
    assert.deepEqual(verifyWorkflowTerminalEvidence(run,native,{...evidence,
      githubCancellations:[{...cancellation,cancel_ack:ack}]}),native);
  }
  const callback={run_id:id,step_id:attempt.step_id,attempt_id:attempt.attempt_id,
    outcome:'failed',notification_delivered:1};
  assert.deepEqual(verifyWorkflowTerminalEvidence(run,native,{...evidence,callbacks:[callback]}),native);
  for(const bad of [
    {...native,instance_id:'different'},{...native,status:'running'},
    {...native,status:'rollingBack'},null,
  ]) assert.throws(()=>verifyWorkflowTerminalEvidence(run,bad,evidence),/native/);
  for(const bad of [
    {...evidence,callbacks:[{...callback,step_id:'notify_bark'}]},
    {...evidence,callbacks:[{...callback,attempt_id:'different'}]},
    {...evidence,githubCancellations:[{...cancellation,attempt_id:'different'}]},
    {...evidence,githubCancellations:[{...cancellation,step_id:'notify_bark'}]},
    {...evidence,githubCancellations:[cancellation],attempts:[{...attempt,state:'claimed'}]},
    {...evidence,githubCancellations:[cancellation],attempts:[{...attempt,state:'rejected',
      candidate_run_id:null,candidate_run_attempt:null,owner_run_id:null,owner_run_attempt:null}],sessions:[]},
    {...evidence,sessions:[{...evidence.sessions[0],state:'stopping'}]},
    {...evidence,attempts:[{...attempt,state:'claimed'}]},
    {...evidence,attempts:[{...attempt,state:'dispatch_unknown'}]},
    {...evidence,attempts:[{...attempt,owner_run_attempt:2}]},
    {...evidence,callbacks:[{run_id:id,attempt_id:attempt.attempt_id,notification_delivered:0}]},
    {...evidence,children:[{id:'child',parent_run_id:id,outcome:'succeeded'}]},
    {...evidence,invocations:[{run_id:id,step_id:'notify_bark'}]},
    {...evidence,mcpFences:[{run_id:id,step_id:'notify_bark'}]},
    {...evidence,steps:[{run_id:id,step_id:'ubuntu_session',status:'running'}]},
    {...evidence,waits:undefined},
  ]) assert.throws(()=>verifyWorkflowTerminalEvidence(run,native,bad),/terminal evidence/);
  assert.throws(()=>verifyWorkflowTerminalEvidence({...run,outcome:'running'},native,evidence),/terminal evidence/);
});

// Actual #179 historical Artifact receipt. Native history expired; the
// protected release step and current physical GitHub run were re-read.
test('historical claimed Artifact requires matched physical proof and delivered receipt (#1046)',async()=>{
  const {verifyWorkflowTerminalEvidence}=await import('./manual-worker-release.mjs');
  const {historicalArtifactTerminalProof}=await import('./workflow-terminal-run-exception.mjs');
  const id='f99bb918-2909-46df-b196-d07faa64df27';
  const run={id,instance_id:id,workflow_id:'685026cf-abaa-4618-a363-5944fac729d2',
    version_id:'88158dd2-25c9-4e66-b98a-51ac34f829e0',outcome:'indeterminate',
    start_state:'started',error_code:'github_dispatch_unknown'};
  const step={run_id:id,step_id:'verify',status:'indeterminate',error_code:'github_dispatch_unknown'};
  const attempt={run_id:id,step_id:'verify',attempt_id:'c7893834-10ff-41d5-b784-a33d00cc20f5',
    state:'claimed',capability_id:'github.action',repository:'lirtual/github-actions',repository_id:'1430925009',
    workflow_ref:'lirtual/github-actions/.github/workflows/verify-action.yml@refs/tags/v0.1.42-rc.10',
    ref:'refs/tags/v0.1.42-rc.10',owner_run_id:41182432750,owner_run_attempt:1,
    candidate_run_id:41182432750,candidate_run_attempt:1,resolved_sha:null};
  const receipt={run_id:id,step_id:'verify',attempt_id:attempt.attempt_id,outcome:'succeeded',notification_delivered:1};
  const evidence={steps:[step],attempts:[attempt],sessions:[],callbacks:[receipt],children:[],
    invocations:[],mcpFences:[],githubCancellations:[],cloudflareCancellations:[],
    childCancellations:[],gates:[],approvals:[],waits:[]};
  const d1=[[run],[step],[],[attempt],[receipt],[],[]].map(results=>({success:true,results}));
  const sha='21d6583fe2b43fbb58f93c68e44cc936fb02b0fb';
  const prior={id:41429815494,workflow_id:394912681,head_sha:sha,event:'workflow_dispatch',
    head_branch:'main',run_attempt:1,status:'completed',conclusion:'success'};
  const steps=[
    'Verify seventh terminal download Run proof (read-only)',
    'Verify ninth terminal Saga Run proof (read-only)',
    'Verify tenth terminal Saga Run proof (read-only)',
    'Verify eleventh terminal generic Action proof (read-only)',
    'Verify twelfth terminal Artifact Task proof (read-only)'
  ].map((name,i)=>({name,status:'completed',conclusion:'success',
    completed_at:['2026-11-02T10:35:16Z','2026-11-02T10:35:19Z','2026-11-02T10:35:21Z',
      '2026-11-02T10:35:22Z','2026-11-02T10:35:24Z'][i]}));
  const jobs={jobs:[{id:125225662362,name:'Manual selected Worker release',head_sha:sha,
    status:'completed',conclusion:'success',steps}]};
  const github={id:41182432750,repository:{id:1430925009,full_name:'lirtual/github-actions'},
    workflow_id:394689660,path:'.github/workflows/verify-action.yml',event:'workflow_dispatch',
    run_attempt:1,head_branch:'v0.1.42-rc.10',head_sha:'f5d44ff5a5dbd5b1b444c907e3654266a465da85',
    status:'completed',conclusion:'success'};
  const now=Date.parse('2026-11-25T15:55:19Z');
  const proof=historicalArtifactTerminalProof(d1,prior,jobs,github,now);
  assert.equal(proof.observed_at,Date.parse('2026-11-02T10:35:24Z'));
  assert.deepEqual(verifyWorkflowTerminalEvidence(run,proof,evidence),proof);
  assert.equal(run.outcome,'indeterminate');
  assert.equal(attempt.state,'claimed');
  const {github_attempts,...native}=proof;
  const [github_attempt]=github_attempts;
  assert.throws(()=>verifyWorkflowTerminalEvidence(run,native,evidence),/terminal evidence/);
  for(const patch of [{attempt_id:'wrong'},{repository_id:'wrong'},{run_id:41182432751},
    {run_attempt:2},{conclusion:'failure'},{observed_at:0}]){
    assert.throws(()=>verifyWorkflowTerminalEvidence(run,{...proof,github_attempts:[{...github_attempt,...patch}]},evidence),/terminal evidence/);
  }
  for(const bad of [
    {...evidence,callbacks:[]},
    {...evidence,callbacks:[{...receipt,notification_delivered:0}]},
    {...evidence,callbacks:[{...receipt,outcome:'failed'}]},
    {...evidence,attempts:[{...attempt,owner_run_attempt:2}]},
    {...evidence,attempts:[{...attempt,ref:'refs/heads/main'}]},
    {...evidence,sessions:[{run_id:id,step_id:'verify',state:'terminated'}]},
  ]) assert.throws(()=>verifyWorkflowTerminalEvidence(run,proof,bad),/terminal evidence/);
  for(const bad of [{...github,status:'in_progress'},{...github,run_attempt:2},{...github,head_sha:'0'.repeat(40)}])
    assert.throws(()=>historicalArtifactTerminalProof(d1,prior,jobs,bad,now),/blocked/);
  const badJobs=structuredClone(jobs);badJobs.jobs[0].steps.at(-1).conclusion='skipped';
  assert.throws(()=>historicalArtifactTerminalProof(d1,prior,badJobs,github,now),/blocked/);
});

// The actual production inventory prefix is v22, not a newly invented
// minimal table. The one additive migration must preserve all audit rows.
test('#1046 v22 to v23 adds only the nullable bounded terminal proof column',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    const dir=new URL('../apps/workflow-mcp-worker/migrations/',import.meta.url);
    const files=readdirSync(dir).filter(f=>/^\d{4}_.+\.sql$/.test(f)).sort();
    assert.equal(files.length,23);
    assert.equal(files.at(-1),'0023_execution_terminal_proof.sql');
    for(const name of files.slice(0,22))db.exec(readFileSync(new URL(name,dir),'utf8'));
    db.prepare("INSERT INTO workflows(id,name,draft,created_at,updated_at) VALUES('wf','test','{}',1,1)").run();
    db.prepare("INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES('v','wf','d','{}',1)").run();
    db.prepare("INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,start_state,outcome,error_code,created_at,updated_at) VALUES('r','wf','v','i','d','{}','started','indeterminate','execution_interrupted',1,2)").run();
    db.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES('r','s','indeterminate',2)").run();
    const original=db.prepare('SELECT * FROM runs').all();
    const originalSteps=db.prepare('SELECT * FROM run_steps').all();
    const schema=()=>db.prepare("SELECT type,name FROM sqlite_master ORDER BY type,name").all();
    const before=schema();
    db.exec(readFileSync(new URL(files.at(-1),dir),'utf8'));
    assert.deepEqual(schema(),before);
    const after=db.prepare('SELECT * FROM runs').all();
    assert.equal(after[0].execution_terminal_proof,null);
    delete after[0].execution_terminal_proof;
    assert.deepEqual(after,original);
    assert.deepEqual(db.prepare('SELECT * FROM run_steps').all(),originalSteps);
  }finally{db.close();}
});

// Current durable receipts, not their mere existence, establish closure.
// A native terminal alone does not settle a lost external effect.
test('#1046 current effect and wait receipts do not block after independently known completion',async()=>{
  const {verifyWorkflowTerminalEvidence}=await import('./manual-worker-release.mjs');
  const run={id:'r',instance_id:'i',version_id:'v',start_state:'started',outcome:'indeterminate'};
  const native={instance_id:'i',status:'complete',observed_at:1000};
  const digest='a'.repeat(64);
  const plan={cloudflare_execution_approved:true,cloudflare_action_approvals:[{executor:'cloudflare',provider:'bark',action:'bark.send_notification',contract_digest:digest}],mcp_connection_generation:2,http_connection_generation:3,steps:[
    {id:'mcp',uses:'mcp.call',with:{scope:'write'}},
    {id:'task',uses:'github.run',with:{action:{type:'task'}},approval:{required:true}},
    {id:'http',uses:'http.request',with:{method:'GET'}},
    {id:'notify',uses:'action.run',with:{executor:'cloudflare',provider:'bark',action:'bark.send_notification',contract_digest:digest}},
    {id:'wait',uses:'flow.wait_event',with:{}},
    {id:'last',uses:'result.emit',with:{}}
  ]};
  const steps=plan.steps.map(s=>({run_id:'r',step_id:s.id,status:s.id==='last'?'indeterminate':s.id==='http'?'failed':'succeeded',
    error_code:s.id==='http'?'http_response_error':null}));
  const invocation={run_id:'r',step_id:'notify',invocation_id:'invoke',source_attempt_id:'invoke',deployment_id:'provider-version',contract_digest:digest,binding_generation:0};
  const e={plan:{id:'v',plan},steps,attempts:[{run_id:'r',step_id:'task',attempt_id:'task-a',capability_id:'github.action',state:'succeeded',candidate_run_id:12,candidate_run_attempt:1,owner_run_id:12,owner_run_attempt:1}],sessions:[],callbacks:[],children:[],invocations:[invocation],
    mcpFences:[{run_id:'r',step_id:'mcp',generation:2},{run_id:'r',step_id:'http',generation:3}],
    githubCancellations:[],cloudflareCancellations:[],childCancellations:[],
    gates:[{run_id:'r',step_id:'task',version_id:'v',deadline_at:500}],
    approvals:[{run_id:'r',step_id:'task',version_id:'v',decision:'approved',created_at:100,consumed_at:200}],
    waits:[{run_id:'r',step_id:'wait',last_sent_at:100}]};
  assert.deepEqual(verifyWorkflowTerminalEvidence(run,native,e),native);
  const changeStep=(id,status,error_code)=>({...e,steps:steps.map(s=>s.step_id===id?{...s,status,error_code}:s)});
  for(const bad of [
    {...e,plan:undefined},{...e,plan:{...e.plan,id:'wrong'}},
    {...e,invocations:[{...invocation,contract_digest:'different'}]},
    {...e,invocations:[{...invocation,source_attempt_id:'other'}]},
    changeStep('notify','indeterminate','cloudflare_outcome_unknown'),
    changeStep('mcp','indeterminate','external_outcome_unknown'),
    changeStep('http','indeterminate','http_outcome_unknown'),
    {...e,mcpFences:[{...e.mcpFences[0],generation:1},e.mcpFences[1]]},
    {...e,approvals:[{...e.approvals[0],version_id:'old'}]},
    {...e,approvals:[{...e.approvals[0],consumed_at:null}]},
    {...e,waits:[{...e.waits[0],step_id:'last'}]},
    changeStep('wait','waiting',null),
  ])assert.throws(()=>verifyWorkflowTerminalEvidence(run,native,bad),/terminal evidence/);
});

test('#1046 independently verified child closure and Saga cancellation do not require rewriting history',async()=>{
 const {verifyWorkflowTerminalEvidence}=await import('./manual-worker-release.mjs');
 const empty={steps:[],attempts:[],sessions:[],callbacks:[],children:[],invocations:[],mcpFences:[],
   githubCancellations:[],cloudflareCancellations:[],childCancellations:[],gates:[],approvals:[],waits:[]};
 const parent={id:'parent',instance_id:'parent',version_id:'pv',start_state:'started',outcome:'indeterminate'};
 const native={instance_id:'parent',status:'errored',observed_at:1000};
 const child={id:'child',instance_id:'child',version_id:'cv',workflow_id:'cw',parent_run_id:'parent',
   parent_step_id:'child_step',start_state:'started',outcome:'indeterminate'};
 const cp={instance_id:'child',status:'complete',observed_at:900};
 const ce={...empty,steps:[{run_id:'child',step_id:'emit',status:'indeterminate'}]};
 const plan={id:'pv',plan:{steps:[{id:'child_step',uses:'flow.child',with:{workflow_id:'cw',version_id:'cv'}}]}};
 const e={...empty,plan,steps:[{run_id:'parent',step_id:'child_step',status:'indeterminate'}],
   children:[{run:child,native:cp,evidence:ce}],
   childCancellations:[{parent_run_id:'parent',parent_step_id:'child_step',child_run_id:'child',termination_attempted_at:800}]};
 assert.deepEqual(verifyWorkflowTerminalEvidence(parent,native,e),native);
 for(const bad of [
   {...e,children:[]},
   {...e,children:[{run:{...child,outcome:'running'},native:cp,evidence:ce}]},
   {...e,children:[{run:{...child,version_id:'wrong'},native:cp,evidence:ce}]},
   {...e,children:[{run:child,native:{...cp,status:'running'},evidence:ce}]},
   {...e,children:[{run:child,native:cp,evidence:{...ce,callbacks:[{run_id:'child',notification_delivered:0}]}}]},
   {...e,childCancellations:[{...e.childCancellations[0],child_run_id:'wrong'}]},
 ])assert.throws(()=>verifyWorkflowTerminalEvidence(parent,native,bad),/terminal evidence/);
 const cancelledChild={...child,start_state:'cancelled_before_start',outcome:'cancelled',error_code:'cancelled_before_start'};
 const prestart={...e,children:[{run:cancelledChild,native:null,evidence:empty}],childCancellations:[]};
 assert.deepEqual(verifyWorkflowTerminalEvidence(parent,native,prestart),native);
 assert.throws(()=>verifyWorkflowTerminalEvidence(parent,native,{...prestart,children:[{run:cancelledChild,native:null,evidence:ce}]}),/terminal evidence/);
 const detached={...child,start_state:'reserved',outcome:'failed',error_code:'detached_parent_not_active'};
 const detachedPlan={...e.plan,plan:{steps:[{...e.plan.plan.steps[0],with:{...e.plan.plan.steps[0].with,mode:'detached'}}]}};
 assert.deepEqual(verifyWorkflowTerminalEvidence(parent,native,{...prestart,plan:detachedPlan,children:[{run:detached,native:null,evidence:empty}]}),native);
 assert.throws(()=>verifyWorkflowTerminalEvidence(parent,native,{...prestart,children:[{run:detached,native:null,evidence:empty}]}),/terminal evidence/);
 const physicalChild={...child,start_state:'cancelled',outcome:'cancelled',updated_at:900};
 assert.deepEqual(verifyWorkflowTerminalEvidence(parent,native,{...e,children:[{run:physicalChild,native:null,evidence:ce}]}),native);
 assert.throws(()=>verifyWorkflowTerminalEvidence(parent,native,{...e,childCancellations:[],children:[{run:physicalChild,native:null,evidence:ce}]}),/terminal evidence/);
 const saga={...empty,plan:{id:'pv',plan:{saga:{on:['failure']},saga_compensation_approved:true,
   steps:[{id:'session',uses:'github.run',with:{action:{type:'session'}},compensate:{kind:'github.session.cancel'}}]}},
   steps:[{run_id:'parent',step_id:'session',status:'succeeded'},{run_id:'parent',step_id:'__saga_session',status:'requested'}],
   attempts:[{run_id:'parent',step_id:'session',attempt_id:'a',capability_id:'github.action',state:'cancelled',
     candidate_run_id:1,candidate_run_attempt:1,owner_run_id:1,owner_run_attempt:1}],
   sessions:[{run_id:'parent',step_id:'session',state:'terminated'}],
   githubCancellations:[{run_id:'parent',step_id:'session',attempt_id:'a'}]};
 assert.deepEqual(verifyWorkflowTerminalEvidence(parent,native,saga),native);
 for(const bad of [
   {...saga,sessions:[{...saga.sessions[0],state:'stopping'}]},
   {...saga,attempts:[{...saga.attempts[0],state:'claimed'}]},
   {...saga,plan:undefined},
   {...saga,steps:[saga.steps[0],{...saga.steps[1],step_id:'__saga_other'}]},
 ])assert.throws(()=>verifyWorkflowTerminalEvidence(parent,native,bad),/terminal evidence/);
});

test('#1046 source-bound Bark closure requires exact persisted lineage and completed source',async()=>{
 const {verifyWorkflowTerminalEvidence}=await import('./manual-worker-release.mjs');
 const run={id:'r',instance_id:'r',version_id:'v',start_state:'started',outcome:'indeterminate'};
 const native={instance_id:'r',status:'complete',observed_at:1000};
 const digest='a'.repeat(64),version='11111111-1111-4111-8111-111111111111';
 const action={repository:'autoactions/github-actions',repositoryId:1452488311,
  workflowId:413147310,workflowPath:'.github/workflows/ubuntu.yml',ref:'refs/heads/main',type:'session'};
 const attempt={run_id:'r',step_id:'source',attempt_id:'a',state:'cancelled',capability_id:'github.action',
  repository:action.repository,repository_id:String(action.repositoryId),
  workflow_ref:action.repository+'/'+action.workflowPath+'@'+action.ref,ref:action.ref,
  candidate_run_id:42,candidate_run_attempt:1,owner_run_id:42,owner_run_attempt:1};
 const source={id:'source',uses:'github.run',with:{action}};
 const notify={id:'notify',uses:'action.run',needs:['source'],with:{executor:'cloudflare',provider:'bark',
  action:'bark.send_notification',contract_digest:digest,input:{session_step_id:'source'}}};
 const grant={executor:'cloudflare',provider:'bark',action:'bark.send_notification',contract_digest:digest,deployment_id:version};
 const inv={run_id:'r',step_id:'notify',invocation_id:'n',source_attempt_id:'a',deployment_id:version,
  input_digest:digest,contract_digest:digest,binding_generation:0,created_at:10};
 const steps=[{run_id:'r',step_id:'source',status:'succeeded'},{run_id:'r',step_id:'notify',status:'succeeded'}];
 const e={plan:{id:'v',plan:{steps:[source,notify],cloudflare_execution_approved:true,cloudflare_action_approvals:[grant]}},
  steps,attempts:[attempt],sessions:[{run_id:'r',step_id:'source',state:'terminated'}],callbacks:[],
  children:[],invocations:[inv],mcpFences:[],githubCancellations:[],cloudflareCancellations:[],
  childCancellations:[],gates:[],approvals:[],waits:[]};
 assert.deepEqual(verifyWorkflowTerminalEvidence(run,native,e),native);
 for(const bad of [
  {...e,invocations:[{...inv,source_attempt_id:'n'}]},
  {...e,invocations:[{...inv,source_attempt_id:'other'}]},
  {...e,attempts:[{...attempt,repository_id:'99'}]},
  {...e,attempts:[{...attempt,owner_run_id:null,owner_run_attempt:null}]},
  {...e,sessions:[]},
  {...e,plan:{id:'v',plan:{...e.plan.plan,cloudflare_action_approvals:[]}}},
  {...e,steps:[steps[0],{...steps[1],status:'indeterminate'}]},
 ])assert.throws(()=>verifyWorkflowTerminalEvidence(run,native,bad),/terminal evidence/);
 const download={...action,workflowPath:'.github/workflows/download.yml',type:'task'};
 const downloadStep={id:'source',uses:'flow.foreach',with:{max_items:1,template:{id:'task',uses:'github.run',with:{action:download}}}};
 const downloadAttempt={...attempt,step_id:'source_0_task',state:'succeeded',workflow_ref:download.repository+'/'+download.workflowPath+'@'+download.ref};
 const downloadE={...e,plan:{id:'v',plan:{...e.plan.plan,steps:[downloadStep,{...notify,with:{...notify.with,input:{download_step_id:'source'}}}]}},
  steps:[...steps,{run_id:'r',step_id:'source_0_task',status:'succeeded'}],sessions:[],attempts:[downloadAttempt]};
 assert.deepEqual(verifyWorkflowTerminalEvidence(run,native,downloadE),native);
 assert.throws(()=>verifyWorkflowTerminalEvidence(run,native,{...downloadE,attempts:[{...downloadAttempt,step_id:'source'}]}),/terminal evidence/);
 const business={id:'source',uses:'action.run',with:{executor:'cloudflare',provider:'dub',action:'dub.shorten_url',contract_digest:digest}};
 const paired={...e,plan:{id:'v',plan:{...e.plan.plan,steps:[business,{...notify,with:{...notify.with,input:{notification:{body:'Completed'}}}}],
  cloudflare_action_approvals:[grant,{...grant,provider:'dub',action:'dub.shorten_url'}]}},
  attempts:[],sessions:[],invocations:[{...inv,step_id:'source',invocation_id:'p',source_attempt_id:'p'},{...inv,source_attempt_id:'p'}]};
 assert.deepEqual(verifyWorkflowTerminalEvidence(run,native,paired),native);
 assert.throws(()=>verifyWorkflowTerminalEvidence(run,native,{...paired,invocations:[{...paired.invocations[0],source_attempt_id:'n'},paired.invocations[1]]}),/terminal evidence/);
 const cancelled={...e,cloudflareCancellations:[{run_id:'r',step_id:'notify',created_at:20}]};
 assert.deepEqual(verifyWorkflowTerminalEvidence(run,native,cancelled),native);
 const noDispatch={...e,steps:[steps[0]],invocations:[],cloudflareCancellations:[{run_id:'r',step_id:'notify',created_at:20}]};
 const cancelledRun={...run,outcome:'cancelled',error_code:'cloudflare_action_cancel_requested'};
 assert.deepEqual(verifyWorkflowTerminalEvidence(cancelledRun,native,noDispatch),native);
 assert.throws(()=>verifyWorkflowTerminalEvidence(run,native,noDispatch),/terminal evidence/);
});

test('#1046 real D1 projection binds immutable Plan and callback to their owning attempt',async()=>{
 const {readWorkflowTerminalEvidence,verifyWorkflowTerminalEvidence}=await import('./manual-worker-release.mjs');
 const db=new DatabaseSync(':memory:');
 try{
  const dir=new URL('../apps/workflow-mcp-worker/migrations/',import.meta.url);
  const files=readdirSync(dir).filter(f=>/^\d{4}_.+\.sql$/.test(f)).sort();
  for(const name of files.slice(0,22))db.exec(readFileSync(new URL(name,dir),'utf8'));
  db.exec("INSERT INTO workflows(id,name,draft,created_at,updated_at) VALUES('wf','test','{}',1,1)");
  db.prepare("INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES('v','wf','d',?,1)")
    .run(JSON.stringify({steps:[{id:'task',uses:'github.run',with:{action:{type:'task'}}}]}));
  for(const id of ['r','unrelated'])
   db.prepare("INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,start_state,outcome,created_at,updated_at) VALUES(?,'wf','v',?,'d','{}','started','indeterminate',1,2)").run(id,id);
  db.exec("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES('r','task','indeterminate',2)");
  db.exec("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES('unrelated','task','running',2)");
  db.exec("INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,state,repository,repository_id,workflow_ref,ref,candidate_run_id,candidate_run_attempt,owner_run_id,owner_run_attempt,created_at,updated_at) VALUES('a','r','task','github.action','d1','succeeded','owner/repo','1','owner/repo/.github/workflows/test.yml@refs/heads/main','refs/heads/main',1,1,1,1,1,2),('other','unrelated','task','github.action','d2','claimed','owner/repo','1','owner/repo/.github/workflows/test.yml@refs/heads/main','refs/heads/main',2,1,2,1,1,2)");
  db.exec("INSERT INTO callback_receipts(callback_id,attempt_id,outcome,result_json,notification_delivered,created_at) VALUES('c','a','succeeded','{}',1,2),('other-c','other','succeeded','{}',0,2)");
  const query=async(sql,params)=>db.prepare(sql).all(...params);
  const native={instance_id:'r',status:'complete',observed_at:1000};
  const before=await readWorkflowTerminalEvidence(query,'r',{schema:22,observe:async()=>native});
  assert.equal(before.evidence.callbacks.length,1);
  assert.equal(before.evidence.callbacks[0].run_id,'r');
  assert.equal(before.evidence.callbacks[0].step_id,'task');
  assert.equal(before.evidence.plan.id,'v');
  assert.deepEqual(verifyWorkflowTerminalEvidence(before.run,before.native,before.evidence),native);
  await assert.rejects(()=>readWorkflowTerminalEvidence(query,'missing',{schema:22,observe:async()=>native}),/projection/);
  db.exec(readFileSync(new URL(files.at(-1),dir),'utf8'));
  db.prepare("UPDATE runs SET execution_terminal_proof=? WHERE id='r'").run(JSON.stringify(native));
  const after=await readWorkflowTerminalEvidence(query,'r',{schema:23,observe:async()=>{throw Error('unnecessary external query');}});
  assert.deepEqual(after,before);
  db.exec("UPDATE callback_receipts SET notification_delivered=0 WHERE attempt_id='a'");
  const pending=await readWorkflowTerminalEvidence(query,'r',{schema:23});
  assert.throws(()=>verifyWorkflowTerminalEvidence(pending.run,pending.native,pending.evidence),/callback unresolved/);
  // Deliberately corrupt only the isolated fixture to challenge the join.
  db.exec("PRAGMA foreign_keys=OFF; UPDATE workflow_versions SET workflow_id='other-owner' WHERE id='v'");
  await assert.rejects(()=>readWorkflowTerminalEvidence(query,'r',{schema:23}),/projection/);
 }finally{db.close();}
});

test('#1046 release inventory selects actual unresolved evidence, not historical IDs or every settled Run',async()=>{
 const {verifyWorkflowReleaseInventory}=await import('./manual-worker-release.mjs');
 const db=new DatabaseSync(':memory:');
 try{
  const dir=new URL('../apps/workflow-mcp-worker/migrations/',import.meta.url);
  const files=readdirSync(dir).filter(f=>/^\d{4}_.+\.sql$/.test(f)).sort();
  db.exec('CREATE TABLE d1_migrations(name TEXT NOT NULL UNIQUE)');
  for(const name of files){
   db.exec(readFileSync(new URL(name,dir),'utf8'));
   db.prepare('INSERT INTO d1_migrations VALUES(?)').run(name);
  }
  db.exec("INSERT INTO workflows(id,name,draft,created_at,updated_at) VALUES('wf','test','{}',1,1)");
  db.prepare("INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES('v','wf','d',?,1)")
   .run(JSON.stringify({steps:[{id:'session',uses:'github.run',with:{action:{type:'session'}}}]}));
  const add=(id,outcome,proof=null)=>{
   db.prepare("INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,start_state,outcome,created_at,updated_at,execution_terminal_proof) VALUES(?,'wf','v',?,'d','{}','started',?,1,2,?)")
    .run(id,id,outcome,proof?JSON.stringify(proof):null);
   db.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,'session',?,2)").run(id,outcome==='indeterminate'?'indeterminate':'succeeded');
  };
  for(let i=0;i<400;i++)add('settled-'+i,'succeeded');
  const fact={instance_id:'arbitrary-new-unknown',status:'complete',observed_at:1000};
  add(fact.instance_id,'indeterminate',fact);
  add('ready','succeeded');
  db.exec("INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,state,repository,repository_id,workflow_ref,ref,candidate_run_id,candidate_run_attempt,owner_run_id,owner_run_attempt,created_at,updated_at) VALUES('a','ready','session','github.action','d1','claimed','owner/repo','1','owner/repo/.github/workflows/test.yml@refs/heads/main','refs/heads/main',1,1,1,1,1,2)");
  db.exec("INSERT INTO session_executions(run_id,step_id,slot,state,created_at,updated_at) VALUES('ready','session',1,'ready',1,2)");
  const seen=[];
  const query=async(sql,params=[])=>{seen.push({sql,params});return db.prepare(sql).all(...params);};
  const result=await verifyWorkflowReleaseInventory(query,{mode:'compatible',sourceFiles:files,
   observe:async()=>{throw Error('unexpected external observation');}});
  assert.equal(result.schema,23);assert.equal(result.run_count,402);assert.equal(result.ready_sessions,1);
  assert.deepEqual(Object.keys(result.proofs),[fact.instance_id]);
  assert.deepEqual(result.proofs[fact.instance_id],fact);
  assert.equal(seen.filter(q=>q.params.includes(fact.instance_id)).length,1);
  assert(!seen.some(q=>q.params.some(p=>String(p).startsWith('settled-'))));
  await assert.rejects(()=>verifyWorkflowReleaseInventory(query,{mode:'strict',sourceFiles:files}),/terminal evidence/);
  // Model a corrupt/imported physical identity in this isolated fixture.
  db.exec("PRAGMA ignore_check_constraints=ON; UPDATE step_attempts SET owner_run_id=2 WHERE attempt_id='a'; PRAGMA ignore_check_constraints=OFF");
  await assert.rejects(()=>verifyWorkflowReleaseInventory(query,{mode:'compatible',sourceFiles:files}),/terminal evidence/);
  db.exec("UPDATE step_attempts SET owner_run_id=1,state='cancelled' WHERE attempt_id='a'; UPDATE session_executions SET state='terminated' WHERE run_id='ready'");
  assert.equal((await verifyWorkflowReleaseInventory(query,{mode:'strict',sourceFiles:files})).ready_sessions,0);
  db.exec("UPDATE run_steps SET status='cancelled',error_code='unexpected' WHERE run_id='arbitrary-new-unknown'");
  await assert.rejects(()=>verifyWorkflowReleaseInventory(query,{mode:'compatible',sourceFiles:files}),/cancelled Step/);
  db.exec("UPDATE run_steps SET status='indeterminate',error_code=NULL WHERE run_id='arbitrary-new-unknown'");
  db.exec("UPDATE runs SET execution_terminal_proof=NULL WHERE id='arbitrary-new-unknown'");
  await assert.rejects(()=>verifyWorkflowReleaseInventory(query,{mode:'compatible',sourceFiles:files}),/terminal evidence/);
  assert.deepEqual((await verifyWorkflowReleaseInventory(query,{mode:'compatible',sourceFiles:files,observe:async()=>fact})).proofs[fact.instance_id],fact);
  // A settled business result cannot hide an invalid physical identity.
  db.exec("PRAGMA ignore_check_constraints=ON; UPDATE step_attempts SET owner_run_id=2 WHERE attempt_id='a'; PRAGMA ignore_check_constraints=OFF");
  await assert.rejects(()=>verifyWorkflowReleaseInventory(query,{mode:'compatible',sourceFiles:files,
    observe:async r=>({instance_id:r.id,status:'complete',observed_at:1000})}),/Attempt a physical termination or identity unresolved/);
  db.exec("UPDATE step_attempts SET owner_run_id=1 WHERE attempt_id='a'");
  db.exec("DELETE FROM d1_migrations WHERE name='0022_drop_claim_receipts.sql'");
  await assert.rejects(()=>verifyWorkflowReleaseInventory(query,{mode:'compatible',sourceFiles:files}),/inventory|prefix/);
 }finally{db.close();}
});

test('#1046 once-only v22 to v23 proof backfill preserves outcomes and resumes after a lost write receipt',async()=>{
 const {verifyWorkflowReleaseInventory,backfillWorkflowTerminalProofs,workflowReleaseProof}=await import('./manual-worker-release.mjs');
 const db=new DatabaseSync(':memory:');
 try{
  const dir=new URL('../apps/workflow-mcp-worker/migrations/',import.meta.url);
  const files=readdirSync(dir).filter(f=>/^\d{4}_.+\.sql$/.test(f)).sort();
  db.exec('CREATE TABLE d1_migrations(name TEXT NOT NULL UNIQUE)');
  const migrate=name=>{db.exec(readFileSync(new URL(name,dir),'utf8'));db.prepare('INSERT INTO d1_migrations VALUES(?)').run(name);};
  for(const file of files.slice(0,22))migrate(file);
  db.exec("INSERT INTO workflows(id,name,draft,created_at,updated_at) VALUES('wf','test','{}',1,1)");
  db.exec("INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES('v','wf','d','{\"steps\":[]}',1)");
  for(const id of ['a','b']){
   db.prepare("INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,start_state,outcome,error_code,created_at,updated_at) VALUES(?,'wf','v',?,'d','{}','started','indeterminate','execution_interrupted',1,2)").run(id,id);
   db.prepare("INSERT INTO run_steps(run_id,step_id,status,updated_at) VALUES(?,'emit','indeterminate',2)").run(id);
  }
  const snapshot=db.prepare("SELECT id,outcome,start_state,error_code,updated_at FROM runs ORDER BY id").all();
  const stepSnapshot=db.prepare("SELECT * FROM run_steps ORDER BY run_id").all();
  const query=async(sql,params=[])=>db.prepare(sql).all(...params);
  const checks=[];
  const io={query,sourceFiles:files,
   observe:async r=>({instance_id:r.instance_id,status:'complete',observed_at:1000}),
   maintenance:async phase=>checks.push(phase),
   nativeDrain:async ids=>checks.push(ids),
   };
  // The adapter receives sources only for actual recognized history;
  // synthetic current IDs may not perform any external history requests.
  const historyFree={...io,historySources:{githubRun:async()=>{throw Error('history consulted');},
    githubJobs:async()=>{throw Error('history consulted');},providerVersions:async()=>{throw Error('history consulted');}}};
  await assert.rejects(()=>workflowReleaseProof('workflow-check',historyFree,{ACTIONS_INGRESS_QUIESCED:'false'}),/exact v23/);
  await assert.rejects(()=>workflowReleaseProof('workflow-prepare',historyFree,{ACTIONS_INGRESS_QUIESCED:'false'}),/quiescence/);
  assert.deepEqual(checks,[]);
  const prep=await workflowReleaseProof('workflow-prepare',historyFree,{ACTIONS_INGRESS_QUIESCED:'true'});
  assert.deepEqual(checks,['frozen','frozen']);checks.length=0;
  assert.equal(prep.schema,22);
  await assert.rejects(()=>backfillWorkflowTerminalProofs(query,async()=>{throw Error('write before migration');},prep,files),/schema/);
  migrate(files.at(-1));
  let writes=0;
  const interrupted=async(sql,params)=>{writes++;db.prepare(sql).run(...params);throw Error('lost write receipt');};
  await assert.rejects(()=>backfillWorkflowTerminalProofs(query,interrupted,prep,files),/lost write receipt/);
  assert.equal(writes,1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM runs WHERE execution_terminal_proof IS NOT NULL").get().n,1);
  // Reconstructed preparation in a separately authorized forward recovery
  // reads existing facts after an uncertain migration/write receipt.
  const recovery=await workflowReleaseProof('workflow-prepare',historyFree,{ACTIONS_INGRESS_QUIESCED:'true'});
  assert.equal(recovery.schema,23);
  assert.deepEqual(recovery.proofs,prep.proofs);
  const resumed=await backfillWorkflowTerminalProofs(query,async(sql,params)=>{writes++;return Number(db.prepare(sql).run(...params).changes);},recovery,files);
  assert.equal(writes,2,'confirmed existing proof must not be written again');
  assert.equal(resumed.schema,23);
  assert.deepEqual(db.prepare("SELECT id,outcome,start_state,error_code,updated_at FROM runs ORDER BY id").all(),snapshot);
  assert.deepEqual(db.prepare("SELECT * FROM run_steps ORDER BY run_id").all(),stepSnapshot);
  checks.length=0;
  const routine=await workflowReleaseProof('workflow-check',{...historyFree,observe:async()=>{throw Error('persisted proof was not reused');},
   get historySources(){throw Error('normal v23 release entered history adapter');}},{ACTIONS_INGRESS_QUIESCED:'false'});
  assert.deepEqual(routine.proofs,prep.proofs);
  assert.deepEqual(checks,[[]],'ordinary release must independently check native active inventory');
  db.exec("UPDATE runs SET execution_terminal_proof=NULL,updated_at=3 WHERE id='b'");
  await assert.rejects(()=>backfillWorkflowTerminalProofs(query,async()=>{throw Error('must not write changed state');},prep,files),/changed/);
 }finally{db.close();}
});


test('#1046 Session release recognizes definitive rejection and never-dispatched slots, not an unresolved dispatch',async()=>{
 const {verifyWorkflowTerminalEvidence}=await import('./manual-worker-release.mjs');
 const run={id:'r',instance_id:'r',version_id:'v',start_state:'started',outcome:'failed'};
 const native={instance_id:'r',status:'complete',observed_at:1000};
 const attempt={run_id:'r',step_id:'session',attempt_id:'a',capability_id:'github.action',state:'rejected',
  candidate_run_id:null,candidate_run_attempt:null,owner_run_id:null,owner_run_attempt:null};
 const e={steps:[{run_id:'r',step_id:'session',status:'failed',error_code:'github_session_dispatch_rejected'}],
  attempts:[attempt],sessions:[{run_id:'r',step_id:'session',state:'terminated'}],callbacks:[],children:[],
  invocations:[],mcpFences:[],githubCancellations:[],cloudflareCancellations:[],childCancellations:[],gates:[],approvals:[],waits:[]};
 assert.deepEqual(verifyWorkflowTerminalEvidence(run,native,e),native);
 assert.deepEqual(verifyWorkflowTerminalEvidence(run,native,{...e,attempts:[]}),native);
 assert.throws(()=>verifyWorkflowTerminalEvidence(run,native,{...e,attempts:[{...attempt,state:'dispatch_unknown'}]}),/terminal evidence/);
 assert.throws(()=>verifyWorkflowTerminalEvidence(run,native,{...e,attempts:[{...attempt,candidate_run_id:42}]}),/terminal evidence/);
 assert.throws(()=>verifyWorkflowTerminalEvidence(run,native,{...e,sessions:[{...e.sessions[0],state:'starting'}]}),/terminal evidence/);
 assert.throws(()=>verifyWorkflowTerminalEvidence(run,native,{...e,attempts:[],steps:[]}),/terminal evidence/);
});

test('#1046 arbitrary new Task identity can be proven by live physical read and persisted additively, not a historical exception',async()=>{
 const {workflowReleaseProof,backfillWorkflowTerminalProofs,observeRelatedTaskFacts}=await import('./manual-worker-release.mjs');
 const {observeGitHubTaskTerminalFact}=await import('../apps/workflow-mcp-worker/src/github-action-attempt-inspection.ts');
 const {inspectGitHubActionRun}=await import('../apps/workflow-mcp-worker/src/github-action-run-inspection.ts');
 const db=new DatabaseSync(':memory:');
 try{
  const dir=new URL('../apps/workflow-mcp-worker/migrations/',import.meta.url);
  const files=readdirSync(dir).filter(f=>/^\d{4}_.+\.sql$/.test(f)).sort();
  db.exec('CREATE TABLE d1_migrations(name TEXT NOT NULL UNIQUE)');
  for(const name of files){db.exec(readFileSync(new URL(name,dir),'utf8'));db.prepare('INSERT INTO d1_migrations VALUES(?)').run(name);}
  const action={repository:'autoactions/github-actions',repositoryId:1452488311,workflowId:413147310,
   workflowPath:'.github/workflows/download.yml',commitSha:'a'.repeat(40),type:'task',contractDigest:'b'.repeat(64)};
  const ref='refs/heads/main',sha='c'.repeat(40);
  const plan={version:1,name:'Current task',github_execution_approved:true,github_action_approvals:[action],
   steps:[{id:'task',uses:'github.run',needs:[],with:{capability:'github.action',action:{...action,ref,inputs:{}}}}]};
  const id='12345678-1234-4123-8123-123456789abc',attemptId='12345678-1234-4123-8123-123456789def';
  const native={instance_id:id,status:'complete',observed_at:1000};
  db.exec("INSERT INTO workflows(id,name,draft,created_at,updated_at) VALUES('wf','test','{}',1,1)");
  db.prepare("INSERT INTO workflow_versions(id,workflow_id,digest,plan,created_at) VALUES('v','wf','d',?,1)").run(JSON.stringify(plan));
  db.prepare("INSERT INTO runs(id,workflow_id,version_id,instance_id,request_digest,inputs,start_state,outcome,error_code,created_at,updated_at,execution_terminal_proof) VALUES(?,'wf','v',?,'d','{}','started','indeterminate','github_action_native_check_unconfirmed',1,2,?)").run(id,id,JSON.stringify(native));
  db.prepare("INSERT INTO run_steps(run_id,step_id,status,error_code,updated_at) VALUES(?,'task','indeterminate','github_action_native_check_unconfirmed',2)").run(id);
  db.prepare("INSERT INTO step_attempts(attempt_id,run_id,step_id,capability_id,dispatch_id,state,repository,repository_id,workflow_ref,ref,resolved_sha,candidate_run_id,candidate_run_attempt,owner_run_id,owner_run_attempt,created_at,updated_at) VALUES(?,?,'task','github.action','dispatch','claimed',?,?,?,?,?,42,1,42,1,1,2)")
   .run(attemptId,id,action.repository,String(action.repositoryId),action.repository+'/'+action.workflowPath+'@'+ref,ref,sha);
  const query=async(sql,params=[])=>db.prepare(sql).all(...params);
  const rowBefore=db.prepare('SELECT * FROM step_attempts').all();
  const runBefore=db.prepare('SELECT id,outcome,error_code,updated_at FROM runs').all();
  let physicalReads=0,badHead=false;
  const inspect=(p,a)=>observeGitHubTaskTerminalFact(p,a,'test-only',
   (reviewed,r,n,t,f)=>inspectGitHubActionRun(reviewed,r,n,t,f,async()=>{
    physicalReads++;
    return Response.json({id:r,workflow_id:action.workflowId,run_attempt:n,repository:{id:action.repositoryId,full_name:action.repository},
     path:action.workflowPath,head_branch:'main',head_sha:badHead?'d'.repeat(40):sha,
     event:'workflow_dispatch',status:'completed',conclusion:'failure'});
   }),2000);
  const io={query,sourceFiles:files,observe:async()=>{throw Error('native proof already persisted');},
   observeRelated:(r,n,e)=>observeRelatedTaskFacts(r,n,e,inspect),maintenance:async()=>{},
   nativeDrain:async ids=>assert.deepEqual(ids,[]),
   historySources:{githubRun:async()=>{throw Error('historical source not needed');}}};
  badHead=true;
  await assert.rejects(()=>workflowReleaseProof('workflow-check',io,{ACTIONS_INGRESS_QUIESCED:'false'}),/terminal evidence/);
  badHead=false;
  const live=await workflowReleaseProof('workflow-check',io,{ACTIONS_INGRESS_QUIESCED:'false'});
  assert.equal(live.proofs[id].github_attempts[0].attempt_id,attemptId);
  assert.equal(live.proofs[id].github_attempts[0].conclusion,'failure');
  assert.equal(JSON.parse(db.prepare('SELECT execution_terminal_proof AS p FROM runs').get().p).github_attempts,undefined,
   'routine release is read-only');
  const prepared=await workflowReleaseProof('workflow-prepare',io,{ACTIONS_INGRESS_QUIESCED:'true'});
  assert.equal(prepared.schema,23);
  const checked=await backfillWorkflowTerminalProofs(query,async(sql,params)=>Number(db.prepare(sql).run(...params).changes),prepared,files);
  assert.deepEqual(checked.proofs[id],live.proofs[id]);
  const reads=physicalReads;
  await workflowReleaseProof('workflow-check',io,{ACTIONS_INGRESS_QUIESCED:'false'});
  assert.equal(physicalReads,reads,'persisted physical facts require no external query');
  assert.deepEqual(db.prepare('SELECT * FROM step_attempts').all(),rowBefore);
  assert.deepEqual(db.prepare('SELECT id,outcome,error_code,updated_at FROM runs').all(),runBefore);
 }finally{db.close();}
});

test('#1046 historical physical Task evidence uses the existing repository-scoped dispatch credential',async()=>{
 const requests=[];
 const io=workflowReleaseIO({
  CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'cloudflare-test',
  GITHUB_TOKEN:'same-repository-token',WORKFLOW_GITHUB_DISPATCH_TOKEN:'task-dispatch-token'
 },async(url,init)=>{
  requests.push({url,authorization:init.headers.Authorization});
  return Response.json({success:true});
 });
 await io.historySources.githubRun('lirtual/mcp-workers',1);
 await io.historySources.githubRun('lirtual/github-actions',2);
 await io.historySources.githubRun('lirtual/cloudflare-actions',3);
 assert.equal(requests[0].authorization,'Bearer same-repository-token');
 assert.equal(requests[1].authorization,'Bearer task-dispatch-token');
 assert.equal(requests[2].authorization,undefined,
  'the dispatch credential must not cross into the unrelated Cloudflare Actions repository');
 await assert.rejects(()=>workflowReleaseIO({
  CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'cloudflare-test',
  GITHUB_TOKEN:'same-repository-token'
 },async()=>Response.json({success:true})).historySources.githubRun('lirtual/github-actions',2),
 /Historical GitHub Actions read credential unavailable/);
});
