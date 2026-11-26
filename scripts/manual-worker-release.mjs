import {selectWorkflowSchemaRelease} from './workflow-release-schema-selection.mjs';
import {isAuxiliaryBarkPair} from '../apps/workflow-mcp-worker/src/plan.ts';
import {connectionInventory} from '../apps/database-mcp-worker/src/catalog.ts';
import references from '../apps/database-mcp-worker/connection-references.json' with {type:'json'};
function databaseSecretNames(raw) {
  const inventory=Object.values(connectionInventory(raw)).join('\n');
  return references.secrets.filter(name=>inventory.includes('${'+name+'}'));
}
// Narrow, credential-free-to-import Cloudflare release checks for #19.
// Never log API bodies: Workers settings can include runtime plain-text values.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import {checkNativeWorkflowRelease,requireIngressQuiescence} from "./actions-consumer-cutover-gate.mjs";
import {readOnlyPrepare} from "./actions-cutover-prepare.mjs";
import { join } from "node:path";
import { collectWorkerVars, remoteControlClerkIdentity, BROWSER_ACCESS_VARIABLES, browserActivationOrigin, gatewayOriginFromConfig } from "./worker-release-variables.mjs";
import { verifyWorkflowGitHubExecutor,parseVerifiedExecutorIdentity } from "./workflow-github-executor.mjs";
import { discoverBrowserActivationIdentity, verifyBrowserIdentityContinuity } from "./browser-owner-access.mjs";

const WORKERS = new Set(["mcp-gateway-worker", "browser-mcp-worker", "raindrop-mcp-worker", "ima-mcp-worker", "database-mcp-worker", "ssh-mcp-worker", "remote-control-mcp-worker", "github-actions-mcp-worker", "workflow-mcp-worker"]);
export const REQUIRED_SECRETS = {
  "mcp-gateway-worker": ["CLERK_SECRET_KEY", "CF_ACCESS_CLIENT_SECRET"],
  "browser-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "raindrop-mcp-worker": ["MCP_ACCESS_TOKEN", "RAINDROP_ACCESS_TOKEN"],
  "ima-mcp-worker": ["MCP_ACCESS_TOKEN", "IMA_API_KEY"],
  "database-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "ssh-mcp-worker": ["MCP_ACCESS_TOKEN", "SSH_ENCRYPTION_KEY"],
  "remote-control-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "github-actions-mcp-worker": ["MCP_ACCESS_TOKEN", "ACTIONS_GITHUB_DISPATCH_TOKENS"],
  "workflow-mcp-worker": ["MCP_ACCESS_TOKEN", "WORKFLOW_MCP_PORTAL_CLIENT_SECRET", "WORKFLOW_GITHUB_DISPATCH_TOKEN"],
};
// The pre-migration Database runtime defaults are part of the original-value
// contract. A missing legacy Variable means its deployed value was this default.
const DATABASE_LIMIT_MIGRATION = Object.freeze({
  MAX_ROWS: ["DATABASE_MAX_ROWS", 500, 5000],
  MAX_RESULT_BYTES: ["DATABASE_MAX_RESULT_BYTES", 1048576, 8388608],
  MAX_SCHEMA_BYTES: ["DATABASE_MAX_SCHEMA_BYTES", 524288, 4194304],
  QUERY_TIMEOUT_MS: ["DATABASE_QUERY_TIMEOUT_MS", 15000, 60000],
  MAX_WRITE_AFFECTED_ROWS: ["DATABASE_MAX_WRITE_AFFECTED_ROWS", 20, 100],
});

function validDatabaseLimit(value, max) {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value) &&
    Number.isSafeInteger(Number(value)) && Number(value) <= max;
}

// Only the effective selected-Worker variable inputs, never secret bytes.
export function expectedDatabaseLimits(sourceConfig, env) {
  return Object.fromEntries(Object.values(DATABASE_LIMIT_MIGRATION).map(([name, , max]) => {
    const override = env[name];
    const raw = override == null || override === "" ? String(sourceConfig?.vars?.[name] ?? "") : override;
    invariant(validDatabaseLimit(raw, max), "Invalid Database limit release input: " + name);
    return [name, raw];
  }));
}

const WORKER_ENTRIES = {
  "mcp-gateway-worker": "src/worker.ts",
  "browser-mcp-worker": "src/worker.ts",
  "raindrop-mcp-worker": "src/worker.ts",
  "ima-mcp-worker": "src/index.ts",
  "database-mcp-worker": "src/index.ts",
  "ssh-mcp-worker": "src/index.ts",
  "remote-control-mcp-worker": "src/worker.ts",
  "github-actions-mcp-worker": "src/index.ts",
  "workflow-mcp-worker": "src/index.ts",
};

function invariant(value, message) {
  if (!value) throw new Error(message);
}

/** Wrangler and runtime's immutable nonsecret mapping must be identical. */
export function verifyDatabaseHyperdriveSource(conf, manifest) {
  const bindings = conf?.hyperdrive ?? [];
  invariant(Array.isArray(bindings) && bindings.length <= 10 && Array.isArray(manifest) && manifest.length === bindings.length,
    "Database Hyperdrive manifest/source mismatch");
  const names = new Set();
  const ids = new Set();
  for (const binding of bindings) {
    invariant(typeof binding.binding === "string" && /^HYPERDRIVE_[A-Z0-9_]{1,54}$/.test(binding.binding) &&
      typeof binding.id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(binding.id) &&
      !names.has(binding.binding) && !ids.has(binding.id) &&
      manifest.filter(row => row?.binding === binding.binding && row?.id === binding.id).length === 1,
      "Database Hyperdrive binding not uniquely represented in protected release manifest");
    names.add(binding.binding); ids.add(binding.id);
  }
  return true;
}

/** #760: verify the D1-free source and reviewed native bindings before publication. */
export function verifyDatabaseCutoverSource(conf, reviewedManifest) {
  invariant(conf?.name === "database-mcp-worker" &&
    conf.main === "src/index.ts", "Database source identity drift");
  invariant(JSON.stringify(conf.secrets?.required) === JSON.stringify(['MCP_ACCESS_TOKEN']),
    'Database requires only MCP ingress Secret in static source');
  invariant(!conf.d1_databases?.length && !conf.vars?.DATABASE_SETUP_HOST,
    'Database registry and Setup are retired');
  const manifest = reviewedManifest ?? JSON.parse(readFileSync(new URL("../apps/database-mcp-worker/hyperdrive-bindings.json", import.meta.url), "utf8"));
  verifyDatabaseHyperdriveSource(conf, manifest);
  const limit = (name, namespaceId, max) => conf.ratelimits?.some(b =>
    b.name === name && String(b.namespace_id) === namespaceId &&
    Number(b.simple?.limit) === max && Number(b.simple?.period) === 60);
  invariant(conf.ratelimits?.length === 1 &&
    limit("RATE_LIMITER", "1001", 120),
    "Database MCP rate-limit policy must be declared");
  return true;
}

