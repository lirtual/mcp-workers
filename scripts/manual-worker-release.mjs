import {connectionInventory} from '../apps/database-mcp-worker/src/catalog.ts';
import references from '../apps/database-mcp-worker/connection-references.json' with {type:'json'};
function databaseSecretNames(raw) {
  const inventory=Object.values(connectionInventory(raw)).join('\n');
  return references.secrets.filter(name=>inventory.includes('${'+name+'}'));
}
// Narrow, credential-free-to-import Cloudflare release checks for #19.
// Never log API bodies: Workers settings can include runtime plain-text values.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectWorkerVars, BROWSER_ACCESS_VARIABLES, browserActivationOrigin } from "./worker-release-variables.mjs";
import { TERMINAL_RUN_ID, SECOND_TERMINAL_RUN_ID, THIRD_TERMINAL_RUN_ID, FOURTH_TERMINAL_RUN_ID, FIFTH_TERMINAL_RUN_ID, SIXTH_TERMINAL_RUN_ID, SEVENTH_TERMINAL_RUN_ID, NINTH_TERMINAL_RUN_ID, TENTH_TERMINAL_RUN_ID, ELEVENTH_TERMINAL_RUN_ID, TWELFTH_TERMINAL_RUN_ID } from "./workflow-terminal-run-exception.mjs";
import { EIGHTH_MCP_RUN_ID } from "./workflow-mcp-no-dispatch-proof.mjs";

const WORKERS = new Set(["browser-mcp-worker", "raindrop-mcp-worker", "ima-mcp-worker", "database-mcp-worker", "ssh-mcp-worker", "remote-control-mcp-worker", "github-actions-mcp-worker", "workflow-mcp-worker"]);
export const REQUIRED_SECRETS = {
  "browser-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "raindrop-mcp-worker": ["MCP_ACCESS_TOKEN", "RAINDROP_ACCESS_TOKEN"],
  "ima-mcp-worker": ["MCP_ACCESS_TOKEN", "IMA_API_KEY"],
  "database-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "ssh-mcp-worker": ["MCP_ACCESS_TOKEN", "SSH_ENCRYPTION_KEY"],
  "remote-control-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "github-actions-mcp-worker": ["MCP_ACCESS_TOKEN", "ACTIONS_GITHUB_DISPATCH_TOKENS"],
  "workflow-mcp-worker": ["MCP_ACCESS_TOKEN", "WORKFLOW_MCP_PORTAL_CLIENT_SECRET", "WORKFLOW_GITHUB_DISPATCH_TOKEN", "WORKFLOW_SESSION_RUNTIME_DATA_KEY"],
};
// Wrangler retains omitted secret_text bindings after a normal release.
// These exact old names may coexist until separately approved cleanup.
export const MIGRATION_LEGACY_SECRETS = Object.freeze({
  "database-mcp-worker": ["DATABASE_ENCRYPTION_KEY", "DATABASE_KEY_ID", "DATABASE_GITHUB_ACTIONS_TOKEN", "DATABASE_ENCRYPTION_PREVIOUS_KEY", "DATABASE_PREVIOUS_KEY_ID", "DATABASE_CONFIG"],
  "ssh-mcp-worker": ["ENCRYPTION_KEY"],
  "workflow-mcp-worker": ["MCP_PORTAL_CLIENT_SECRET", "SESSION_RUNTIME_DATA_KEY"],
});
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
  const oldSecrets = MIGRATION_LEGACY_SECRETS[worker] ?? [];
  for (const name of REQUIRED_SECRETS[worker]) {
    // On preflight a missing runtime Secret can be repaired from GitHub.
    // The unconditional Secrets staging step fails closed before deployment.
    // Readback must still prove that every required Secret binding exists.
    if (options.mode !== "preflight" || options.requireExistingSecrets === true) {
      invariant(secretNames.has(name), "Required runtime Secret missing: " + name);
      invariant(!!find(name, "secret_text"), "Required Secret binding missing: " + name);
    }
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
    if (typeof options.expectedWorkflowGrants === "string") {
      const names = options.mode === "preflight"
        ? ["GITHUB_ACTION_APPROVED_REPOSITORIES", "WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES"]
        : ["WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES"];
      let expected;
      try { expected = options.expectedWorkflowGrants ? JSON.parse(options.expectedWorkflowGrants) : []; }
      catch { throw Error("Workflow repository grants are not valid JSON"); }
      invariant(!bindings.some(b => names.includes(b.name) && b.type !== "plain_text"),
        "Workflow repository approvals binding type changed");
      const present = names.map(name => find(name, "plain_text")).filter(Boolean);
      for (const binding of present) {
        let actual;
        try { actual = JSON.parse(binding.text); }
        catch { throw Error("Workflow repository grants are not valid JSON"); }
        invariant(JSON.stringify(expected) === JSON.stringify(actual),
          "Workflow approved repositories differ from existing reviewed grants");
      }
      invariant(present.length > 0 || JSON.stringify(expected) === "[]",
        "Workflow approved repositories missing from existing runtime");
    }
    if (options.mode === "preflight" && options.requireExistingSecrets) {
      invariant(!!find("WORKFLOW_MCP_PORTAL_CLIENT_ID", "plain_text") &&
        !!find("WORKFLOW_MCP_PORTAL_ENDPOINT", "plain_text") &&
        !!find("WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE", "plain_text"),
        "Workflow code-only release blocked until renamed binding cutover");
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
        "https://mcp.lirtual.dpdns.org/mcp", "Pinned Workflow MCP Portal drift");
      invariant(!bindings.some(x => ["GITHUB_EXECUTOR_REPOSITORY",
        "GITHUB_EXECUTOR_REPOSITORY_ID","GITHUB_EXECUTOR_REF",
        "GITHUB_EXECUTOR_AUDIENCE","GITHUB_TEST_WORKER_NAME",
        "GITHUB_TEST_DEDICATED_EXECUTOR"].includes(x.name)),
        "Retired fixed GitHub executor variables must be removed");
      invariant(find("WORKFLOW_GITHUB_ACTION_OIDC_AUDIENCE","plain_text")?.text ===
        "workflow-github-action:production", "Workflow Action OIDC audience drift");
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
    // The selected GitHub Environment stages IMA_CLIENT_ID on publish.
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
      if (env.BROWSER_ACCESS_ISSUER || env.BROWSER_OWNER_EMAIL)
        invariant(typeof options.sharedAccessTeamDomain === "string" &&
          env.BROWSER_ACCESS_ISSUER === "https://" + options.sharedAccessTeamDomain &&
          env.BROWSER_OWNER_EMAIL === options.sharedOwnerEmail,
          "Browser live identity differs from reviewed shared source");
      if (env.BROWSER_ACTIVATION_ORIGIN)
        invariant(env.BROWSER_ACTIVATION_ORIGIN === browserActivationOrigin(options.sourceConfig),
          "Browser live activation origin differs from Custom Domain");
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
    const cleanupLegacy = worker === "database-mcp-worker"
      ? ["DATABASE_ENCRYPTION_KEY", "DATABASE_GITHUB_ACTIONS_TOKEN", "DATABASE_KEY_ID"] : oldSecrets;
    const allowedSecrets = new Set([...REQUIRED_SECRETS[worker], ...(options.cleanupVerified ? cleanupLegacy : oldSecrets),
      ...(worker === "database-mcp-worker" ? references.secrets : []),
      ...(worker === "database-mcp-worker" && !options.cleanupVerified ? ["DATABASE_ENCRYPTION_PREVIOUS_KEY", "DATABASE_PREVIOUS_KEY_ID"] : [])]);
    invariant(secrets.every(b => allowedSecrets.has(b.name) && !!find(b.name, "secret_text")) &&
      bindings.filter(b => b.type === "secret_text").every(b => allowedSecrets.has(b.name)),
      "Unexpected runtime Secret name or type after publication");
    if (options.cleanupVerified) invariant(!cleanupLegacy.some(name => secretNames.has(name) ||
      !!find(name, "secret_text")), "Legacy Secret cleanup not complete");
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
  invariant(JSON.stringify(conf.secrets?.required) === JSON.stringify(["MCP_ACCESS_TOKEN", "WORKFLOW_MCP_PORTAL_CLIENT_SECRET", "WORKFLOW_GITHUB_DISPATCH_TOKEN", "WORKFLOW_SESSION_RUNTIME_DATA_KEY"]),
    "Workflow Portal Secret declaration drift");
  invariant(!conf.vars || Object.keys(conf.vars).length===0,
    "Workflow MCP source cannot declare runtime feature flags");
  invariant(!(conf.compatibility_flags || []).includes("global_fetch_strictly_public"),
    "Workflow must never enable or import MCP dynamic-target behavior");
  return true;
}