export function verifyBindings(worker, settings, secrets, options = {}) {
  invariant(WORKERS.has(worker), "Release target not enabled");
  const bindings = settings?.bindings;
  invariant(Array.isArray(bindings), "Cloudflare bindings unavailable");
  const find = (name, type) => bindings.find((x) => x.name === name && x.type === type);
  invariant(Array.isArray(secrets), "Cloudflare secret inventory unavailable");
  const secretNames = new Set(secrets.map(x => x.name));
  invariant(secretNames.size === secrets.length &&
    new Set(bindings.map(b => b.name)).size === bindings.length,
    "Duplicate runtime binding or Secret name");
  for (const name of REQUIRED_SECRETS[worker]) {
    // On preflight a missing runtime Secret can be repaired from GitHub.
    // The unconditional Secrets staging step fails closed before deployment.
    // Readback must still prove that every required Secret binding exists.
    if (options.mode !== "preflight" || options.requireExistingSecrets === true) {
      invariant(secretNames.has(name), "Required runtime Secret missing: " + name);
      invariant(!!find(name, "secret_text"), "Required Secret binding missing: " + name);
    }
  }
  if (worker === "mcp-gateway-worker" && options.mode !== "preflight") {
    const expected = new Set([
      "CLERK_SECRET_KEY", "CF_ACCESS_CLIENT_SECRET", "CLERK_PUBLISHABLE_KEY",
      "CLERK_OWNER_USER_ID", "CLERK_ISSUER", "GATEWAY_ORIGIN",
      "PORTAL_MCP_URL", "CF_ACCESS_CLIENT_ID",
    ]);
    invariant(bindings.length === expected.size &&
      bindings.every(b => expected.has(b.name) &&
        b.type === (REQUIRED_SECRETS[worker].includes(b.name) ? "secret_text" : "plain_text")) &&
      secrets.length === REQUIRED_SECRETS[worker].length,
      "Gateway live bindings not equal to reviewed Clerk and Access identities");
  }
  if (worker === "ssh-mcp-worker") {
    invariant(settings.observability?.enabled === true &&
      settings.observability?.logs?.invocation_logs === true,
      "SSH observability and invocation logs must remain enabled");
    const catalog = find("EDGE_SSH_DB", "d1");
    invariant(options.mode === "preflight" || (catalog?.id || catalog?.database_id) === "bd5cfdc5-3db0-4af7-8e95-cbf3d65cfa94",
      "SSH shared EdgeSSH D1 binding missing or changed");
    invariant(find("SSH_OPERATIONS", "durable_object_namespace")?.class_name === "SshOperationsDO",
      "SSH Durable Object binding missing");
    if (options.mode !== "preflight") {
      invariant(!bindings.some((x) => ["EDGE_SSH_BROKER", "SSH_BROKER_TOKEN", "MCP_BROKER_FULL_ACCESS"].includes(x.name)),
        "SSH legacy broker binding or token remains");
    }
  } else {
    const logs = ["remote-control-mcp-worker", "browser-mcp-worker"].includes(worker) ? false : true;
    invariant(settings.observability?.enabled === true &&
      settings.observability?.logs?.invocation_logs === logs,
      "Unexpected Invocation Logs configuration");
  }
  if (worker === "workflow-mcp-worker") {
    // These two nonsecret identities must not change across a pure rename.
    // The GitHub source is read inside the approved selected-Worker release.
    if (typeof options.expectedWorkflowPortalClientId === "string") {
      const names = options.mode === "preflight"
        ? ["MCP_PORTAL_CLIENT_ID", "WORKFLOW_MCP_PORTAL_CLIENT_ID"]
        : ["WORKFLOW_MCP_PORTAL_CLIENT_ID"];
      invariant(!bindings.some(b => names.includes(b.name) && b.type !== "plain_text"),
        "Workflow Portal client identity binding type changed");
      const present = names.map(name => find(name, "plain_text")).filter(Boolean);
      invariant(options.expectedWorkflowPortalClientId.length > 0 && present.length > 0 &&
        present.every(binding => binding.text === options.expectedWorkflowPortalClientId),
        "Workflow Portal client identity differs from existing reviewed value");
    }
    const legacyNames=["GITHUB_ACTION_APPROVED_REPOSITORIES",
      "WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES"];
    const identityName="WORKFLOW_GITHUB_ACTION_IDENTITY";
    const executorBindings=bindings.filter(x=>[...legacyNames,identityName].includes(x.name));
    invariant(executorBindings.length===1 && executorBindings[0].type==="plain_text",
      "Workflow executor deployed baseline missing or ambiguous");
    const deployed=executorBindings[0];
    if (options.mode==="preflight") {
      if(deployed.name===identityName)
        parseVerifiedExecutorIdentity(deployed.text);
      else {
        let history;
        try{history=JSON.parse(deployed.text);}
        catch{throw Error("Workflow historical executor baseline invalid");}
        invariant(Array.isArray(history)&&history.length<=16&&
          history.every(x=>x&&typeof x==="object"&&!Array.isArray(x)&&
            typeof x.repository==="string"&&
            Number.isSafeInteger(x.repositoryId)&&x.repositoryId>0),
          "Workflow historical executor baseline invalid");
      }
      if(options.workflowExecutorBaseline) invariant(
        deployed.name===options.workflowExecutorBaseline.name &&
        deployed.text===options.workflowExecutorBaseline.text,
        "Workflow deployed executor baseline changed before publication");
    } else if (options.mode==="readback") {
      const expected=parseVerifiedExecutorIdentity(options.expectedWorkflowIdentity);
      const actual=parseVerifiedExecutorIdentity(deployed.text);
      invariant(deployed.name===identityName &&
        JSON.stringify(actual)===JSON.stringify(expected),
        "Workflow new executor identity differs from reviewed candidate");
    }
    if (options.mode === "preflight" && options.requireExistingSecrets) {
      invariant(!!find("WORKFLOW_MCP_PORTAL_CLIENT_ID", "plain_text") &&
        !!find("WORKFLOW_MCP_PORTAL_ENDPOINT", "plain_text") &&
        !!find("WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE", "plain_text"),
        "Workflow code-only release blocked until renamed binding cutover");
      invariant(find("WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE", "plain_text")?.text ===
        "workflow-github-action", "Workflow code-only Action OIDC audience drift");
    }
    const d1 = find("DB", "d1");
    const liveD1=d1?.id || d1?.database_id;
    invariant(liveD1==="a4a477cd-6339-478c-ab7c-f7d87bb0d772",
      "Workflow production D1 runtime binding drift");
    const flow = find("WORKFLOW", "workflow");
    if(options.mode==="readback") {
      invariant(flow?.workflow_name==="workflow-mcp-orchestrator" &&
        flow?.class_name==="WorkflowOrchestrator", "Workflow native Workflow binding drift");
    }
    if (options.mode === "readback") {
      invariant(find("WORKFLOW_MCP_PORTAL_ENDPOINT", "plain_text")?.text ===
        "https://mcp-portal.lirtual.dpdns.org/mcp", "Pinned Workflow MCP Portal drift");
      invariant(!bindings.some(x => ["GITHUB_EXECUTOR_REPOSITORY",
        "GITHUB_EXECUTOR_REPOSITORY_ID","GITHUB_EXECUTOR_REF",
        "GITHUB_EXECUTOR_AUDIENCE","GITHUB_TEST_WORKER_NAME",
        "GITHUB_TEST_DEDICATED_EXECUTOR"].includes(x.name)),
        "Retired fixed GitHub executor variables must be removed");
      invariant(find("WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE","plain_text")?.text ===
        "workflow-github-action", "Workflow Action OIDC audience drift");
      for (const name of ["WORKFLOW_MCP_PORTAL_CLIENT_SECRET","WORKFLOW_GITHUB_DISPATCH_TOKEN"]) {
        invariant(secretNames.has(name) && !!find(name,"secret_text"),
          "Workflow runtime credential binding missing: " + name);
      }
      invariant(bindings.filter(x => x.name === "WORKFLOW_MCP_PORTAL_CLIENT_ID").length === 1 &&
        typeof find("WORKFLOW_MCP_PORTAL_CLIENT_ID", "plain_text")?.text === "string" &&
        find("WORKFLOW_MCP_PORTAL_CLIENT_ID", "plain_text").text.trim().length > 0 &&
        !secretNames.has("WORKFLOW_MCP_PORTAL_CLIENT_ID"),
        "Workflow Portal Client ID must be exactly one plaintext Variable");
      invariant(bindings.filter(x=>x.type==='service').length===1 &&
        bindings.filter(x=>x.name==='ACTIONS'&&x.type==='service'&&
          x.service==='cloudflare-actions'&&x.entrypoint==='ActionsEntrypoint').length===1,
        "Workflow reviewed ACTIONS Service Binding drift");
      // The old deployed Consumer can still carry its historic pin during
      // first-cutover preflight. The *new* release readback must remove it.
      invariant(!bindings.some(x => [
        'ACTIONS_DEPLOYMENT_ID', 'WEIXIN_ACTION_DEPLOYMENT_ID',
        'BARK_ACTION_DEPLOYMENT_ID'].includes(x.name)) &&
        !secretNames.has('ACTIONS_DEPLOYMENT_ID'),
        "Workflow legacy Provider deployment pin still present");
      invariant(!bindings.some(x => ["MCP_PORTAL_CLIENT_ID", "MCP_PORTAL_ENDPOINT",
        "GITHUB_ACTION_OIDC_AUDIENCE", "GITHUB_ACTION_APPROVED_REPOSITORIES"].includes(x.name)),
        "Workflow unprefixed runtime Variable remains after publication");
      invariant(!bindings.some(x => ["MCP_CALL_ENABLED","GITHUB_EXECUTION_ENABLED",
        "MCP_DIRECT_TARGETS_ENABLED"].includes(x.name)),
        "Obsolete stage flag present after release");
    }
  }
  if (worker === "github-actions-mcp-worker" && options.mode === "readback") {
    // GitHub PATs alone authorize repositories. No repository lists should
    // survive from the old Worker configuration.
    invariant(!find("GITHUB_REPOS", "plain_text") &&
      !find("GITHUB_REPOS_SECONDARY", "plain_text"),
      "Legacy GitHub Actions repository allowlists must be removed");
    invariant(secretNames.has("ACTIONS_GITHUB_DISPATCH_TOKENS") && !!find("ACTIONS_GITHUB_DISPATCH_TOKENS", "secret_text"),
      "GitHub Actions ACTIONS_GITHUB_DISPATCH_TOKENS Secret binding missing");
  }
  if (worker === "ima-mcp-worker") {
    // During preflight, existing CLIENT_ID Variable may still be present.
    // The selected Worker release stages Repository IMA_CLIENT_ID on publish.
    // Readback MUST confirm the new name and type, with no old binding.
    if (options.mode !== "preflight") {
      const clientId = find("IMA_CLIENT_ID", "plain_text");
      invariant(bindings.filter(x => x.name === "IMA_CLIENT_ID").length === 1 &&
        !bindings.some(x => x.name === "CLIENT_ID") && !secretNames.has("CLIENT_ID"),
        "IMA legacy CLIENT_ID binding must be absent after release");
      invariant(typeof clientId?.text === "string" && clientId.text.trim().length > 0,
        "IMA_CLIENT_ID must be a nonempty plain-text Variable after release");
      invariant(!find("IMA_CLIENT_ID", "secret_text") && !secretNames.has("IMA_CLIENT_ID"),
        "IMA legacy IMA_CLIENT_ID Secret still present after release");
    }
    const durable = find("IMA_IMAGE_REFRESH_SHARD", "durable_object_namespace");
    invariant(durable?.class_name === "ImaImageRefreshShard", "IMA Durable Object missing or class drift");
    invariant(settings.observability?.traces?.enabled === true, "IMA tracing drift");
    invariant(!bindings.some((x) => x.name === "R2_BUCKET"), "Legacy IMA R2 Worker binding remains");
  }
  if (worker === "database-mcp-worker") {
    if (options.mode === 'preflight' && find('DB','d1'))
      invariant((find('DB','d1').id || find('DB','d1').database_id)==='cbfe6a05-4979-4e6a-9cc2-4f6468586e4a',
        'Unexpected legacy Database D1 identity');
    if (options.mode !== 'preflight') {
      invariant(!find('DB','d1') && !find('SETUP_RATE_LIMITER','ratelimit'), 'Retired Database resource binding remains');
      const raw=find('DATABASE_CONNECTIONS','plain_text')?.text;
      invariant(typeof raw==='string' && raw===options.databaseConnections, 'Database logical catalog differs from staged release');
      for (const name of databaseSecretNames(raw))
        invariant(secretNames.has(name) && !!find(name,'secret_text'), 'Database named Secret is missing');
      for (const name of references.variables) {
        if (Object.values(connectionInventory(raw)).some(value=>value.includes('#{'+name+'}')))
          invariant(find(name,'plain_text')?.text===options.databaseVariables?.[name] && typeof options.databaseVariables?.[name]==='string',
            'Database reference Variable differs from staged release');
      }
      const source=options.sourceConfig;
      const expectedHD=source?.hyperdrive??[];
      const actualHD=bindings.filter(b=>b.type==='hyperdrive');
      invariant(actualHD.length===expectedHD.length && expectedHD.every(cfg=>actualHD.some(b=>b.name===cfg.binding && b.id===cfg.id)),
        'Database Hyperdrive binding identity mismatch');
      for (const name of ['DATABASE_SETUP_HOST','ACCESS_TEAM_DOMAIN','OWNER_EMAIL','DATABASE_ACCESS_AUD','ACCESS_AUD','DATABASE_CONFIG','MAX_ROWS','MAX_RESULT_BYTES','MAX_SCHEMA_BYTES','QUERY_TIMEOUT_MS','MAX_WRITE_AFFECTED_ROWS'])
        invariant(!find(name,'plain_text'),'Database old unprefixed or retired Variable remains: '+name);
    }
    const limiter = find("RATE_LIMITER", "ratelimit");
    invariant(limiter && String(limiter.namespace_id) === "1001" &&
      Number(limiter.simple?.limit) === 120 && Number(limiter.simple?.period) === 60,
      "Database RATE_LIMITER binding/policy drift");
  }
  if (worker === "database-mcp-worker" && options.expectedDatabaseLimits) {
    for (const [legacy, [currentName, originalDefault, max]] of Object.entries(DATABASE_LIMIT_MIGRATION)) {
      const expected = options.expectedDatabaseLimits[currentName];
      invariant(validDatabaseLimit(expected, max), "Database limit release input missing: " + currentName);
      for (const name of [legacy, currentName]) {
        invariant(!bindings.some(b => b.name === name && b.type !== "plain_text"),
          "Database limit binding type drift: " + name);
      }
      const oldBinding = find(legacy, "plain_text");
      const newBinding = find(currentName, "plain_text");
      const same = binding => validDatabaseLimit(binding.text, max) && Number(binding.text) === Number(expected);
      if (options.mode === "preflight") {
        invariant((!oldBinding || same(oldBinding)) && (!newBinding || same(newBinding)) &&
          (oldBinding || newBinding || Number(expected) === originalDefault),
          "Database limit migration changes original value: " + currentName);
      } else if (options.mode === "readback") {
        invariant(!!newBinding && same(newBinding),
          "Database limit readback differs from reviewed input: " + currentName);
      }
    }
  }
  if (worker === "remote-control-mcp-worker") {
    const coordinator = find("DEVICE_COORDINATOR", "durable_object_namespace");
    const previous = find("V2_OWNER", "durable_object_namespace");
    // Preflight may inspect the currently deployed Preview-backed v2 or legacy VPC
    // version. Identify the previous namespace from THIS Worker, not from a
    // separate Preview Worker that may already have been deleted.
    const isPreflightPrevious = options.mode === "preflight" && !coordinator &&
      ((previous?.class_name === "V2OwnerCoordinator" &&
        previous?.script_name === "remote-control-v2-preview" &&
        typeof previous.namespace_id === "string") ||
        !!find("REMOTE_CONTROL_DEVICE", "vpc_service"));
    if (!isPreflightPrevious) {
      invariant(coordinator?.class_name === "DeviceCoordinator" &&
        typeof coordinator.namespace_id === "string" &&
        !coordinator.script_name &&
        coordinator.namespace_id !== options.previousNamespaceId,
        "Production must have its own DeviceCoordinator namespace distinct from Preview");
      invariant(!previous && !find("REMOTE_CONTROL_V2_ONLY", "plain_text") &&
        !find("REMOTE_CONTROL_V2_PREVIEW_ONLY", "plain_text"),
        "Production must not retain Preview binding or v1/v2 runtime switches");
      invariant(!bindings.some(x => x.type === "vpc_service" ||
        x.name === "REMOTE_CONTROL_DEVICE"), "Production VPC binding must be absent");
    }
    // Existing production has no Session RPC binding. Permit that only
    // during preflight; the post-deploy inventory must prove the exact private
    // Workflow WorkerEntrypoint and reject wrong or duplicate destinations.
    const sessionRpc=bindings.filter(x=>x.name==="WORKFLOW_SESSION_AUTHORIZATION");
    invariant((options.mode==="preflight" && sessionRpc.length===0) ||
      (sessionRpc.length===1 && sessionRpc[0].type==="service" &&
       sessionRpc[0].service==="workflow-mcp-worker" &&
       sessionRpc[0].entrypoint==="SessionAuthorization"),
      "Remote Control Session Authorization Service Binding missing or drifted");
    // Readback must prove Wrangler deployed the origin derived from the
    // reviewed Custom Domain, not a stale or attacker-controlled Host value.
    if (options.mode === "readback") {
      const route = options.sourceConfig?.routes;
      invariant(Array.isArray(route) && route.length === 1 &&
        route[0]?.custom_domain === true &&
        find("REMOTE_CONTROL_INSTALL_ORIGIN", "plain_text")?.text ===
          "https://" + route[0].pattern,
        "Remote Control installer origin binding differs from Custom Domain");
      const clerkIdentity=options.expectedRcaClerkIdentity;
      invariant(clerkIdentity && ["CLERK_PUBLISHABLE_KEY","CLERK_OWNER_USER_ID"].every(name=>
        typeof clerkIdentity[name]==="string" && find(name,"plain_text")?.text===clerkIdentity[name]),
        "Remote Control shared Clerk public identity binding differs from release source");
      invariant(!bindings.some(x => x.name?.startsWith("BROWSER_APPROVAL_")),
        "Retired Remote Control approval bindings must be removed");
    }
  }
  if (worker === "browser-mcp-worker") {
    const coordinator = find("BROWSER_OWNER", "durable_object_namespace");
    const assets = find("ASSETS", "assets");
    // The existing published Worker has no Assets binding. Preserve that
    // namespace through preflight, but require exact Assets after deployment.
    invariant(!bindings.some(b => b.name === "ASSETS" && b.type !== "assets") &&
      (options.mode !== "readback" || !!assets),
      "Browser public Assets binding missing or changed");
    // Transition preflight accepts only the previously reviewed legacy Review
    // variables; the new published Worker must have none of them.
    const legacyReview = ["BROWSER_APPROVAL_ORIGIN", "BROWSER_ACCESS_AUDIENCE",
      "BROWSER_APPROVAL_ISOLATION"];
    const names = BROWSER_ACCESS_VARIABLES;
    const legacyPresent = legacyReview.filter(name => !!find(name, "plain_text"));
    invariant(options.mode !== "preflight" || legacyPresent.length === 0 ||
      legacyPresent.length === legacyReview.length,
      "Browser legacy Review binding inventory incomplete");
    if (legacyPresent.length) {
      invariant(options.mode === "preflight",
        "Retired Browser Review bindings remain after publication");
      invariant(find("BROWSER_APPROVAL_ORIGIN", "plain_text")?.text === "https://browser.lirtual.dpdns.org" &&
        /^[a-f0-9]{64}$/.test(find("BROWSER_ACCESS_AUDIENCE", "plain_text")?.text ?? "") &&
        find("BROWSER_APPROVAL_ISOLATION", "plain_text")?.text === "isolated-owner-profile-and-mailbox-v1",
        "Browser legacy Review binding inventory drift");
    }
    const runtimeNames = [...names, "BROWSER_REMEMBERED_IDLE_DAYS"];
    const env = Object.fromEntries(runtimeNames.filter(name => !!find(name, "plain_text"))
      .map(name => [name, find(name, "plain_text").text]));
    if (options.mode === "preflight") {
      const identity=options.browserIdentity;
      invariant(identity && identity.accountId && identity.appId &&
        identity.teamDomain===options.sharedAccessTeamDomain &&
        identity.ownerEmail===options.sharedOwnerEmail &&
        identity.audience===options.expectedBrowserActivationAudience &&
        identity.origin===browserActivationOrigin(options.sourceConfig),
        "Browser discovered identity baseline missing");
      // Independently read the *active production* bindings, not just the
      // newly discovered API response. No implicit trust-boundary migration.
      invariant(names.every(name=>typeof env[name]==="string") &&
        env.BROWSER_ACCESS_ISSUER==="https://"+identity.teamDomain &&
        env.BROWSER_OWNER_EMAIL===identity.ownerEmail &&
        env.BROWSER_ACTIVATION_ORIGIN===identity.origin &&
        env.BROWSER_ACTIVATION_AUDIENCE===identity.audience,
        "Browser active production identity differs from discovered candidate");
    }
    if (options.mode === "readback") {
      const staged = collectWorkerVars("browser-mcp-worker", {
        ACCESS_TEAM_DOMAIN: options.sharedAccessTeamDomain,
        OWNER_EMAIL: options.sharedOwnerEmail,
        BROWSER_ACTIVATION_AUDIENCE: options.expectedBrowserActivationAudience,
        BROWSER_REMEMBERED_IDLE_DAYS: options.expectedBrowserRememberedDays,
      }, { config: options.sourceConfig });
      const expected = Object.fromEntries(staged.map(pair => [
        pair.slice(0, pair.indexOf(":")), pair.slice(pair.indexOf(":") + 1)]));
      invariant(JSON.stringify(Object.entries(env).sort()) ===
        JSON.stringify(Object.entries(expected).sort()),
        "Browser live bindings differ from reviewed identity, route or audience");
      invariant(legacyPresent.length === 0, "Retired Browser Review bindings remain after publication");
    }
    const activationFields = ["BROWSER_ACTIVATION_ORIGIN", "BROWSER_ACTIVATION_AUDIENCE"];
    const activationCount = activationFields.filter(name => Object.hasOwn(env, name)).length;
    invariant(activationCount === 0 || activationCount === activationFields.length,
      "Browser activation binding inventory incomplete");
    invariant(coordinator?.class_name === "BrowserOwner" &&
      typeof coordinator.namespace_id === "string" && coordinator.namespace_id.length > 0 &&
      !coordinator.script_name && bindings.length === 2 + Object.keys(env).length + legacyPresent.length + (assets ? 1 : 0) &&
      !!find("MCP_ACCESS_TOKEN", "secret_text") &&
      !bindings.some(b => b.type === "plain_text" && !runtimeNames.includes(b.name) &&
        !(options.mode === "preflight" && legacyReview.includes(b.name))),
      "Browser binding inventory drift");
    invariant(settings.observability?.logs?.head_sampling_rate === 0,
      "Browser logs sampling must remain zero");
    if (options.mode === "readback" && options.browserNamespaceId)
      invariant(coordinator.namespace_id === options.browserNamespaceId,
        "Browser namespace changed; preserve pairing and Unknown receipts");
  }
  const allowed = new Set(worker === "browser-mcp-worker" ? ["BROWSER_OWNER", "ASSETS"] : worker === "workflow-mcp-worker"
    ? (options.mode === "preflight" ? ["DB", "WORKFLOW", "WORKFLOW_LEGACY", "WEIXIN_ACTION_PROVIDER", "BARK_ACTION_PROVIDER", "ACTIONS"] : ["DB", "WORKFLOW", "ACTIONS"]) :
    worker === "ima-mcp-worker"
    ? ["IMA_IMAGE_REFRESH_SHARD"]
    : worker === "database-mcp-worker"
      ? ["RATE_LIMITER", ...(options.mode === "preflight" ? ["SETUP_RATE_LIMITER", "DB"] : []), ...((options.sourceConfig?.hyperdrive ?? []).map(x => x.binding))]
      : worker === "ssh-mcp-worker" ? (options.mode === "preflight" ? ["EDGE_SSH_BROKER", "EDGE_SSH_DB", "SSH_OPERATIONS"] : ["EDGE_SSH_DB", "SSH_OPERATIONS"])
      : worker === "remote-control-mcp-worker"
        ? (options.mode === "preflight"
          ? ["DEVICE_COORDINATOR", "V2_OWNER", "REMOTE_CONTROL_DEVICE", "WORKFLOW_SESSION_AUTHORIZATION"]
          : ["DEVICE_COORDINATOR", "WORKFLOW_SESSION_AUTHORIZATION"]) : []);
  if (worker === "workflow-mcp-worker" && options.mode === "readback") {
    invariant(bindings.filter(x=>x.name === "ACTIONS").length === 1 &&
      find("ACTIONS", "service")?.service === "cloudflare-actions" &&
      find("ACTIONS", "service")?.entrypoint === "ActionsEntrypoint",
      "Workflow unified Actions Service Binding missing or drifted after release");
  }
  for (const item of bindings) {
    if (!["plain_text", "secret_text"].includes(item.type)) {
      // Source manifest controls the new bindings; a production preflight may
      // still observe bindings that this release is about to remove.
      // Readback strictly verifies that no extra resource binding survives.
      if (!(worker === "workflow-mcp-worker" && options.mode === "preflight" && item.type === "service") &&
          !(worker === "database-mcp-worker" && options.mode === "preflight" && item.type === "hyperdrive"))
        invariant(allowed.has(item.name), "Unexpected production resource binding: " + item.name);
    }
  }
  if (options.mode === "readback" && ["database-mcp-worker", "ssh-mcp-worker", "workflow-mcp-worker"].includes(worker)) {
    const workflowDropSecrets = worker === "workflow-mcp-worker"
      ? ["WORKFLOW_GITHUB_DROP_PUBLIC_KEY", "WORKFLOW_GITHUB_DROP_RECEIPT_PRIVATE_KEY"] : [];
    const allowedSecrets = new Set([...REQUIRED_SECRETS[worker],
      ...workflowDropSecrets,
      ...(worker === "database-mcp-worker" ? references.secrets : [])]);
    invariant(secrets.every(b => allowedSecrets.has(b.name) && !!find(b.name, "secret_text")) &&
      bindings.filter(b => b.type === "secret_text").every(b => allowedSecrets.has(b.name)),
      "Unexpected runtime Secret name or type after publication");
    if (workflowDropSecrets.some(name => secretNames.has(name) || bindings.some(binding => binding.name === name)))
      invariant(workflowDropSecrets.every(name => secretNames.has(name) && !!find(name, "secret_text")),
        "Workflow Drop Secrets must be a complete pair");

  }
  return true;
}