function reviewedTerminalRunSql(sql) {
  // This extra count is emitted only after the preceding exact historical
  // D1/native/GitHub proof supplied the audited Run ID as its step output.
  // A fake/unset approval leaves no ID in the generated query.
  if(process.env.WORKFLOW_TWELFTH_TERMINAL_RUN_ID===TWELFTH_TERMINAL_RUN_ID){
    sql=sql.replace("0 AS reviewed_terminal_artifact_attempts",
      "(SELECT count(*) FROM step_attempts WHERE "+
      "run_id='f99bb918-2909-46df-b196-d07faa64df27' "+
      "AND attempt_id='c7893834-10ff-41d5-b784-a33d00cc20f5' "+
      "AND step_id='verify' AND capability_id='github.action' "+
      "AND state='claimed' AND repository='lirtual/github-actions' "+
      "AND owner_run_id=41182432750 AND candidate_run_id=41182432750 "+
      "AND owner_run_attempt=1 AND candidate_run_attempt=1) "+
      "AS reviewed_terminal_artifact_attempts");
  }
  const exclusions=[
    [process.env.WORKFLOW_TERMINAL_RUN_ID,TERMINAL_RUN_ID],
    [process.env.WORKFLOW_SECOND_TERMINAL_RUN_ID,SECOND_TERMINAL_RUN_ID],
    [process.env.WORKFLOW_THIRD_TERMINAL_RUN_ID,THIRD_TERMINAL_RUN_ID],
    [process.env.WORKFLOW_FOURTH_TERMINAL_RUN_ID,FOURTH_TERMINAL_RUN_ID],
    [process.env.WORKFLOW_FIFTH_TERMINAL_RUN_ID,FIFTH_TERMINAL_RUN_ID],
    [process.env.WORKFLOW_SIXTH_TERMINAL_RUN_ID,SIXTH_TERMINAL_RUN_ID],
    [process.env.WORKFLOW_SEVENTH_TERMINAL_RUN_ID,SEVENTH_TERMINAL_RUN_ID],
    [process.env.WORKFLOW_EIGHTH_TERMINAL_RUN_ID,EIGHTH_MCP_RUN_ID],
    [process.env.WORKFLOW_NINTH_TERMINAL_RUN_ID,NINTH_TERMINAL_RUN_ID],
    [process.env.WORKFLOW_TENTH_TERMINAL_RUN_ID,TENTH_TERMINAL_RUN_ID],
    [process.env.WORKFLOW_ELEVENTH_TERMINAL_RUN_ID,ELEVENTH_TERMINAL_RUN_ID],
    [process.env.WORKFLOW_TWELFTH_TERMINAL_RUN_ID,TWELFTH_TERMINAL_RUN_ID],
  ].filter(([supplied,exact])=>supplied===exact).map(([,exact])=>exact);
  if(exclusions.length===0)return sql;
  const sqlIds=exclusions.map(id=>"'"+id+"'").join(",");
  return sql.replace(
    "outcome NOT IN ('succeeded','failed','cancelled')) AS nonterminal_runs",
    "outcome NOT IN ('succeeded','failed','cancelled') AND id NOT IN ("+sqlIds+")) AS nonterminal_runs"
  ).replace(
    "status NOT IN ('succeeded','failed','skipped','cancelled')) AS unresolved_steps",
    "status NOT IN ('succeeded','failed','skipped','cancelled') AND run_id NOT IN ("+sqlIds+")) AS unresolved_steps"
  );
}