// Fail closed before any production Worker deployment.
export function verifyWorkflowReleaseConfig(conf) {
  invariant(conf?.name === "workflow-mcp-worker" && conf.main === "src/index.ts",
    "Workflow source identity drift");
  invariant(conf.keep_vars === false && conf.workers_dev === false &&
    conf.preview_urls === false && conf.routes?.length === 1 &&
    conf.routes[0]?.pattern === "workflow.lirtual.dpdns.org" &&
    conf.routes[0]?.custom_domain === true, "Workflow reviewed public route drift");
  invariant(conf.observability?.enabled === true &&
    conf.observability?.logs?.invocation_logs === true, "Workflow Invocation Logs drift");
  invariant(conf.d1_databases?.length === 1 &&
    conf.d1_databases[0]?.binding === "DB" &&
    conf.d1_databases[0]?.database_name === "workflow-mcp-db" &&
    conf.d1_databases[0]?.database_id === "a4a477cd-6339-478c-ab7c-f7d87bb0d772" &&
    conf.d1_databases[0]?.migrations_dir === "migrations", "Workflow approved production D1 drift");
  invariant(conf.workflows?.length === 1 &&
    conf.workflows[0]?.binding === "WORKFLOW" &&
    conf.workflows[0]?.name === "workflow-mcp-orchestrator" &&
    conf.workflows[0]?.class_name === "WorkflowOrchestrator",
    "Workflow binding drift");
  invariant(conf.services?.length === 1 &&
    conf.services[0]?.binding === "ACTIONS" &&
    conf.services[0]?.service === "cloudflare-actions" &&
    conf.services[0]?.entrypoint === "ActionsEntrypoint" &&
    Object.keys(conf.services[0]).sort().join(",")==="binding,entrypoint,service",
    "Workflow reviewed Cloudflare Service Bindings drift");
  invariant(JSON.stringify(conf.secrets?.required) === JSON.stringify(["MCP_ACCESS_TOKEN", "WORKFLOW_MCP_PORTAL_CLIENT_SECRET", "WORKFLOW_GITHUB_DISPATCH_TOKEN"]),
    "Workflow Portal Secret declaration drift");
  invariant(!conf.vars || Object.keys(conf.vars).length===0,
    "Workflow MCP source cannot declare runtime feature flags");
  invariant(!(conf.compatibility_flags || []).includes("global_fetch_strictly_public"),
    "Workflow must never enable or import MCP dynamic-target behavior");
  return true;
}

/** Verify the first #1046 terminal-evidence slice independently of schema or
 * business result. The caller supplies a complete, identity-scoped D1
 * projection and a trusted native observation; this is not a release permit.
 * Additional dependency-specific evidence must be checked before integration
 * into the protected release entry point.
 */