export function verifyWorkflowD1Readiness(response, bootstrap, requireCompleteSchema = false, requireUuRetired = false) {
  invariant(Array.isArray(response) && response.length === 1 &&
    response[0]?.success === true && response[0]?.results?.length === 1,
    "Workflow remote D1 readback unavailable");
  const row = response[0].results[0];
  // #774: v21 is a distinct verified schema state, NOT a synthetic v20 row.
  // Keep the v20 structural predicates unchanged for all historical versions.
  // Production already has migration 0005. A failed two-file deployment may
  // leave 0006 committed; permit a controlled resume but never publish the
  // upgraded Worker until both new migrations and tables are confirmed.
  const base = [1,2,3,4,5].every(n => row?.["migration_v" + n] === 1) &&
    row?.attempt_table === 1 && row?.receipt_table === 1 &&
    row?.native_column === 1;
  const before = row?.migration_count === 5 &&
    row?.migration_v6 === 0 && row?.migration_v7 === 0 &&
    row?.session_table === 0 && row?.cancellation_table === 0;
  const partial = row?.migration_count === 6 &&
    row?.migration_v6 === 1 && row?.migration_v7 === 0 &&
    row?.session_table === 0 && row?.cancellation_table === 0;
  const current = row?.migration_count === 7 &&
    row?.migration_v6 === 1 && row?.migration_v7 === 1 &&
    row?.migration_v8 === 0 && row?.locator_column === 0 &&
    row?.session_table === 1 && row?.cancellation_table === 1;
  const previous = row?.migration_count === 8 &&
    row?.migration_v6 === 1 && row?.migration_v7 === 1 &&
    row?.migration_v8 === 1 && row?.migration_v9 === 0 &&
    row?.locator_column === 1 && row?.fixed_column === 0 && row?.fixed_index === 0 &&
    row?.session_table === 1 && row?.cancellation_table === 1;
  const oldComplete = row?.migration_count === 9 &&
    row?.migration_v6 === 1 && row?.migration_v7 === 1 &&
    row?.migration_v8 === 1 && row?.migration_v9 === 1 &&
    row?.locator_column === 1 && row?.fixed_column === 1 && row?.fixed_index === 1 &&
    row?.session_table === 1 && row?.cancellation_table === 1;
  // v10 belongs to Session Runtime Data. v11 introduces awaited children.
  // Refuse a fake v10-only child schema and any partially applied v11.
  const runtimeComplete = row?.migration_count === 10 && row?.migration_v10 === 1 &&
    row?.migration_v11 === 0 && row?.runtime_table === 1 &&
    row?.capacity_column === 0 && row?.parent_column === 0 &&
    row?.parent_step_column === 0 && row?.child_index === 0 &&
    row?.child_cancel_table === 0 && row?.child_terminate_fence_column === 0 &&
    row?.capacity_guard_trigger === 0 &&
    row?.migration_v6 === 1 && row?.migration_v7 === 1 &&
    row?.migration_v8 === 1 && row?.migration_v9 === 1 &&
    row?.locator_column === 1 && row?.fixed_column === 1 && row?.fixed_index === 1 &&
    row?.session_table === 1 && row?.cancellation_table === 1;
  const v11Structure = row?.migration_v10 === 1 &&
    row?.migration_v11 === 1 &&
    row?.capacity_column === 1 && row?.parent_column === 1 &&
    row?.parent_step_column === 1 && row?.child_index === 1 &&
    row?.child_cancel_table === 1 && row?.child_terminate_fence_column === 1 &&
    row?.capacity_guard_trigger === 1 &&
    row?.migration_v6 === 1 && row?.migration_v7 === 1 &&
    row?.migration_v8 === 1 && row?.migration_v9 === 1 &&
    row?.locator_column === 1 && row?.fixed_column === 1 && row?.fixed_index === 1 &&
    row?.session_table === 1 && row?.cancellation_table === 1;
  const fullV11Schema=v11Structure && row?.runtime_table === 1;
  // Accept the reviewed v11 schema ONLY before a v12 migration. Deployment
  // requires the exact v12 receipt table + migration record.
  const completeV11 = row?.migration_count === 11 &&
    row?.migration_v12 === 0 && row?.event_receipts_table === 0 && fullV11Schema;
  const completeV12 = row?.migration_count === 12 &&
    row?.migration_v12 === 1 && row?.event_receipts_table === 1 &&
    row?.migration_v13 !== 1 && fullV11Schema;
  const completeV13 = row?.migration_count === 13 &&
    row?.migration_v12 === 1 && row?.event_receipts_table === 1 &&
    row?.migration_v13 === 1 && row?.invocations_table === 1 &&
    row?.cloudflare_cancel_table === 1 &&
    row?.migration_v14 === 0 && row?.deleted_column === 0 && fullV11Schema;
  const completeV14 = row?.migration_count === 14 &&
    row?.migration_v12 === 1 && row?.event_receipts_table === 1 &&
    row?.migration_v13 === 1 && row?.invocations_table === 1 &&
    row?.cloudflare_cancel_table === 1 &&
    row?.migration_v14 === 1 && row?.deleted_column === 1 &&
    row?.migration_v15 !== 1 && row?.approval_gates_table !== 1 &&
    row?.approvals_table !== 1 && fullV11Schema;
  const completeV15 = row?.migration_count === 15 &&
    row?.migration_v12 === 1 && row?.event_receipts_table === 1 &&
    row?.migration_v13 === 1 && row?.invocations_table === 1 &&
    row?.cloudflare_cancel_table === 1 &&
    row?.migration_v14 === 1 && row?.deleted_column === 1 &&
    row?.migration_v15 === 1 && row?.approval_gates_table === 1 &&
    row?.approvals_table === 1 && row?.migration_v16 !== 1 &&
    row?.portal_auth_table !== 1 && row?.mcp_fence_table !== 1 && fullV11Schema;
  const completeV16 = row?.migration_count === 16 &&
    row?.migration_v16 === 1 && row?.portal_auth_table === 1 &&
    row?.mcp_fence_table === 1 && row?.migration_v15 === 1 &&
    row?.approval_gates_table === 1 && row?.approvals_table === 1 &&
    row?.deleted_column === 1 && fullV11Schema;
  const completeV17 = row?.migration_count === 17 && row?.migration_v17 === 1 &&
    row?.http_auth_table === 1 && row?.migration_v16 === 1 &&
    row?.portal_auth_table === 1 && row?.mcp_fence_table === 1 &&
    row?.migration_v15 === 1 && row?.approval_gates_table === 1 &&
    row?.approvals_table === 1 && row?.deleted_column === 1 && fullV11Schema;
  const completeV18 = row?.migration_count === 18 && row?.migration_v18 === 1 &&
    row?.migration_v19 === 0 && row?.rca_duration_column === 0 &&
    row?.cloudflare_gate_table === 1 && row?.migration_v17 === 1 &&
    row?.http_auth_table === 1 && row?.migration_v16 === 1 &&
    row?.portal_auth_table === 1 && row?.mcp_fence_table === 1 &&
    row?.migration_v15 === 1 && row?.approval_gates_table === 1 &&
    row?.approvals_table === 1 && row?.deleted_column === 1 && fullV11Schema;
  // #62: migration 0019 adds a signed, nonrenewable Session duration snapshot.
  // Release may start on a fully reviewed v18 baseline, but code publication
  // must follow exact v19 migration/column confirmation; no v18 fallback.
  const reviewedV19Structure = row?.migration_v19 === 1 &&
    row?.rca_duration_column === 1 && row?.migration_v18 === 1 &&
    row?.cloudflare_gate_table === 1 && row?.migration_v17 === 1 &&
    row?.http_auth_table === 1 && row?.migration_v16 === 1 &&
    row?.portal_auth_table === 1 && row?.mcp_fence_table === 1 &&
    row?.migration_v15 === 1 && row?.approval_gates_table === 1 &&
    row?.approvals_table === 1 && row?.deleted_column === 1 && v11Structure;
  const reviewedV19Shape=reviewedV19Structure && row?.runtime_table === 1;
  // 0020 freezes the CI-verified main SHA per GitHub Attempt. Preserve a
  // strict v19 pre-migration gate and require BOTH migration and column after.
  const completeV19 = row?.migration_count === 19 &&
    row?.migration_v20 === 0 && row?.resolved_sha_column === 0 &&
    reviewedV19Shape;
  const completeV20 = row?.migration_count === 20 &&
    row?.migration_v20 === 1 && row?.resolved_sha_column === 1 &&
    reviewedV19Shape;
  const completeV21=row?.migration_count===21 && row?.migration_v21===1 &&
    row?.runtime_table===0 && row?.migration_v20===1 &&
    row?.resolved_sha_column===1 && reviewedV19Structure;
  invariant(row?.migration_v21!==1 || completeV21,"UU retirement migration/schema drift");
  if(requireUuRetired)invariant(completeV21,"UU retirement post-migration D1 readback missing");
  invariant(base && (requireCompleteSchema ? (completeV20 || completeV21) : (before || partial || current || previous || oldComplete || runtimeComplete || completeV11 || completeV12 || completeV13 || completeV14 || completeV15 || completeV16 || completeV17 || completeV18 || completeV19 || completeV20 || completeV21)),
    "Workflow production D1 schema migrations missing, partial or drifted");
  invariant(Number.isSafeInteger(row?.active_runs) && row.active_runs === 0,
    "Workflow cannot redeploy while Runs are active or indeterminate");
  // D1 migration may change Session reservations even after the parent Run
  // succeeded at Ready. Require a physically quiescent Tailnet before schema
  // changes; completed-schema code-only releases use their separate gate.
  if(!completeV20 || requireUuRetired) invariant(Number.isSafeInteger(row?.active_sessions) &&
    row.active_sessions===0, "Workflow D1 migration blocked by active physical Sessions");
  if(bootstrap) invariant(row.run_count === 0 && row.workflow_count === 0,
    "Workflow first deployment requires empty production Run and Workflow state");
  return true;
}