export function verifyWorkflowTerminalEvidence(run,native,evidence) {
  const require=(condition,reason)=>invariant(condition,
    'Workflow terminal evidence blocked for '+String(run?.id??'unknown')+': '+reason);
  require(run?.id && run.instance_id && run.start_state==='started' &&
    ['succeeded','failed','cancelled','indeterminate'].includes(run.outcome),'Run execution unresolved');
  require(native?.instance_id===run.instance_id &&
    ['complete','errored','terminated'].includes(native?.status) &&
    Number.isSafeInteger(native.observed_at) && native.observed_at>0,'native terminal observation unavailable or mismatched');
  const keys=['steps','attempts','sessions','callbacks','children','invocations','mcpFences',
    'githubCancellations','cloudflareCancellations','childCancellations','gates','approvals','waits'];
  require(keys.every(key=>Array.isArray(evidence?.[key])),'incomplete D1 projection');
  for(const key of keys.filter(k=>k!=='children'&&k!=='childCancellations'))
    require(evidence[key].every(row=>row.run_id===run.id),key+' identity mismatch');
  if(native.no_dispatch_step_id){
    // The historical failed MCP invocation was independently proven never
    // dispatched. Its stale running Step is not physical activity.
    require(native.status==='errored'&&run.outcome==='indeterminate'&&
      run.error_code==='execution_interrupted'&&native.historical_source&&
      evidence.steps.length===1&&evidence.steps[0].step_id===native.no_dispatch_step_id&&
      evidence.steps[0].status==='running'&&evidence.steps[0].error_code===null&&
      keys.filter(key=>key!=='steps').every(key=>evidence[key].length===0),
      'no-dispatch Step identity or related execution unresolved');
  }else{
    require(evidence.steps.every(step=>['succeeded','failed','skipped','cancelled','indeterminate'].includes(step.status)||
      (step.step_id.startsWith('__saga_')&&step.status==='requested')),
      'Step execution unresolved');
  }
  for(const step of evidence.steps.filter(s=>s.status==='cancelled'))
    require(run.outcome==='cancelled'&&run.error_code===step.error_code&&
      ['approval_cancel_requested','event_wait_cancel_requested'].includes(step.error_code),
      'cancelled Step '+step.step_id+' lacks its authoritative cancellation result');
  const positive=n=>Number.isSafeInteger(n)&&n>0;
  let claimedProofUsed=false;
  for(const attempt of evidence.attempts){
    require(evidence.steps.some(step=>step.step_id===attempt.step_id),'Attempt Step identity mismatch');
    if(attempt.state==='rejected'){
      require(attempt.candidate_run_id===null&&attempt.candidate_run_attempt===null&&
        attempt.owner_run_id===null&&attempt.owner_run_attempt===null,'rejected Attempt has a physical identity');
      continue;
    }
    if(attempt.state==='claimed'&&native.github_attempt){
      const fact=native.github_attempt;
      // This is a physical Task proof, not a signed result alone. It is
      // bound to the unchanged registered Attempt and delivered receipt.
      require(!claimedProofUsed&&attempt.capability_id==='github.action'&&
        fact.attempt_id===attempt.attempt_id&&fact.repository_id===attempt.repository_id&&
        positive(fact.run_id)&&positive(fact.run_attempt)&&
        fact.run_id===attempt.candidate_run_id&&fact.run_id===attempt.owner_run_id&&
        fact.run_attempt===attempt.candidate_run_attempt&&fact.run_attempt===attempt.owner_run_attempt&&
        typeof fact.workflow_ref==='string'&&fact.workflow_ref===attempt.workflow_ref&&
        fact.workflow_ref.endsWith('@'+attempt.ref)&&/^[0-9a-f]{40}$/.test(fact.head_sha)&&
        (attempt.resolved_sha===null||fact.head_sha===attempt.resolved_sha)&&
        fact.conclusion==='success'&&positive(fact.observed_at)&&
        !evidence.sessions.some(s=>s.step_id===attempt.step_id)&&
        evidence.callbacks.some(c=>c.attempt_id===attempt.attempt_id&&c.step_id===attempt.step_id&&
          c.outcome==='succeeded'&&c.notification_delivered===1),
        'claimed Attempt '+attempt.attempt_id+' physical proof or delivered receipt unresolved');
      claimedProofUsed=true;
      continue;
    }
    require(['succeeded','failed','cancelled'].includes(attempt.state)&&
      positive(attempt.candidate_run_id)&&positive(attempt.candidate_run_attempt)&&
      ((attempt.owner_run_id===attempt.candidate_run_id&&attempt.owner_run_attempt===attempt.candidate_run_attempt)||
        (attempt.state!=='succeeded'&&attempt.owner_run_id===null&&attempt.owner_run_attempt===null)),
      'Attempt '+attempt.attempt_id+' physical termination or identity unresolved');
  }
  require(!native.github_attempt||claimedProofUsed,'GitHub physical proof has no matching claimed Attempt');
  for(const session of evidence.sessions){
    // The runtime releases rejected dispatches and reservations never dispatched
    // as well as physically terminated Sessions. All existing Attempts were
    // independently checked above; rejected means no physical identity.
    const attempts=evidence.attempts.filter(a=>a.step_id===session.step_id);
    require(session.state==='terminated'&&
      attempts.every(a=>a.capability_id==='github.action')&&
      (attempts.length>0||evidence.steps.some(s=>s.step_id===session.step_id)),
      'Session '+session.step_id+' physical termination unresolved');
  }
  require(evidence.callbacks.every(c=>c.notification_delivered===1&&
    evidence.attempts.some(a=>a.attempt_id===c.attempt_id&&a.step_id===c.step_id&&a.state!=='rejected')),'callback unresolved');
  // Cancellation records are durable one-shot intents, not physical evidence.
  // The matching terminal Attempt (and Session if present) was checked above.
  for(const cancellation of evidence.githubCancellations)
    require(evidence.attempts.some(a=>a.attempt_id===cancellation.attempt_id&&
      a.step_id===cancellation.step_id&&a.capability_id==='github.action'&&
      ['succeeded','failed','cancelled'].includes(a.state)),
      'GitHub cancellation '+cancellation.step_id+' physical termination unresolved');
  if(native.retired_invocation){
    const fact=native.retired_invocation, invocation=evidence.invocations[0];
    require(native.historical_source&&evidence.invocations.length===1&&
      typeof fact.invocation_id==='string'&&fact.invocation_id===invocation.invocation_id&&
      typeof fact.deployment_id==='string'&&fact.deployment_id===invocation.deployment_id&&
      positive(fact.retirement_release_id)&&positive(fact.observed_at)&&
      evidence.steps.some(step=>step.step_id===invocation.step_id&&step.status==='indeterminate')&&
      (invocation.source_attempt_id===invocation.invocation_id||
       evidence.attempts.some(a=>a.attempt_id===invocation.source_attempt_id&&
         ['succeeded','failed','cancelled'].includes(a.state))),
      'retired invocation identity or execution proof unresolved');
  }
  const plannedStep=id=>{
    const plan=evidence.plan?.plan;
    require(evidence.plan?.id===run.version_id&&Array.isArray(plan?.steps),'immutable Plan unavailable or mismatched');
    const step=plan.steps.find(s=>s.id===id);
    require(step,'related Plan Step '+id+' missing');
    return step;
  };
  const receipt=id=>evidence.steps.find(s=>s.step_id===id);
  // A completed Bark notification can reference a closed GitHub Session,
  // completed Download Task, or the preceding Provider receipt. Bind that
  // reference to the actual immutable Plan and persisted source identity.
  const sourceMatches=(invocation,step)=>{
    const plan=evidence.plan.plan;
    const input=step.with.input;
    const sessionId=input?.session_step_id,downloadId=input?.download_step_id;
    if(step.with.provider==='bark'&&step.with.action==='bark.send_notification'){
      if(sessionId!==undefined&&downloadId!==undefined)return false;
      const sourceId=sessionId??downloadId;
      if(sourceId!==undefined){
        if(typeof sourceId!=='string'||!step.needs?.includes(sourceId)||receipt(sourceId)?.status!=='succeeded')return false;
        const source=plannedStep(sourceId);
        const download=downloadId!==undefined;
        const actual=download?source.with?.template:source;
        const pinned=actual?.with?.action;
        if(download?(source.uses!=='flow.foreach'||source.with.max_items!==1||actual?.uses!=='github.run'||
          pinned?.type!=='task'||pinned.workflowPath!=='.github/workflows/download.yml'):
          (source.uses!=='github.run'||pinned?.type!=='session'))return false;
        const actualId=download?sourceId+'_0_'+actual.id:sourceId;
        const attempt=evidence.attempts.find(a=>a.attempt_id===invocation.source_attempt_id);
        return attempt?.step_id===actualId&&attempt.capability_id==='github.action'&&
          positive(attempt.owner_run_id)&&positive(attempt.owner_run_attempt)&&
          attempt.owner_run_id===attempt.candidate_run_id&&attempt.owner_run_attempt===attempt.candidate_run_attempt&&
          attempt.repository===pinned.repository&&String(attempt.repository_id)===String(pinned.repositoryId)&&
          attempt.workflow_ref===pinned.repository+'/'+pinned.workflowPath+'@'+pinned.ref&&attempt.ref===pinned.ref&&
          receipt(actualId)?.status==='succeeded'&&
          (download?attempt.state==='succeeded':evidence.sessions.some(s=>s.step_id===actualId&&s.state==='terminated'));
      }
      if(isAuxiliaryBarkPair(plan.steps)&&plan.steps[1].id===step.id){
        const source=plan.steps[0];
        return receipt(source.id)?.status==='succeeded'&&evidence.invocations.some(i=>
          i.step_id===source.id&&i.invocation_id===invocation.source_attempt_id&&
          i.contract_digest===source.with.contract_digest);
      }
    }
    return invocation.source_attempt_id===invocation.invocation_id;
  };
  if(!native.retired_invocation)for(const invocation of evidence.invocations){
    const step=plannedStep(invocation.step_id),plan=evidence.plan.plan;
    const result=receipt(invocation.step_id);
    const rejection={bark:'bark_rejected',dub:'dub_rejected',envshare:'envshare_rejected',litterbox:'litterbox_rejected'}[step.with?.provider];
    // Persisted success, or a failed Step written after a matched rejected
    // response, proves that the synchronous call ended. Lost responses do not.
    const rejected=result?.status==='failed'&&
      [rejection,'cloudflare_provider_rejected','selected_file_provider_rejected',
        ].filter(Boolean).includes(result.error_code);
    require(step.uses==='action.run'&&step.with?.executor==='cloudflare'&&
      plan.cloudflare_execution_approved===true&&plan.cloudflare_action_approvals?.some(g=>
        g.executor==='cloudflare'&&g.provider===step.with.provider&&g.action===step.with.action&&g.contract_digest===step.with.contract_digest)&&
      typeof invocation.invocation_id==='string'&&invocation.invocation_id.length>0&&
      typeof invocation.deployment_id==='string'&&invocation.deployment_id.length>0&&
      invocation.binding_generation===0&&/^[a-f0-9]{64}$/.test(invocation.contract_digest)&&
      invocation.contract_digest===step.with.contract_digest&&
      (result?.status==='succeeded'||rejected)&&sourceMatches(invocation,step),
      'invocation '+invocation.step_id+' requires related terminal evidence');
  }
  for(const cancellation of evidence.cloudflareCancellations){
    const step=plannedStep(cancellation.step_id);
    require(step.uses==='action.run'&&step.with?.executor==='cloudflare'&&positive(cancellation.created_at)&&
      (evidence.invocations.some(i=>i.step_id===step.id)||
       (run.outcome==='cancelled'&&run.error_code==='cloudflare_action_cancel_requested'&&
        (!receipt(step.id)||['cancelled','skipped','failed'].includes(receipt(step.id).status)))),
      'Cloudflare cancellation '+step.id+' physical termination unresolved');
  }
  for(const fence of evidence.mcpFences){
    const step=plannedStep(fence.step_id),result=receipt(fence.step_id);
    const plan=evidence.plan.plan;
    const generation=step.uses==='mcp.call'?(plan.mcp_connection_generation??0):
      step.uses==='http.request'?(plan.http_connection_generation??0):null;
    require(Number.isSafeInteger(generation)&&generation>=0&&fence.generation===generation&&
      (result?.status==='succeeded'||(step.uses==='http.request'&&
        ['GET','HEAD'].includes(step.with?.method)&&result?.status==='failed'&&
        ['http_response_error','http_redirect_rejected'].includes(result.error_code))),
      'external call '+fence.step_id+' requires related terminal evidence');
  }
  for(const gate of evidence.gates){
    const step=plannedStep(gate.step_id),result=receipt(gate.step_id);
    const approval=evidence.approvals.find(a=>a.step_id===gate.step_id);
    require(step.uses==='github.run'&&step.approval?.required===true&&
      gate.version_id===run.version_id&&positive(gate.deadline_at)&&
      (approval?.decision==='approved'?positive(approval.consumed_at)&&
        ['succeeded','failed','cancelled'].includes(result?.status):
        result?.status==='failed'&&['approval_denied','approval_timeout'].includes(result.error_code)),
      'runtime approval '+gate.step_id+' unresolved');
  }
  for(const approval of evidence.approvals)
    require(approval.version_id===run.version_id&&
      evidence.gates.some(g=>g.step_id===approval.step_id&&g.version_id===approval.version_id)&&
      ['approved','denied'].includes(approval.decision),'runtime approval identity mismatch');
  for(const wait of evidence.waits)
    require(plannedStep(wait.step_id).uses==='flow.wait_event'&&
      receipt(wait.step_id)?.status==='succeeded','event wait '+wait.step_id+' unresolved');
  for(const step of evidence.steps.filter(s=>s.step_id.startsWith('__saga_'))){
    const source=step.step_id.slice('__saga_'.length);
    const planned=plannedStep(source),plan=evidence.plan.plan;
    require(plan.saga_compensation_approved===true&&
      plan.saga?.on?.includes(run.outcome==='cancelled'?'cancel':'failure')&&
      ['failed','cancelled','indeterminate'].includes(run.outcome)&&
      planned.uses==='github.run'&&planned.with?.action?.type==='session'&&
      planned.compensate?.kind==='github.session.cancel'&&receipt(source)?.status==='succeeded'&&
      evidence.sessions.some(s=>s.step_id===source&&s.state==='terminated')&&
      evidence.attempts.some(a=>a.step_id===source&&a.capability_id==='github.action'&&
        ['succeeded','failed','cancelled'].includes(a.state)),
      'Saga '+source+' physical compensation unresolved');
  }
  // Child Plans cannot recursively create another child. Verify the exact
  // child lineage and its own evidence, not the parent's dispatch ACK.
  for(const child of evidence.children){
    const row=child?.run;
    require(row?.id&&row.id!==run.id&&row.parent_run_id===run.id&&
      row.instance_id===row.id&&row.parent_step_id&&
      Array.isArray(child.evidence?.children)&&child.evidence.children.length===0,
      'child lineage unresolved');
    const step=plannedStep(row.parent_step_id);
    require(step.uses==='flow.child'&&step.with?.workflow_id===row.workflow_id&&
      step.with?.version_id===row.version_id&&receipt(step.id),'child Plan identity mismatch');
    require(evidence.children.filter(c=>c.run?.parent_step_id===step.id).length===1,'duplicate child lineage');
    // These exact D1 states are themselves authoritative: reservation
    // abandoned before the dispatch CAS, or a confirmed native terminate.
    const beforeStart=row.start_state==='cancelled_before_start'&&row.outcome==='cancelled'&&
      row.error_code==='cancelled_before_start'&&step.with?.mode!=='detached';
    const detachedAbandoned=row.start_state==='reserved'&&row.outcome==='failed'&&
      row.error_code==='detached_parent_not_active'&&step.with?.mode==='detached';
    if(beforeStart||detachedAbandoned){
      require(child.native===null&&keys.every(k=>Array.isArray(child.evidence[k])&&child.evidence[k].length===0)&&
        !evidence.childCancellations.some(c=>c.child_run_id===row.id),
        'child pre-dispatch closure conflicts with related evidence');
    }else if(row.start_state==='cancelled'){
      require(row.outcome==='cancelled'&&positive(row.updated_at)&&
        evidence.childCancellations.some(c=>c.child_run_id===row.id&&c.parent_step_id===step.id),
        'child confirmed termination identity unavailable');
      // child-cancel.ts writes this state only after native status=terminated.
      // Keep the actual closure and related receipt checks; no new API read.
      require(!child.native||(child.native.instance_id===row.instance_id&&child.native.status==='terminated'),
        'child native termination conflicts with D1');
      verifyWorkflowTerminalEvidence({...row,start_state:'started'},
        child.native??{instance_id:row.instance_id,status:'terminated',observed_at:row.updated_at},child.evidence);
    }else verifyWorkflowTerminalEvidence(row,child.native,child.evidence);
  }
  for(const cancellation of evidence.childCancellations)
    require(cancellation.parent_run_id===run.id&&evidence.children.some(c=>
      c.run.id===cancellation.child_run_id&&c.run.parent_step_id===cancellation.parent_step_id),
      'child cancellation physical termination unresolved');
  return {instance_id:run.instance_id,status:native.status,observed_at:native.observed_at,
    ...(native.historical_source?{historical_source:native.historical_source}:{}),
    ...(claimedProofUsed?{github_attempt:native.github_attempt}:{}),
    ...(native.no_dispatch_step_id?{no_dispatch_step_id:native.no_dispatch_step_id}:{}),
    ...(native.retired_invocation?{retired_invocation:native.retired_invocation}:{})};
}

// Read the complete related execution from one D1 statement. Only identity,
// lifecycle facts and the immutable Plan are projected; result payloads, Run inputs, signed
// claims and session URLs never enter this release verifier.
const terminalProjectionTables={
 steps:['run_steps','run_id,step_id,status,error_code'],
 attempts:['step_attempts','run_id,step_id,attempt_id,capability_id,state,repository,repository_id,workflow_ref,ref,resolved_sha,candidate_run_id,candidate_run_attempt,owner_run_id,owner_run_attempt'],
 sessions:['session_executions','run_id,step_id,state'],
 invocations:['cloudflare_action_invocations','run_id,step_id,invocation_id,source_attempt_id,input_digest,binding_generation,contract_digest,deployment_id,created_at'],
 mcpFences:['mcp_dispatch_fences','run_id,step_id,generation'],
 githubCancellations:['github_action_cancellations','run_id,step_id,attempt_id'],
 cloudflareCancellations:['cloudflare_action_cancellations','run_id,step_id,created_at'],
 gates:['runtime_approval_gates','run_id,step_id,version_id,deadline_at'],
 approvals:['runtime_approvals','run_id,step_id,version_id,decision,created_at,consumed_at'],
 waits:['wait_event_receipts','run_id,step_id,last_sent_at'],
};
const jsonRows=(sql,columns)=>'(SELECT json_group_array(json_object('+
 columns.split(',').map(c=>"'"+c+"',"+c).join(',')+')) FROM ('+sql+'))';
const runProjection='r.id,r.workflow_id,r.version_id,r.instance_id,r.start_state,r.outcome,r.error_code,r.parent_run_id,r.parent_step_id,r.updated_at';
function workflowTerminalProjectionSql(schema){
 invariant(schema===22||schema===23,'Unknown terminal evidence projection schema');
 const fields=Object.entries(terminalProjectionTables).map(([key,[table,columns]])=>
   jsonRows('SELECT '+columns+' FROM '+table+' WHERE run_id=r.id',columns)+' AS '+key);
 fields.push(jsonRows('SELECT a.run_id,a.step_id,c.attempt_id,c.outcome,c.notification_delivered FROM callback_receipts c JOIN step_attempts a ON a.attempt_id=c.attempt_id WHERE a.run_id=r.id','run_id,step_id,attempt_id,outcome,notification_delivered')+' AS callbacks');
 fields.push(jsonRows('SELECT parent_run_id,parent_step_id,child_run_id,termination_attempted_at FROM child_cancellations WHERE parent_run_id=r.id','parent_run_id,parent_step_id,child_run_id,termination_attempted_at')+' AS childCancellations');
 fields.push(jsonRows('SELECT id FROM runs WHERE parent_run_id=r.id','id')+' AS children');
 return 'SELECT '+runProjection+',v.plan AS immutable_plan,'+
   (schema===23?'r.execution_terminal_proof':'NULL')+' AS execution_terminal_proof,'+fields.join(',')+
   ' FROM runs r JOIN workflow_versions v ON v.id=r.version_id AND v.workflow_id=r.workflow_id WHERE r.id=?';
}
/** Schema 22 is used only in the single pre-cutover read. Schema 23 uses
 * persisted facts, falling back to an authenticated observation if absent.
 * A malformed or conflicting saved fact is never replaced by a guess. */
export async function readWorkflowTerminalEvidence(query,id,{schema,observe,depth=0}){
 invariant(typeof id==='string'&&id.length>0&&depth<=1,'Workflow terminal evidence projection invalid lineage');
 const rows=await query(workflowTerminalProjectionSql(schema),[id]);
 invariant(Array.isArray(rows)&&rows.length===1&&rows[0]?.id===id,'Workflow terminal evidence projection missing or ambiguous: '+id);
 const row=rows[0],run=Object.fromEntries(runProjection.split(',').map(c=>c.slice(2)).map(c=>[c,row[c]]));
 const parse=(field)=>{
   try{return JSON.parse(row[field]);}catch{throw Error('Workflow terminal evidence projection invalid '+field+' for '+id);}
 };
 const evidence={plan:{id:row.version_id,plan:parse('immutable_plan')}};
 for(const key of [...Object.keys(terminalProjectionTables),'callbacks','childCancellations','children']){
   const value=parse(key);
   invariant(Array.isArray(value),'Workflow terminal evidence projection incomplete '+key+' for '+id);
   evidence[key]=value;
 }
 invariant(depth===0||evidence.children.length===0,'Workflow terminal evidence projection nested child unsupported');
 evidence.children=await Promise.all(evidence.children.map(c=>readWorkflowTerminalEvidence(query,c.id,{schema,observe,depth:depth+1})));
 const native=row.execution_terminal_proof===null?(observe&&run.start_state==='started'?await observe(run,evidence):null):parse('execution_terminal_proof');
 return {run,native,evidence};
}

// Discover only executions requiring proof beyond the existing settled D1
// lifecycle. The Ready exception is an exact per-Session/Attempt relation,
// never an aggregate count that could mask an unrelated claimed Attempt.
function workflowReleaseInventorySql(mode){
 const ready=mode==='compatible'?`
  SELECT s.run_id,s.step_id,a.attempt_id FROM session_executions s
  JOIN runs r ON r.id=s.run_id
  JOIN run_steps st ON st.run_id=s.run_id AND st.step_id=s.step_id
  JOIN step_attempts a ON a.run_id=s.run_id AND a.step_id=s.step_id
  WHERE r.start_state='started' AND r.outcome='succeeded' AND st.status='succeeded'
    AND s.state='ready' AND a.state='claimed' AND a.capability_id='github.action'
    AND a.candidate_run_id>0 AND a.candidate_run_attempt>0
    AND a.owner_run_id=a.candidate_run_id AND a.owner_run_attempt=a.candidate_run_attempt
    AND NOT EXISTS(SELECT 1 FROM github_action_cancellations c WHERE c.attempt_id=a.attempt_id)
    AND NOT EXISTS(SELECT 1 FROM step_attempts x WHERE x.run_id=a.run_id
      AND x.step_id=a.step_id AND x.attempt_id<>a.attempt_id)`:
  'SELECT run_id,step_id,attempt_id FROM step_attempts WHERE 0';
 const tables=Object.values(terminalProjectionTables).map(([table])=>table);
 const orphans=tables.map(t=>"SELECT count(*) AS n FROM "+t+" x WHERE NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=x.run_id)")
  .concat([
   "SELECT count(*) AS n FROM callback_receipts c WHERE NOT EXISTS(SELECT 1 FROM step_attempts a WHERE a.attempt_id=c.attempt_id)",
   "SELECT count(*) AS n FROM child_cancellations c WHERE NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=c.child_run_id AND r.parent_run_id=c.parent_run_id AND r.parent_step_id=c.parent_step_id)",
   "SELECT count(*) AS n FROM runs r WHERE r.parent_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runs p WHERE p.id=r.parent_run_id AND p.parent_run_id IS NULL)",
   "SELECT count(*) AS n FROM runs r WHERE NOT EXISTS(SELECT 1 FROM workflow_versions v WHERE v.id=r.version_id AND v.workflow_id=r.workflow_id)"
  ]).map(sql=>'('+sql+')').join(' + ');
 return `WITH ready AS (${ready}), candidates AS (
  SELECT DISTINCT coalesce(r.parent_run_id,r.id) AS id FROM runs r
  WHERE r.outcome IS NULL OR r.outcome NOT IN ('succeeded','failed','cancelled')
    OR r.start_state IS NULL OR r.start_state NOT IN ('started','cancelled_before_start','cancelled')
    OR EXISTS(SELECT 1 FROM run_steps s WHERE s.run_id=r.id AND
      (s.status IS NULL OR s.status NOT IN ('succeeded','failed','skipped','cancelled') OR
       (s.status='cancelled' AND (r.outcome IS NOT 'cancelled' OR r.error_code IS NOT s.error_code
        OR r.error_code IS NULL OR r.error_code NOT IN ('approval_cancel_requested','event_wait_cancel_requested')))))
    OR EXISTS(SELECT 1 FROM step_attempts a WHERE a.run_id=r.id AND
      (a.state IS NULL OR a.state NOT IN ('rejected','succeeded','failed','cancelled')) AND
      NOT EXISTS(SELECT 1 FROM ready q WHERE q.attempt_id=a.attempt_id))
    OR EXISTS(SELECT 1 FROM step_attempts a WHERE a.run_id=r.id AND
      (NOT EXISTS(SELECT 1 FROM run_steps st WHERE st.run_id=a.run_id AND st.step_id=a.step_id)
       OR (a.state='rejected' AND (a.candidate_run_id IS NOT NULL OR a.candidate_run_attempt IS NOT NULL
         OR a.owner_run_id IS NOT NULL OR a.owner_run_attempt IS NOT NULL))
       OR (a.state IN ('succeeded','failed','cancelled') AND
         (a.candidate_run_id IS NULL OR a.candidate_run_attempt IS NULL OR a.candidate_run_id<=0 OR a.candidate_run_attempt<=0
          OR NOT ((a.owner_run_id IS a.candidate_run_id AND a.owner_run_attempt IS a.candidate_run_attempt)
            OR (a.state<>'succeeded' AND a.owner_run_id IS NULL AND a.owner_run_attempt IS NULL))))))
    OR EXISTS(SELECT 1 FROM github_action_cancellations c WHERE c.run_id=r.id AND
      NOT EXISTS(SELECT 1 FROM step_attempts a WHERE a.run_id=c.run_id AND a.step_id=c.step_id
        AND a.attempt_id=c.attempt_id AND a.capability_id='github.action' AND a.state IN ('succeeded','failed','cancelled')))
    OR EXISTS(SELECT 1 FROM session_executions s WHERE s.run_id=r.id AND
      (s.state IS NULL OR s.state<>'terminated') AND
      NOT EXISTS(SELECT 1 FROM ready q WHERE q.run_id=s.run_id AND q.step_id=s.step_id))
    OR EXISTS(SELECT 1 FROM callback_receipts c JOIN step_attempts a ON a.attempt_id=c.attempt_id
      WHERE a.run_id=r.id AND (c.notification_delivered IS NOT 1 OR a.state='rejected'))
    OR EXISTS(SELECT 1 FROM cloudflare_action_invocations i WHERE i.run_id=r.id AND
      (NOT EXISTS(SELECT 1 FROM run_steps st WHERE st.run_id=i.run_id AND st.step_id=i.step_id
        AND (st.status='succeeded' OR (st.status='failed' AND st.error_code IN
          ('bark_rejected','dub_rejected','envshare_rejected','litterbox_rejected','weixin_rejected',
           'cloudflare_provider_rejected','selected_file_provider_rejected')))) OR
       (i.source_attempt_id<>i.invocation_id AND
        NOT EXISTS(SELECT 1 FROM step_attempts a WHERE a.run_id=i.run_id AND a.attempt_id=i.source_attempt_id) AND
        NOT EXISTS(SELECT 1 FROM cloudflare_action_invocations a WHERE a.run_id=i.run_id AND a.invocation_id=i.source_attempt_id))))
    OR EXISTS(SELECT 1 FROM mcp_dispatch_fences f WHERE f.run_id=r.id AND
      NOT EXISTS(SELECT 1 FROM run_steps st WHERE st.run_id=f.run_id AND st.step_id=f.step_id AND st.status='succeeded'))
    OR EXISTS(SELECT 1 FROM runtime_approval_gates g WHERE g.run_id=r.id AND
      (g.version_id<>r.version_id OR NOT EXISTS(SELECT 1 FROM run_steps st
        WHERE st.run_id=g.run_id AND st.step_id=g.step_id AND st.status IN ('succeeded','failed','cancelled'))))
    OR EXISTS(SELECT 1 FROM runtime_approvals a WHERE a.run_id=r.id AND
      NOT EXISTS(SELECT 1 FROM runtime_approval_gates g WHERE g.run_id=a.run_id AND g.step_id=a.step_id AND g.version_id=a.version_id))
    OR EXISTS(SELECT 1 FROM wait_event_receipts w WHERE w.run_id=r.id AND
      NOT EXISTS(SELECT 1 FROM run_steps st WHERE st.run_id=w.run_id AND st.step_id=w.step_id AND st.status='succeeded'))
    OR EXISTS(SELECT 1 FROM cloudflare_action_cancellations c WHERE c.run_id=r.id AND
      NOT EXISTS(SELECT 1 FROM cloudflare_action_invocations i WHERE i.run_id=c.run_id AND i.step_id=c.step_id)
      AND NOT (r.outcome='cancelled' AND r.error_code='cloudflare_action_cancel_requested'))
 )
 SELECT (SELECT count(*) FROM runs) AS run_count,
   (SELECT count(*) FROM ready) AS ready_sessions,
   (SELECT json_group_array(instance_id) FROM (SELECT DISTINCT r.instance_id FROM ready q JOIN runs r ON r.id=q.run_id ORDER BY r.instance_id)) AS ready_instances,
   (${orphans}) AS orphan_count,
   (SELECT count(*) FROM candidates) AS candidate_count,
   (SELECT json_group_array(id) FROM (SELECT id FROM candidates ORDER BY id)) AS candidate_ids`;
}