/**
 * #204: read-only database half of the migration fence.
 * It does not freeze ingress, inspect live Cloudflare Workflow instances,
 * verify external GitHub jobs or authorize a production cutover.
 */
export const WORKFLOW_MIGRATION_READINESS_SQL = `SELECT
 (SELECT count(*) FROM d1_migrations) AS migration_count,
 (SELECT count(*) FROM d1_migrations WHERE name IN (
   '0001_s1.sql','0002_native_complete_seen.sql','0003_s3_attempt_claim.sql',
   '0004_s3_callback_receipts.sql','0005_github_workflow_check.sql',
   '0006_action_attempt_capabilities.sql','0007_session_executions.sql',
   '0008_session_locator.sql','0009_fixed_sessions.sql',
   '0010_session_runtime_data.sql','0011_awaited_child_capacity.sql',
   '0012_event_wait_receipts.sql','0013_cloudflare_action_invocations.sql',
    '0014_workflow_deletion.sql','0015_runtime_approval.sql',
    '0016_portal_connection_revocation.sql',
    '0017_http_connection_auth.sql','0018_cloudflare_action_migration_fence.sql',
    '0019_session_rca_duration.sql','0020_github_action_main_sha.sql',
   '0021_retire_uu_session_data.sql')) AS expected_migrations,
 (SELECT count(*) FROM pragma_table_info('step_attempts') WHERE name='resolved_sha') AS resolved_sha_column,
 (SELECT count(*) FROM workflows) AS workflow_count,
 (SELECT count(*) FROM runs) AS run_count,
 (SELECT count(*) FROM session_executions) AS session_count,
 (SELECT count(*) FROM step_attempts) AS attempt_count,
 (SELECT count(*) FROM callback_receipts) AS callback_count,
 (SELECT count(*) FROM github_action_cancellations) AS cancellation_count,
 (SELECT count(*) FROM runs WHERE outcome IS NULL OR
   outcome NOT IN ('succeeded','failed','cancelled')) AS nonterminal_runs,
 (SELECT count(*) FROM runs WHERE start_state IS NULL OR
   start_state IN ('reserved','start_unknown')) AS unresolved_starts,
 (SELECT count(*) FROM run_steps WHERE status IS NULL OR
   status NOT IN ('succeeded','failed','skipped','cancelled')) AS unresolved_steps,
 -- A durable Saga cancellation ACK is not completion. For code-only
 -- releases only, recognize the request as quiescent when the exact Session
 -- and GitHub Attempt have separately reached verified physical terminal.
 -- Schema migrations still require unresolved_steps=0.
 (SELECT count(*) FROM run_steps receipt
   JOIN runs owner ON owner.id=receipt.run_id
   JOIN session_executions session ON session.run_id=receipt.run_id
     AND receipt.step_id='__saga_'||session.step_id
   JOIN step_attempts attempt ON attempt.run_id=session.run_id
     AND attempt.step_id=session.step_id
     AND attempt.capability_id='github.action'
   WHERE receipt.status='requested' AND
     owner.outcome IN ('failed','cancelled') AND
     session.state='terminated' AND
     attempt.state IN ('succeeded','failed','cancelled'))
   AS verified_terminal_saga_receipts,
 (SELECT count(*) FROM run_steps s JOIN runs r ON r.id=s.run_id
   WHERE s.status='cancelled' AND (r.outcome IS NOT 'cancelled'
     OR r.error_code IS NOT s.error_code
     OR r.error_code IS NULL
     OR r.error_code NOT IN ('approval_cancel_requested',
       'event_wait_cancel_requested'))) AS invalid_cancelled_steps,
 (SELECT count(*) FROM step_attempts WHERE state IS NULL OR
   state NOT IN ('rejected','succeeded','failed','cancelled')) AS nonterminal_attempts,
 0 AS reviewed_terminal_artifact_attempts,
 (SELECT count(*) FROM session_executions WHERE state IS NULL OR
   state != 'terminated') AS nonterminated_sessions,
 (SELECT count(*) FROM callback_receipts WHERE notification_delivered IS NULL OR
   notification_delivered != 1) AS undelivered_callbacks,
 (SELECT count(*) FROM session_executions s
   JOIN runs r ON r.id=s.run_id
   JOIN step_attempts a ON a.run_id=s.run_id AND a.step_id=s.step_id
   WHERE s.state='ready' AND r.outcome='succeeded'
   AND a.state='claimed') AS confirmed_ready_sessions`;

export function verifyWorkflowMigrationReadiness(response) {
  invariant(Array.isArray(response) && response.length === 1 &&
    response[0]?.success === true && response[0]?.results?.length === 1,
    "Workflow migration D1 readback unavailable");
  const row = response[0].results[0];
  const nonnegative = [
    "migration_count","expected_migrations","workflow_count","run_count",
    "session_count","attempt_count","callback_count","cancellation_count",
    "nonterminal_runs","unresolved_starts","unresolved_steps","invalid_cancelled_steps",
    "nonterminal_attempts","nonterminated_sessions","undelivered_callbacks",
  ];
  for (const key of nonnegative) {
    invariant(Number.isSafeInteger(row?.[key]) && row[key] >= 0,
      "Workflow migration D1 count unavailable or invalid: " + key);
  }
  invariant([12,13,14,15,16,17,18,19,20,21].includes(row.migration_count) &&
    row.expected_migrations === row.migration_count,
    "Workflow migration requires the exact reviewed D1 migrations");
  for (const key of [
    "nonterminal_runs","unresolved_starts","unresolved_steps","invalid_cancelled_steps",
    "nonterminal_attempts","nonterminated_sessions","undelivered_callbacks",
  ]) {
    invariant(row[key] === 0, "Workflow migration blocked by " + key);
  }
  return {
    workflows: row.workflow_count,
    runs: row.run_count,
    sessions: row.session_count,
    attempts: row.attempt_count,
    callbacks: row.callback_count,
    cancellations: row.cancellation_count,
  };
}