// Only the deployed v22 baseline and the target v23 are supported. The
// migration registry alone does not prove that its structural effects exist.
async function verifyTerminalReleaseSchema(query,schema){
 const tables=['workflows','workflow_versions','runs','run_steps','callback_receipts','step_attempts',
  'session_executions','github_action_cancellations','child_cancellations','wait_event_receipts',
  'cloudflare_action_invocations','cloudflare_action_cancellations','runtime_approval_gates',
  'runtime_approvals','portal_connection_auth','mcp_dispatch_fences','http_connection_auth',
  'cloudflare_action_gate','drop_claim_receipts'];
 const columns={runs:['native_complete_seen_at','capacity_weight','parent_run_id','parent_step_id'],
  session_executions:['session_url','fixed_key','rca_duration_minutes'],step_attempts:['resolved_sha'],
  workflows:['deleted_at'],child_cancellations:['termination_attempted_at']};
 const checks=[...tables.map(t=>"(SELECT count(*) FROM sqlite_master WHERE type='table' AND name='"+t+"')=1"),
  ...Object.entries(columns).flatMap(([t,cols])=>cols.map(c=>"(SELECT count(*) FROM pragma_table_info('"+t+"') WHERE name='"+c+"')=1")),
  "(SELECT count(*) FROM sqlite_master WHERE type='table' AND name='session_runtime_data')=0",
  "(SELECT count(*) FROM sqlite_master WHERE type='index' AND name='session_active_fixed_keys')=1",
  "(SELECT count(*) FROM sqlite_master WHERE type='index' AND name='runs_one_awaited_child_per_step')=1",
  "(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name='runs_top_level_capacity_guard')=1",
  "(SELECT count(*) FROM pragma_table_info('runs') WHERE name='execution_terminal_proof' AND type='TEXT' AND [notnull]=0)="+(schema===23?1:0),
  "(SELECT count(*) FROM pragma_table_info('runs') WHERE name='execution_terminal_proof')="+(schema===23?1:0)];
 const rows=await query('SELECT ('+checks.join(' AND ')+') AS schema_ok',[]);
 invariant(Array.isArray(rows)&&rows.length===1&&rows[0].schema_ok===1,'Workflow exact v'+schema+' schema structure drift');
}

/** D1 half of the release gate. Strict callers additionally prove ingress
 * stopped and native drain; compatible callers retain only exact Ready
 * sessions. This function does not mutate evidence or authorize deployment. */
export async function verifyWorkflowReleaseInventory(query,{mode,sourceFiles,observe}){
 invariant(mode==='strict'||mode==='compatible','Unsupported Workflow release operation');
 const migrations=await query('SELECT name FROM d1_migrations ORDER BY name',[]);
 const selection=selectWorkflowSchemaRelease([{success:true,results:migrations}],sourceFiles);
 invariant(selection.source===23&&(selection.applied===23||mode==='strict'&&selection.applied===22),
   'Workflow terminal evidence schema inventory unsupported');
 const schema=selection.applied;
 await verifyTerminalReleaseSchema(query,schema);
 const rows=await query(workflowReleaseInventorySql(mode),[]);
 const row=rows?.[0];
 invariant(Array.isArray(rows)&&rows.length===1&&
   ['run_count','ready_sessions','orphan_count','candidate_count'].every(k=>Number.isSafeInteger(row?.[k])&&row[k]>=0)&&
   row.orphan_count===0,'Workflow terminal evidence inventory incomplete or orphaned');
 let ids;
 try{ids=JSON.parse(row.candidate_ids);}catch{throw Error('Workflow terminal evidence candidate inventory malformed');}
 invariant(Array.isArray(ids)&&ids.length===row.candidate_count&&
   ids.every(id=>typeof id==='string'&&id.length>0)&&new Set(ids).size===ids.length,
   'Workflow terminal evidence candidate inventory incomplete');
 let readyInstances;
 try{readyInstances=JSON.parse(row.ready_instances);}catch{throw Error('Workflow Ready instance inventory malformed');}
 invariant(Array.isArray(readyInstances)&&readyInstances.length<=row.ready_sessions&&
  (row.ready_sessions===0||readyInstances.length>0)&&readyInstances.every(id=>typeof id==='string'&&id.length>0)&&
  new Set(readyInstances).size===readyInstances.length,'Workflow Ready instance inventory incomplete');
 const proofs=[],targets=[];
 const collect=(projected,fact)=>{
   if(projected.run.start_state==='started'){
     proofs.push([projected.run.id,fact]);
     targets.push([projected.run.id,projected.run]);
   }
   for(const child of projected.evidence.children)
     if(child.run.start_state==='started')
       collect(child,verifyWorkflowTerminalEvidence(child.run,child.native,child.evidence));
 };
 for(const id of ids){
   const projected=await readWorkflowTerminalEvidence(query,id,{schema,observe});
   collect(projected,verifyWorkflowTerminalEvidence(projected.run,projected.native,projected.evidence));
 }
 return {schema,run_count:row.run_count,ready_sessions:row.ready_sessions,ready_instances:readyInstances,
   proofs:Object.fromEntries(proofs),targets:Object.fromEntries(targets)};
}

// Only used in the authorized one-time migration window. Revalidate every
// candidate and its identity against the prepared evidence after v23 exists,
// then CAS the missing facts. A lost response stops immediately; a later
// explicitly authorized forward recovery can read and skip matching facts.
export async function backfillWorkflowTerminalProofs(query,write,prepared,sourceFiles){
 invariant([22,23].includes(prepared?.schema)&&prepared.ready_sessions===0&&prepared.proofs&&prepared.targets,
  'Workflow backfill requires verified strict cutover preparation');
 const current=await verifyWorkflowReleaseInventory(query,{mode:'strict',sourceFiles,
  observe:async run=>Object.hasOwn(prepared.proofs,run.id)?prepared.proofs[run.id]:null});
 invariant(current.schema===23,'Workflow proof backfill requires migrated v23 schema');
 invariant(current.run_count===prepared.run_count&&current.ready_sessions===0&&
   JSON.stringify(current.proofs)===JSON.stringify(prepared.proofs)&&
   JSON.stringify(current.targets)===JSON.stringify(prepared.targets),
   'Workflow execution evidence changed after preparation');
 for(const [id,fact] of Object.entries(prepared.proofs)){
   const r=prepared.targets[id];
   const identity=[r.id,r.instance_id,r.version_id,r.start_state,r.outcome,r.error_code,r.updated_at];
   const predicate='id=? AND instance_id=? AND version_id=? AND start_state=? AND outcome=? AND error_code IS ? AND updated_at=?';
   const lookup=async()=>{
     const rows=await query('SELECT execution_terminal_proof FROM runs WHERE '+predicate,identity);
     invariant(Array.isArray(rows)&&rows.length===1,'Workflow backfill target changed: '+id);
     return rows[0].execution_terminal_proof;
   };
   const expected=JSON.stringify(fact);
   const existing=await lookup();
   if(existing!==null){
     invariant(existing===expected,'Workflow backfill proof conflict: '+id);
     continue;
   }
   const changed=await write('UPDATE runs SET execution_terminal_proof=? WHERE '+predicate+
     ' AND execution_terminal_proof IS NULL',[expected,...identity]);
   invariant(changed===1,'Workflow backfill conditional write unconfirmed: '+id);
   invariant(await lookup()===expected,'Workflow backfill independent readback failed: '+id);
 }
 const checked=await verifyWorkflowReleaseInventory(query,{mode:'strict',sourceFiles});
 invariant(checked.schema===23&&checked.run_count===prepared.run_count&&
   JSON.stringify(checked.proofs)===JSON.stringify(prepared.proofs)&&
   JSON.stringify(checked.targets)===JSON.stringify(prepared.targets),
   'Workflow proof backfill final inventory changed');
 return checked;
}

export function parseWranglerVersion(output) {
  const uuid = '([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})';
  const patterns = [new RegExp('(?:Current )?Version ID:\\s*' + uuid, 'gi'),
    new RegExp('Success! Created version\\s+' + uuid + '\\s+with\\s+\\d+\\s+secrets?', 'gi')];
  const ids = patterns.flatMap(pattern => [...output.matchAll(pattern)].map(match => match[1].toLowerCase()));
  invariant(ids.length > 0 && ids.every(id => id === ids[0]),
    "Wrangler did not report a unique release Version ID");
  return ids[0];
}

export function activeVersion(deployments) {
  const deployment = deployments?.deployments?.[0];
  const versions = deployment?.versions;
  invariant(Array.isArray(versions) && versions.length === 1 &&
    versions[0]?.percentage === 100 && typeof versions[0]?.version_id === "string",
    "Active Worker version is not an unambiguous 100% release");
  return { deployment_id: deployment.id, version_id: versions[0].version_id };
}

export function verifyPublishedVersion(previous, observed, expected) {
  invariant(typeof expected === "string" &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(expected),
    "Expected Wrangler version ID missing or malformed");
  invariant(observed.version_id.toLowerCase() === expected.toLowerCase(),
    "Active Worker version does not match the Wrangler-published version");
  if (previous.mode !== "bootstrap") {
    invariant(previous.version_id !== observed.version_id &&
      previous.deployment_id !== observed.deployment_id, "Active Worker version did not change");
  }
  return true;
}

export function readConfiguration(worker, content, reviewedManifest) {
  const conf = JSON.parse(content.replace(/^\s*\/\/.*$/gm, ""));
  if (worker === "workflow-mcp-worker") verifyWorkflowReleaseConfig(conf);
  if (worker === "database-mcp-worker") verifyDatabaseCutoverSource(conf, reviewedManifest);
  invariant(conf.name === worker && conf.main === WORKER_ENTRIES[worker],
    "Worker script name or entry differs from selected target");
  invariant(conf.keep_vars === false,
    "GitHub/Wrangler must own all runtime Variables; keep_vars must be false");
  if (worker === "mcp-gateway-worker") {
    invariant(conf.workers_dev === false && conf.preview_urls === false &&
      gatewayOriginFromConfig(conf).startsWith("https://") &&
      JSON.stringify(conf.secrets?.required) === JSON.stringify(["CLERK_SECRET_KEY", "CF_ACCESS_CLIENT_SECRET"]) &&
      !conf.vars && !conf.durable_objects && !conf.d1_databases,
      "Gateway release origin, secrets or resource boundaries drifted");
  }
  if (worker === "ssh-mcp-worker") {
    invariant(conf.observability?.enabled === true &&
      conf.observability?.logs?.invocation_logs === true,
      "SSH observability and invocation logs must stay enabled");
  } else {
    const logs = ["remote-control-mcp-worker", "browser-mcp-worker"].includes(worker) ? false : true;
    invariant(conf.observability?.logs?.invocation_logs === logs,
      "Source Invocation Logs setting differs from production");
  }
  invariant(REQUIRED_SECRETS[worker].every((s) => conf.secrets?.required?.includes(s)),
    "Source required Secret names changed unexpectedly");
  if (worker === "ima-mcp-worker") {
    invariant(!conf.secrets?.required?.includes("IMA_CLIENT_ID"),
      "IMA IMA_CLIENT_ID must be provided as a Variable, not a Secret");
    invariant(conf.durable_objects?.bindings?.some((b) =>
      b.name === "IMA_IMAGE_REFRESH_SHARD" && b.class_name === "ImaImageRefreshShard") &&
      conf.exports?.ImaImageRefreshShard?.storage === "sqlite", "IMA SQLite Durable Object must remain");
    invariant(!conf.r2_buckets?.length, "Obsolete IMA R2 Worker binding still declared");
    invariant(conf.observability?.traces?.enabled === true, "IMA production tracing must be declared");
  }
  if (worker === "database-mcp-worker") {
    invariant(conf.ratelimits?.some((b) => b.name === "RATE_LIMITER" &&
      String(b.namespace_id) === "1001" && Number(b.simple?.limit) === 120 &&
      Number(b.simple?.period) === 60), "Source RATE_LIMITER policy changed");
  }
  if (worker === "ssh-mcp-worker") {
    invariant(conf.workers_dev === true && conf.preview_urls === false, "SSH public route drift");
    invariant(!conf.services?.length, "SSH must not retain EdgeSSH Broker Service Binding");
    invariant(conf.d1_databases?.length === 1 &&
      conf.d1_databases[0]?.binding === "EDGE_SSH_DB" &&
      conf.d1_databases[0]?.database_id === "bd5cfdc5-3db0-4af7-8e95-cbf3d65cfa94",
      "SSH shared EdgeSSH D1 configuration drift");
    invariant(conf.durable_objects?.bindings?.length === 1 &&
      conf.durable_objects.bindings[0].name === "SSH_OPERATIONS" &&
      conf.durable_objects.bindings[0].class_name === "SshOperationsDO" &&
      conf.migrations?.[0]?.tag === "v1" &&
      conf.migrations[0].new_sqlite_classes?.includes("SshOperationsDO"), "SSH SQLite DO migration drift");
    invariant(!conf.vars?.MCP_BROKER_FULL_ACCESS,
      "SSH must be broker-only and read-only by default");
  }
  if (worker === "remote-control-mcp-worker") {
    invariant(JSON.stringify(conf.services)===JSON.stringify([{
      binding:"WORKFLOW_SESSION_AUTHORIZATION",
      service:"workflow-mcp-worker",entrypoint:"SessionAuthorization",
    }]),"Remote Control reviewed Session Service Binding drift");
    invariant(!conf.vars?.REMOTE_CONTROL_V2_ONLY &&
      !conf.vars?.REMOTE_CONTROL_V2_PREVIEW_ONLY &&
      !conf.vpc_services && conf.preview_urls === false,
      "Production must have no runtime mode switch or VPC");
    const bindings = conf.durable_objects?.bindings;
    invariant(Array.isArray(bindings) && bindings.length === 1 &&
      bindings[0]?.name === "DEVICE_COORDINATOR" &&
      bindings[0]?.class_name === "DeviceCoordinator" &&
      !bindings[0]?.script_name &&
      conf.exports?.DeviceCoordinator?.storage === "sqlite",
      "Production must declare a local SQLite DeviceCoordinator");
  }
  if (worker === "browser-mcp-worker") {
    invariant(Object.keys(conf).every(k=>["$schema","name","main","compatibility_date","compatibility_flags","workers_dev","preview_urls","keep_vars","durable_objects","migrations","observability","secrets","routes","assets"].includes(k)) &&
      conf.workers_dev === false && conf.preview_urls === false &&
      JSON.stringify(conf.assets) === JSON.stringify({
        directory:"./.build/public",binding:"ASSETS",run_worker_first:true,
        html_handling:"none",not_found_handling:"none"}) &&
      JSON.stringify(conf.compatibility_flags) === JSON.stringify(["nodejs_compat"]) &&
      !conf.vars && !conf.services?.length && !conf.d1_databases?.length &&
      !conf.kv_namespaces?.length && !conf.r2_buckets?.length && !conf.workflows?.length &&
      !conf.vpc_services && !conf.ratelimits?.length &&
      JSON.stringify(conf.durable_objects?.bindings) === JSON.stringify([
        {name:"BROWSER_OWNER",class_name:"BrowserOwner"}]) &&
      JSON.stringify(conf.migrations) === JSON.stringify([
        {tag:"browser-v1",new_sqlite_classes:["BrowserOwner"]}]) &&
      JSON.stringify(conf.secrets?.required) === JSON.stringify(["MCP_ACCESS_TOKEN"]) &&
      conf.observability?.enabled === true && conf.observability.logs.head_sampling_rate === 0,
      "Browser source resource or persistence drift");
  }
  return conf;
}

async function cfListRead(path, token) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  invariant(response.ok, "Workflow private Fixture route inventory HTTP " + response.status);
  const data = await response.json();
  invariant(data?.success === true && Array.isArray(data.result),
    "Workflow private Fixture route inventory missing");
  invariant((data.result_info?.total_pages ?? 1) <= 1 &&
    (!data.result_info?.total_count || data.result_info.total_count <= data.result.length),
    "Workflow private Fixture route inventory incomplete");
  return data.result;
}

async function cfGet(account, worker, token, endpoint) {
  const url = "https://api.cloudflare.com/client/v4/accounts/" +
    encodeURIComponent(account) + "/workers/scripts/" + encodeURIComponent(worker) + endpoint;
  const response = await fetch(url, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  invariant(response.ok, "Cloudflare read-only " + endpoint + " HTTP " + response.status);
  const document = await response.json();
  invariant(document?.success === true && document?.result != null,
    "Cloudflare read-only " + endpoint + " failed");
  return document.result;
}

export async function scriptExists(account, worker, token, transport = fetch) {
  const url = "https://api.cloudflare.com/client/v4/accounts/" +
    encodeURIComponent(account) + "/workers/scripts?per_page=100";
  const response = await transport(url, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  invariant(response.ok, "Cloudflare script inventory HTTP " + response.status);
  const document = await response.json();
  invariant(document?.success === true && Array.isArray(document.result),
    "Cloudflare script inventory unavailable");
  invariant(!document.result_info?.total_count ||
    document.result_info.total_count <= document.result.length, "Cloudflare inventory incomplete");
  return document.result.some((item) => item.id === worker);
}

const EXECUTOR_BINDING_NAMES=new Set([
  "GITHUB_ACTION_APPROVED_REPOSITORIES",
  "WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES",
  "WORKFLOW_GITHUB_ACTION_IDENTITY"
]);
/** Compare the real active Version resources, not mutable Worker Settings
 * (which may reflect a separate undeployed version candidate).
 */
export function verifyWorkflowActiveExecutorBaseline(settingsBindings,activeVersionBindings) {
  const single=rows=>{
    invariant(Array.isArray(rows),"Workflow active executor inventory unavailable");
    const matching=rows.filter(x=>EXECUTOR_BINDING_NAMES.has(x.name));
    invariant(matching.length===1 && matching[0].type==="plain_text" &&
      typeof matching[0].text==="string",
      "Workflow active executor inventory missing or ambiguous");
    return {name:matching[0].name,text:matching[0].text};
  };
  const configured=single(settingsBindings);
  const active=single(activeVersionBindings);
  invariant(configured.name===active.name && configured.text===active.text,
    "Workflow active Version and Settings executor baseline differ");
  return active;
}

async function current(account, worker, token, options) {
  const [settings, secrets, deployments, scriptSettings] = await Promise.all([
    cfGet(account, worker, token, "/settings"),
    cfGet(account, worker, token, "/secrets"),
    cfGet(account, worker, token, "/deployments?per_page=1"),
    cfGet(account, worker, token, "/script-settings"),
  ]);
  const existingOwner = worker === "remote-control-mcp-worker" &&
    Array.isArray(settings.bindings)
    ? settings.bindings.find(x => x.name === "V2_OWNER" &&
      x.type === "durable_object_namespace" &&
      x.class_name === "V2OwnerCoordinator" &&
      x.script_name === "remote-control-v2-preview")
    : null;
  // Capture the namespace before cutover in the protected release state file.
  // After a successful release, validation must work even if Preview is gone.
  const previousNamespaceId = options.mode === "preflight"
    ? existingOwner?.namespace_id : options.previousNamespaceId;
  verifyBindings(worker, settings, secrets, {
    ...options, previousNamespaceId,
  });
  let workflowExecutorBaseline;
  if(worker==="workflow-mcp-worker") {
    const active=activeVersion(deployments);
    const version=await cfGet(account,worker,token,"/versions/"+active.version_id);
    invariant(version?.id===active.version_id &&
      Array.isArray(version?.resources?.bindings),
      "Workflow active Version resources unavailable");
    workflowExecutorBaseline=verifyWorkflowActiveExecutorBaseline(
      settings.bindings,version.resources.bindings);
  }
  if (options.sourceConfig) {
    invariant(settings.compatibility_date === options.sourceConfig.compatibility_date,
      "Compatibility date drift");
    const actualFlags = [...(settings.compatibility_flags || [])].sort();
    const expectedFlags = [...(options.sourceConfig.compatibility_flags || [])].sort();
    invariant(JSON.stringify(actualFlags) === JSON.stringify(expectedFlags),
      "Compatibility flag drift");
  }
  if (worker !== "ssh-mcp-worker") {
    invariant(scriptSettings?.observability?.logs?.invocation_logs ===
      (["remote-control-mcp-worker", "browser-mcp-worker"].includes(worker) ? false : true),
      "Script-level Invocation Logs drift");
  }
  if (worker === "ima-mcp-worker") {
    invariant(scriptSettings?.observability?.traces?.enabled === true, "IMA script tracing drift");
  }
  return {
    ...activeVersion(deployments),
    ...(worker === "browser-mcp-worker" ? {browserNamespaceId: settings.bindings.find(b=>b.name==="BROWSER_OWNER").namespace_id} : {}),
    ...(options.mode === "preflight" && typeof previousNamespaceId === "string"
      ? { previousNamespaceId } : {}),
    ...(worker==="workflow-mcp-worker" && options.mode==="preflight" ? {
      workflowExecutorBaseline
    } : {}),
  };
}

/** Cloudflare deployment and Secret inventory may propagate independently.
 * Only bounded read-only 5xx responses and known propagation races retry;
 * permission, source identity, configuration and schema drift remain fatal. */
export async function retryReleaseReadback(read, pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try { return await read(); }
    catch (error) {
      const message = error instanceof Error ? error.message : "";
      const transient = /^Required (Secret binding|runtime Secret) missing: /.test(message) ||
        message === "Active Worker version does not match the Wrangler-published version" ||
        /^Cloudflare read-only \/(?:settings|secrets|script-settings|deployments\?per_page=1) HTTP 5\d\d$/.test(message);
      if (attempt === 5 || !transient) throw error;
      await pause(2000);
    }
  }
}

// A protected prepublication GET must observe both the same Access identity
// and the same independently inventoried active Worker. A candidate must not
// silently rebase itself onto a changed production trust boundary.
export function verifyBrowserPrepublicationCandidate(previous, observed, discovered) {
  invariant(previous?.worker==="browser-mcp-worker" &&
    typeof previous?.version_id==="string" &&
    previous.version_id===observed?.version_id &&
    previous.deployment_id===observed?.deployment_id,
    "Browser active production baseline changed before publication");
  verifyBrowserIdentityContinuity(previous.browserIdentity,discovered);
  return true;
}

// I/O for the single release proof path. No payload logging or uncertain-write retry.
export function workflowReleaseIO(env=process.env,request=fetch){
 const account=env.CLOUDFLARE_ACCOUNT_ID,token=env.CLOUDFLARE_API_TOKEN;
 invariant(/^[a-f0-9]{32}$/i.test(account??'')&&token,'Workflow release credentials unavailable');
 const config=JSON.parse(readFileSync(new URL('../apps/workflow-mcp-worker/wrangler.jsonc',import.meta.url),'utf8'));
 const db=config.d1_databases?.filter(d=>d.binding==='DB');
 invariant(db?.length===1&&db[0].database_name==='workflow-mcp-db'&&
   /^[a-f0-9-]{36}$/.test(db[0].database_id),'Workflow D1 target unavailable');
 const base='https://api.cloudflare.com/client/v4/accounts/'+account;
 const headers={Authorization:'Bearer '+token,Accept:'application/json'};
 const api=async(url,auth,body)=>{
   const response=await request(url,{redirect:'manual',headers:{...auth,...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{method:'POST',body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
   invariant(response.ok,'Workflow release evidence API unavailable (HTTP '+response.status+')');
   return response.json();
 };
 const d1=async(sql,params)=>{
   const data=await api(base+'/d1/database/'+db[0].database_id+'/query',headers,{sql,params});
   invariant(data?.success===true&&Array.isArray(data.result)&&data.result.length===1&&
     data.result[0]?.success===true&&Array.isArray(data.result[0].results),'Workflow D1 evidence response incomplete');
   return data.result[0];
 };
 const query=async(sql,params=[])=>{
   invariant(/^ *(SELECT|WITH) /i.test(sql),'Workflow evidence read must be SELECT');
   const result=await d1(sql,params);
   invariant(result.meta?.changed_db!==true&&!(result.meta?.changes>0),'Workflow evidence query unexpectedly changed D1');
   return result.results;
 };
 const write=async(sql,params)=>{
   invariant(sql.startsWith('UPDATE runs SET execution_terminal_proof=? WHERE id=? AND instance_id=?'),
    'Workflow backfill write target invalid');
   const result=await d1(sql,params);
   invariant(Number.isSafeInteger(result.meta?.changes),'Workflow backfill receipt unavailable');
   return result.meta.changes;
 };
 const observe=async run=>{
   invariant(/^[a-f0-9-]{36}$/i.test(run.instance_id),'Workflow instance identity malformed');
   const url=base+'/workflows/workflow-mcp-orchestrator/instances/'+run.instance_id;
   const response=await request(url,{redirect:'manual',headers,signal:AbortSignal.timeout(15000)});
   if(response.status===404)return null;
   invariant(response.ok,'Workflow native observation unavailable (HTTP '+response.status+')');
   const data=await response.json(),native=data?.result;
   invariant(data?.success===true&&native&&(!native.id||native.id===run.instance_id),'Workflow native observation identity mismatch');
   return ['complete','errored','terminated'].includes(native.status)&&native.end?
     {instance_id:run.instance_id,status:native.status,observed_at:Date.now()}:null;
 };
 const cache=new Map();
 const cached=(url,auth)=>{if(!cache.has(url))cache.set(url,api(url,auth));return cache.get(url);};
 const gh=(repo,id,suffix='')=>{
   invariant(['lirtual/mcp-workers','lirtual/github-actions','lirtual/cloudflare-actions'].includes(repo)&&Number.isSafeInteger(id),'Historical release source invalid');
   const credential=repo==='lirtual/mcp-workers'?env.GITHUB_TOKEN:null;
   invariant(repo!=='lirtual/mcp-workers'||credential,'Historical migration read credential unavailable');
   return cached('https://api.github.com/repos/'+repo+'/actions/runs/'+id+suffix,
     {...(credential?{Authorization:'Bearer '+credential}:{}),Accept:'application/vnd.github+json'});
 };
 const historySources={githubRun:gh,githubJobs:(repo,id)=>gh(repo,id,'/jobs?per_page=100'),
   providerVersions:()=>cached(base+'/workers/scripts/cloudflare-actions/versions?per_page=100',headers)};
 return {query,write,observe,historySources,sourceFiles:readdirSync(new URL('../apps/workflow-mcp-worker/migrations/',import.meta.url)),
  nativeDrain:ids=>checkNativeWorkflowRelease(account,headers,ids,request),
  maintenance:phase=>readOnlyPrepare(env,request,phase)};
}
export async function workflowReleaseProof(mode,io,env=process.env){
 const strict=mode!=='workflow-check'||env.ACTIONS_INGRESS_QUIESCED==='true';
 const preparing=mode==='workflow-prepare';
 const freezing=mode==='workflow-freeze-check';
 invariant(['workflow-prepare','workflow-freeze-check','workflow-check'].includes(mode),'Unknown Workflow proof operation');
 if(strict){
   requireIngressQuiescence(env.ACTIONS_INGRESS_QUIESCED);
   await io.maintenance(freezing?'maintenance':'frozen');
 }
 const schemaRows=await io.query('SELECT name FROM d1_migrations ORDER BY name',[]);
 const selected=selectWorkflowSchemaRelease([{success:true,results:schemaRows}],io.sourceFiles);
 invariant(selected.source===23&&(selected.applied===23||strict&&(preparing||freezing)&&selected.applied===22),
  'Workflow release requires exact v23 schema, or authorized v22 cutover');
 const useHistory=preparing||(freezing&&selected.applied===22);
 const observe=async(run,evidence)=>{
   if(useHistory){
     const {historicalMigrationProof}=await import('./workflow-terminal-run-exception.mjs');
     const fact=await historicalMigrationProof(run,evidence,io.historySources);
     if(fact)return fact;
   }
   return io.observe(run);
 };
 const result=await verifyWorkflowReleaseInventory(io.query,{mode:strict?'strict':'compatible',sourceFiles:io.sourceFiles,observe});
 invariant(result.schema===selected.applied,'Workflow schema changed during proof');
 if(strict)await io.maintenance(freezing?'maintenance':'frozen');
 else await io.nativeDrain(result.ready_instances);
 return result;
}
function requireProtectedWorkflowCutover(env){
 invariant(env.GITHUB_EVENT_NAME==='workflow_dispatch'&&env.GITHUB_REF==='refs/heads/main'&&env.GITHUB_ACTOR==='lirtual'&&
  /^[a-f0-9]{40}$/.test(env.GITHUB_SHA??'')&&env.SELECTED_WORKER==='workflow-mcp-worker'&&env.WORKFLOW_CODE_ONLY!=='true',
  'Workflow cutover must run in the protected selected-Worker release');
 requireIngressQuiescence(env.ACTIONS_INGRESS_QUIESCED);
}
async function workflowProofCLI(mode,env){
 const io=workflowReleaseIO(env);
 if(mode==='workflow-backfill'||mode==='workflow-cutover-recheck'){
   requireProtectedWorkflowCutover(env);
   await io.maintenance('frozen');
   const saved=JSON.parse(await readFile(join(env.RUNNER_TEMP,'workflow-cutover-proof.json'),'utf8'));
   invariant(saved.sourceSha===env.GITHUB_SHA&&saved.prepared&&typeof saved.bookmark==='string'&&saved.bookmark.length>0,
    'Workflow migration recovery point or prepared proof unavailable');
   if(mode==='workflow-cutover-recheck'){
     const original=saved.prepared;
     invariant(original.schema===22,'Workflow migration recheck requires v22');
     const current=await verifyWorkflowReleaseInventory(io.query,{mode:'strict',sourceFiles:io.sourceFiles,
       observe:async run=>Object.hasOwn(original.proofs,run.id)?original.proofs[run.id]:null});
     invariant(JSON.stringify(current)===JSON.stringify(original),'Workflow evidence changed before schema migration');
     await io.maintenance('frozen');
     console.log('Exact v22 cutover evidence reverified; only migration 0023 may be applied');
     return;
   }
   const checked=await backfillWorkflowTerminalProofs(io.query,io.write,saved.prepared,io.sourceFiles);
   await io.maintenance('frozen');
   console.log('Workflow v23 proof backfill verified: '+Object.keys(checked.proofs).length+' candidate facts');
   return;
 }
 if(mode==='workflow-prepare')requireProtectedWorkflowCutover(env);
 const prepared=await workflowReleaseProof(mode,io,env);
 if(mode==='workflow-prepare'){
   const bookmark=JSON.parse(await readFile(join(env.RUNNER_TEMP,'workflow-cutover-bookmark.json'),'utf8')).bookmark;
   invariant(typeof bookmark==='string'&&/^[a-f0-9-]{20,100}$/i.test(bookmark),'Workflow Time Travel bookmark unavailable');
   await writeFile(join(env.RUNNER_TEMP,'workflow-cutover-proof.json'),JSON.stringify({sourceSha:env.GITHUB_SHA,bookmark,prepared}),{mode:0o600});
   invariant(env.GITHUB_OUTPUT,'Protected release output unavailable');
   await appendFile(env.GITHUB_OUTPUT,'apply_required='+(prepared.schema===22)+'\n');
   console.log('Workflow recovery point: '+bookmark+'; source schema '+prepared.schema);
 }
 console.log('Workflow execution readiness verified: schema '+prepared.schema+', '+prepared.run_count+' Runs, '+prepared.ready_sessions+' Ready Sessions, '+Object.keys(prepared.proofs).length+' terminal proofs');
}

async function main() {
  const [mode, worker] = process.argv.slice(2);
  if(["workflow-prepare","workflow-backfill","workflow-cutover-recheck","workflow-check","workflow-freeze-check"].includes(mode)){
    invariant(worker==="workflow-mcp-worker","Workflow proof restricted to Workflow");
    return workflowProofCLI(mode,process.env);
  }
  invariant(["preflight", "readback", "identity-recheck", "version", "diagnostic"].includes(mode), "Unknown release validation mode");
  if (mode === "diagnostic") {
    invariant(worker, "Wrangler log path missing");
    const log = await readFile(worker, "utf8");
    const codes = [...log.matchAll(/\b(?:error\s+code|code)\s*[:=]?\s*(\d{4,6})\b/gi)]
      .map((match) => match[1]).slice(0, 3);
    const stage = process.argv[4] === "prepare" ? "prepare" : "deploy";
    console.error("Wrangler diagnostic: stage=" + stage + "; code=" +
      (codes.length ? [...new Set(codes)].join(",") : "unavailable") +
      "; summary=Wrangler CLI exited unsuccessfully (details withheld)");
    return;
  }
  if (mode === "version") {
    const file = worker;
    invariant(file, "Wrangler log path missing");
    console.log(parseWranglerVersion(await readFile(file, "utf8")));
    return;
  }
  invariant(WORKERS.has(worker), "Unsupported Worker target");
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const statePath = process.env.RELEASE_STATE_FILE;
  const sourceSha = process.env.GITHUB_SHA;
  const configPath = join(process.cwd(), "apps", worker, "wrangler.jsonc");
  const rawConfig = await readFile(configPath, "utf8");
  const sourceConfig = readConfiguration(worker, rawConfig);
  if (worker === "browser-mcp-worker") {
    invariant(sourceConfig.routes?.length === 1 && sourceConfig.routes[0].custom_domain === true &&
      sourceConfig.routes[0].pattern === "browser.lirtual.dpdns.org",
      "Browser release blocked: reviewed dedicated Custom Domain is not configured");
  }
  invariant(account && token && statePath && sourceSha, "Required release environment missing");
  if(mode==="identity-recheck")
    invariant([ "browser-mcp-worker", "workflow-mcp-worker" ].includes(worker) &&
      process.env.GITHUB_REPOSITORY==="lirtual/mcp-workers" &&
      process.env.GITHUB_REF==="refs/heads/main" &&
      process.env.GITHUB_ACTOR==="lirtual",
      "Protected prepublication recheck requires main context");
  const previous = ["readback","identity-recheck"].includes(mode)
    ? JSON.parse(await readFile(statePath, "utf8")) : null;
  if (previous) invariant(previous.worker === worker && previous.sourceSha === sourceSha,
    "Release source changed");
  const exists = mode === "preflight" ? await scriptExists(account, worker, token) : true;
  // Browser must have a separately observed active baseline. No bootstrap or
  // missing production identity may silently define a new trust boundary.
  if(worker==="browser-mcp-worker" && mode==="preflight")
    invariant(exists,"Browser active production identity baseline unavailable");
  const discoveredBrowserIdentity=worker==="browser-mcp-worker" &&
    ["preflight","identity-recheck"].includes(mode)
      ? await discoverBrowserActivationIdentity(process.env) : undefined;
  const browserIdentity=worker==="browser-mcp-worker"
    ? mode==="preflight" ? discoveredBrowserIdentity : previous?.browserIdentity
    : undefined;
  if(worker==="workflow-mcp-worker" && mode==="preflight") invariant(
    process.env.CANONICAL_WORKFLOW_EXECUTOR_REPOSITORY &&
    process.env.CANONICAL_WORKFLOW_EXECUTOR_REPOSITORY ===
      process.env.WORKFLOW_GITHUB_ACTION_REPOSITORY,
    "Workflow repository source differs from Repository-level CI baseline");
  const workflowExecutorIdentity=worker==="workflow-mcp-worker"
    ? ["preflight","identity-recheck"].includes(mode)
      ? await verifyWorkflowGitHubExecutor(process.env.WORKFLOW_GITHUB_ACTION_REPOSITORY,
          process.env.WORKFLOW_GITHUB_DISPATCH_TOKEN)
      : previous?.workflowExecutorIdentity
    : undefined;
  if(worker==="workflow-mcp-worker") {
    const identity=parseVerifiedExecutorIdentity(workflowExecutorIdentity);
    invariant(identity.repository===process.env.WORKFLOW_GITHUB_ACTION_REPOSITORY,
      "Workflow release repository source changed");
    if(previous && mode==="identity-recheck") invariant(
      JSON.stringify(identity)===JSON.stringify(previous.workflowExecutorIdentity),
      "Workflow executor identity changed after preflight");
  }
  if(worker==="browser-mcp-worker")
    invariant(browserIdentity?.accountId===account &&
      browserIdentity.ownerEmail===process.env.OWNER_EMAIL &&
      /^[a-f0-9]{64}$/.test(browserIdentity.audience) &&
      browserIdentity.origin===browserActivationOrigin(sourceConfig),
      "Browser candidate identity state missing or changed");
  if (mode === "preflight" && process.env.WORKFLOW_CODE_ONLY === "true")
    invariant(worker === "workflow-mcp-worker" && exists,
      "Code-only release requires an existing Workflow Worker");
  const read = async () => {
    const observed = await current(account, worker, token, {
      mode: mode==="identity-recheck" ? "preflight" : mode,
      sourceConfig,
      requireExistingSecrets: mode === "preflight" &&
        process.env.WORKFLOW_CODE_ONLY === "true",
      previousNamespaceId: previous?.previousNamespaceId,
      browserNamespaceId: previous?.browserNamespaceId,
      browserIdentity,
      sharedAccessTeamDomain: browserIdentity?.teamDomain,
      sharedOwnerEmail: browserIdentity?.ownerEmail,
      databaseConnections: worker === "database-mcp-worker" ? process.env.DATABASE_CONNECTIONS : undefined,
      databaseVariables: {DB_HOST:process.env.DB_HOST},
      expectedDatabaseLimits: worker === "database-mcp-worker"
        ? expectedDatabaseLimits(sourceConfig, process.env) : undefined,
      expectedBrowserRememberedDays: worker === "browser-mcp-worker"
        ? process.env.BROWSER_REMEMBERED_IDLE_DAYS : undefined,
      expectedWorkflowPortalClientId: worker === "workflow-mcp-worker"
        ? process.env.WORKFLOW_MCP_PORTAL_CLIENT_ID : undefined,
      expectedWorkflowIdentity: workflowExecutorIdentity,
      workflowExecutorBaseline: previous?.workflowExecutorBaseline,
      expectedBrowserActivationAudience: browserIdentity?.audience,
      expectedRcaClerkIdentity: worker==="remote-control-mcp-worker" && mode==="readback"
        ? remoteControlClerkIdentity(process.env) : undefined,
    });
    // Compare active deployments inside the existing bounded retry loop.
    // Keep identity and binding drift failures fatal.
    if (mode === 'readback' && worker === 'workflow-mcp-worker')
      verifyPublishedVersion(previous, observed, process.env.EXPECTED_VERSION_ID);
    return observed;
  };
  const observed = !exists ? { mode: "bootstrap" }
    : mode === "readback" && worker === "workflow-mcp-worker"
      ? await retryReleaseReadback(read) : await read();
  if (mode === "identity-recheck") {
    if(worker==="browser-mcp-worker") {
      verifyBrowserPrepublicationCandidate(previous, observed, discoveredBrowserIdentity);
      console.log("Browser prepublication Access and active Worker identity: PASS");
    }else{
      invariant(previous.version_id===observed.version_id &&
        previous.deployment_id===observed.deployment_id &&
        JSON.stringify(previous.workflowExecutorBaseline)===
          JSON.stringify(observed.workflowExecutorBaseline),
        "Workflow active production baseline changed before cutover");
      console.log("Workflow executor and active baseline prepublication recheck: PASS");
    }
    return;
  }
  if (mode === "preflight") {
    await writeFile(statePath, JSON.stringify({ worker, sourceSha, ...observed,
      ...(browserIdentity ? {browserIdentity} : {}),
      ...(workflowExecutorIdentity ? {workflowExecutorIdentity} : {}) }), { mode: 0o600 });
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, "bootstrap=" + (!exists) + "\n");
    }
    console.log("Preflight OK: " + worker + " (" + (exists ? "update" : "bootstrap") +
      "; source " + sourceSha.slice(0, 12) + ")");
  } else {
    verifyPublishedVersion(previous, observed, process.env.EXPECTED_VERSION_ID);
    console.log("Release verified: " + worker + " version " + observed.version_id +
      " source " + sourceSha.slice(0, 12) +
      (previous.mode === "bootstrap" ? " (first deployment)" : ""));
  }
}

if (process.argv[1]?.endsWith("/manual-worker-release.mjs")) {
  main().catch((error) => {
    console.error("Release validation failed: " + error.message);
    process.exitCode = 1;
  });
}