/**
 * Pure-code release gate: keep full quiescence for schema migrations, but
 * permit only claimed Ready sessions with a succeeded parent business Run.
 * All incomplete Tasks, unresolved Runs and callbacks remain blocked.
 */
export function verifyWorkflowCodeReleaseReadiness(response, approvedTerminalArtifact = false) {
  invariant(Array.isArray(response) && response.length === 1 &&
    response[0]?.success === true && response[0]?.results?.length === 1,
    "Workflow code-only release D1 readback unavailable");
  const row=response[0].results[0];
  for (const key of [
    "migration_count","expected_migrations","nonterminal_runs",
    "unresolved_starts","unresolved_steps","invalid_cancelled_steps","nonterminal_attempts",
    "nonterminated_sessions","undelivered_callbacks","confirmed_ready_sessions",
    "verified_terminal_saga_receipts","reviewed_terminal_artifact_attempts",
  ]) invariant(Number.isSafeInteger(row?.[key]) && row[key]>=0,
    "Workflow code-only release count unavailable or invalid: "+key);
  invariant([20,21].includes(row.migration_count) &&
    row.expected_migrations===row.migration_count &&
    row.resolved_sha_column===1,
    "Workflow code-only release blocked by D1 migration drift");
  for (const key of [
    "nonterminal_runs","unresolved_starts","invalid_cancelled_steps","undelivered_callbacks",
  ]) invariant(row[key]===0,"Workflow code-only release blocked by "+key);
  invariant(row.unresolved_steps===row.verified_terminal_saga_receipts,
    "Workflow code-only release blocked by unresolved_steps");
  // Never equate a physically finished historical Task with business success.
  // A preceding exact-ID proof must grant this one code-only exception.
  invariant(row.reviewed_terminal_artifact_attempts<=1 &&
    (!approvedTerminalArtifact || row.reviewed_terminal_artifact_attempts===1),
    "Workflow code-only release missing exact historical Artifact Attempt");
  const reviewed=approvedTerminalArtifact?row.reviewed_terminal_artifact_attempts:0;
  invariant(row.nonterminal_attempts===row.confirmed_ready_sessions+reviewed &&
    row.nonterminated_sessions===row.confirmed_ready_sessions,
    "Workflow code-only release blocked by unconfirmed Session or Attempt");
  return {confirmed_ready_sessions:row.confirmed_ready_sessions};
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

async function main() {
  const [mode, worker] = process.argv.slice(2);
  invariant(["preflight", "readback", "cleanup-readback", "version", "diagnostic", "d1-check", "migration-sql", "migration-check", "code-release-check"].includes(mode), "Unknown release validation mode");
  if (mode === "migration-sql") {
    invariant(worker === "workflow-mcp-worker", "Migration SQL restricted to Workflow");
    console.log(reviewedTerminalRunSql(WORKFLOW_MIGRATION_READINESS_SQL));
    return;
  }
  if (mode === "code-release-check") {
    invariant(worker === "workflow-mcp-worker", "Release gate restricted to Workflow");
    const result = verifyWorkflowCodeReleaseReadiness(
      JSON.parse(await readFile("/dev/stdin", "utf8")),
      process.env.WORKFLOW_TWELFTH_TERMINAL_RUN_ID===TWELFTH_TERMINAL_RUN_ID);
    console.log("Workflow code-only release D1 gate: PASS " +
      JSON.stringify(result) + "; no migration, no unconfirmed execution");
    return;
  }
  if (mode === "migration-check") {
    invariant(worker === "workflow-mcp-worker", "Migration check restricted to Workflow");
    const observed = verifyWorkflowMigrationReadiness(
      JSON.parse(await readFile("/dev/stdin", "utf8")));
    console.log("Workflow migration D1 quiescence: PASS " +
      JSON.stringify(observed) + "; external GitHub/Cloudflare instance " +
      "and write-freeze checks NOT verified");
    return;
  }
  if (mode === "d1-check") {
    invariant(worker === "workflow-mcp-worker", "D1 check restricted to Workflow");
    const raw = await readFile("/dev/stdin", "utf8");
    verifyWorkflowD1Readiness(JSON.parse(raw),
      process.env.WORKFLOW_FIRST_DEPLOY === "true",
      process.env.WORKFLOW_REQUIRE_COMPLETE_SCHEMA === "true",
      process.env.UU_REQUIRE_CLEANUP_COMPLETE === "true");
    console.log("Workflow production D1 migrations and Run-state gate verified");
    return;
  }
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
  if (mode === "cleanup-readback") {
    invariant(["database-mcp-worker", "ssh-mcp-worker", "workflow-mcp-worker"].includes(worker),
      "Legacy cleanup readback Worker is not enabled");
    invariant(account && token && sourceSha && process.env.EXPECTED_VERSION_ID &&
      process.env.GITHUB_REPOSITORY === "lirtual/mcp-workers" &&
      process.env.GITHUB_REF === "refs/heads/main" && process.env.GITHUB_ACTOR === "lirtual",
      "Required cleanup readback environment missing");
    if (worker === "workflow-mcp-worker") invariant(
      process.env.WORKFLOW_MCP_PORTAL_CLIENT_ID &&
      process.env.WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES !== undefined,
      "Required Workflow cleanup readback identity inputs missing");
    if (worker === "database-mcp-worker") invariant(
      process.env.DATABASE_CONNECTIONS && process.env.DB_HOST !== undefined,
      "Required Database cleanup readback catalog inputs missing");
    // Cloudflare GET inventory only. No Wrangler, write endpoint, or release-state mutation.
    const observed = await current(account, worker, token, {
      mode: "readback", cleanupVerified: true, sourceConfig,
      expectedWorkflowPortalClientId: process.env.WORKFLOW_MCP_PORTAL_CLIENT_ID,
      expectedWorkflowGrants: process.env.WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES,
      ...(worker === "database-mcp-worker" ? {
        databaseConnections: process.env.DATABASE_CONNECTIONS,
        databaseVariables: { DB_HOST: process.env.DB_HOST },
        expectedDatabaseLimits: expectedDatabaseLimits(sourceConfig, process.env),
      } : {}),
    });
    invariant(observed.version_id === process.env.EXPECTED_VERSION_ID,
      "Legacy cleanup active Worker version differs from reviewed version");
    console.log("Legacy Secret cleanup readback PASS: " + worker +
      "; version=" + observed.version_id + "; no old Secrets remain");
    return;
  }
  invariant(account && token && statePath && sourceSha, "Required release environment missing");
  const previous = mode === "readback"
    ? JSON.parse(await readFile(statePath, "utf8")) : null;
  if (previous) invariant(previous.worker === worker && previous.sourceSha === sourceSha,
    "Release source changed");
  const exists = mode === "preflight" ? await scriptExists(account, worker, token) : true;
  if (mode === "preflight" && process.env.WORKFLOW_CODE_ONLY === "true")
    invariant(worker === "workflow-mcp-worker" && exists,
      "Code-only release requires an existing Workflow Worker");
  const read = async () => {
    const observed = await current(account, worker, token, {
      mode, sourceConfig, requireExistingSecrets: mode === "preflight" &&
        process.env.WORKFLOW_CODE_ONLY === "true", previousNamespaceId: previous?.previousNamespaceId,
      browserNamespaceId: previous?.browserNamespaceId,
      sharedAccessTeamDomain: ["browser-mcp-worker", "database-mcp-worker"].includes(worker)
        ? process.env.ACCESS_TEAM_DOMAIN : undefined,
      sharedOwnerEmail: ["browser-mcp-worker", "database-mcp-worker"].includes(worker)
        ? process.env.OWNER_EMAIL : undefined,
      databaseConnections: worker === "database-mcp-worker" ? process.env.DATABASE_CONNECTIONS : undefined,
      databaseVariables: {DB_HOST:process.env.DB_HOST},
      expectedDatabaseLimits: worker === "database-mcp-worker"
        ? expectedDatabaseLimits(sourceConfig, process.env) : undefined,
      expectedBrowserRememberedDays: worker === "browser-mcp-worker"
        ? process.env.BROWSER_REMEMBERED_IDLE_DAYS : undefined,
      expectedWorkflowPortalClientId: worker === "workflow-mcp-worker"
        ? process.env.WORKFLOW_MCP_PORTAL_CLIENT_ID : undefined,
      expectedWorkflowGrants: worker === "workflow-mcp-worker"
        ? process.env.WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES : undefined,
      expectedBrowserActivationAudience: worker === "browser-mcp-worker"
        ? process.env.BROWSER_ACTIVATION_EXPECTED : undefined,
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
  if (mode === "preflight") {
    await writeFile(statePath, JSON.stringify({ worker, sourceSha, ...observed }), { mode: 0o600 });
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
