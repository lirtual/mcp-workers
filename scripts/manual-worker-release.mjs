// Narrow, credential-free-to-import Cloudflare release checks for #19.
// Never log API bodies: Workers settings can include runtime plain-text values.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectWorkerVars, BROWSER_APPROVAL_VARIABLES } from "./worker-release-variables.mjs";
import { TERMINAL_RUN_ID, SECOND_TERMINAL_RUN_ID, THIRD_TERMINAL_RUN_ID, FOURTH_TERMINAL_RUN_ID, FIFTH_TERMINAL_RUN_ID, SIXTH_TERMINAL_RUN_ID } from "./workflow-terminal-run-exception.mjs";

const WORKERS = new Set(["browser-mcp-worker", "raindrop-mcp-worker", "ima-mcp-worker", "database-mcp-worker", "ssh-mcp-worker", "remote-control-mcp-worker", "github-actions-mcp-worker", "http-mcp-worker", "workflow-mcp-worker", "email-mcp-worker"]);
const REQUIRED_SECRETS = {
  "browser-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "raindrop-mcp-worker": ["MCP_ACCESS_TOKEN", "RAINDROP_ACCESS_TOKEN"],
  "ima-mcp-worker": ["MCP_ACCESS_TOKEN", "IMA_API_KEY"],
  "database-mcp-worker": ["MCP_ACCESS_TOKEN", "DATABASE_ENCRYPTION_KEY", "DATABASE_KEY_ID", "DATABASE_GITHUB_ACTIONS_TOKEN"],
  "email-mcp-worker": ["MCP_ACCESS_TOKEN", "MAIL_ENCRYPTION_KEY"],
  "ssh-mcp-worker": ["MCP_ACCESS_TOKEN", "ENCRYPTION_KEY"],
  "remote-control-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "github-actions-mcp-worker": ["MCP_ACCESS_TOKEN", "ACTIONS_GITHUB_DISPATCH_TOKENS"],
  "http-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "workflow-mcp-worker": ["MCP_ACCESS_TOKEN", "MCP_PORTAL_CLIENT_SECRET", "WORKFLOW_GITHUB_DISPATCH_TOKEN", "SESSION_RUNTIME_DATA_KEY"],
};
const WORKER_ENTRIES = {
  "browser-mcp-worker": "src/worker.ts",
  "raindrop-mcp-worker": "src/worker.ts",
  "ima-mcp-worker": "src/index.ts",
  "database-mcp-worker": "src/index.ts",
  "email-mcp-worker": "src/index.ts",
  "ssh-mcp-worker": "src/index.ts",
  "remote-control-mcp-worker": "src/worker.ts",
  "github-actions-mcp-worker": "src/index.ts",
  "http-mcp-worker": "src/index.ts",
  "workflow-mcp-worker": "src/index.ts",
};

function invariant(value, message) {
  if (!value) throw new Error(message);
}

// Original identities prepared and imported under the separately approved Spec #344 job.
const REQUIRED_LEGACY_IDS = Object.freeze(['b2b', 'scrape_relay']);

/** Cutover must preserve the explicitly reviewed logical connection IDs.
 * Never query the upstream databases or expose decrypted URLs/CA material. */
export function parseDatabaseCutoverIds(raw) {
  invariant(typeof raw === "string" && raw.length >= 3 && raw.length <= 4096,
    "Database migration expected IDs must be explicitly configured");
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw Error("Database migration expected IDs JSON invalid"); }
  invariant(Array.isArray(parsed) && parsed.length >= 1 && parsed.length <= 10 &&
    parsed.every(x => typeof x === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(x)) &&
    new Set(parsed).size === parsed.length,
    "Database migration expected IDs invalid or duplicate");
  return parsed;
}

/** Read-only D1 release gate. Counts IDs only; no upstream SQL or secrets. */
export function databaseD1ReadinessSql(expectedIds) {
  invariant(Array.isArray(expectedIds) && expectedIds.length >= 1 && expectedIds.length <= 10 &&
    expectedIds.every(x => typeof x === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(x)) &&
    new Set(expectedIds).size === expectedIds.length,
    "Database migration expected IDs invalid or duplicate");
  const idList = expectedIds.map(id => "'" + id + "'").join(",");
  // Only aggregate counts: no ciphertext, passwords, URLs or driver errors.
  return [
    "SELECT",
    "  (SELECT COUNT(*) FROM d1_migrations WHERE name IN ('0001_connections.sql','0002_transport_and_retired_ids.sql')) AS migration_count,",
    "  (SELECT COUNT(*) FROM database_connections) AS record_count,",
    "  (SELECT COUNT(*) FROM database_connections WHERE id IN (" + idList + ")) AS preserved_count,",
    "  (SELECT COUNT(*) FROM database_connections WHERE id IN (" + idList + ") AND status='active') AS active_count,",
    "  (SELECT COUNT(*) FROM retired_connection_ids) AS retired_count,",
    "  (SELECT COUNT(*) FROM database_connections WHERE id IN (SELECT id FROM retired_connection_ids)) AS reused_count,",
    "  (SELECT COUNT(*) FROM database_connections WHERE",
    "    revision < 1 OR status NOT IN ('active','disabled') OR",
    "    dialect NOT IN ('mysql','postgres') OR transport NOT IN ('direct','hyperdrive') OR",
    "    (transport='direct' AND (key_id IS NULL OR key_id = '' OR LENGTH(ciphertext) < 40 OR config_id IS NOT NULL OR binding_name IS NOT NULL)) OR",
    "    (transport='hyperdrive' AND (ciphertext IS NOT NULL OR key_id IS NOT NULL OR config_id IS NULL OR binding_name IS NULL))) AS malformed_count"
  ].join("\n") + ";";
}

export function verifyDatabaseD1Readiness(response, expectedCount, phase = 'cutover') {
  invariant(Number.isSafeInteger(expectedCount) && expectedCount >= 1 && expectedCount <= 10,
    "Database migration expected ID count missing");
  invariant(['cutover', 'registry'].includes(phase), "Database migration phase invalid");
  invariant(Array.isArray(response) && response.length === 1 &&
    response[0]?.success === true && response[0]?.results?.length === 1,
    "Database D1 read-only schema check unavailable");
  const row = response[0].results[0];
  for (const name of ["migration_count", "record_count", "preserved_count", "active_count", "retired_count", "reused_count", "malformed_count"])
    invariant(Number.isSafeInteger(row?.[name]) && row[name] >= 0,
      "Database D1 readiness count invalid: " + name);
  invariant(row.migration_count === 2, "Database D1 additive transport migration not applied");
  // The separate, always-on encrypted Direct prepublication gate enforces
  // exact active revision-2 legacy records while the old Worker is deployed.
  // Once the D1-backed Worker is already live, requiring those IDs to remain
  // active would prohibit the approved 0–10 incremental registry lifecycle.
  if (phase === 'cutover') {
    invariant(row.record_count >= expectedCount && row.preserved_count === expectedCount,
      "Database D1 missing reviewed legacy logical connection IDs");
    invariant(row.active_count === expectedCount,
      "Database production release blocked: reviewed legacy connections are disabled");
  }
  invariant(row.record_count <= 10 && row.reused_count === 0 && row.malformed_count === 0 &&
    row.preserved_count <= Math.min(row.record_count, expectedCount) &&
    row.active_count <= row.preserved_count,
    "Database D1 record inventory invalid");
  return { record_count: row.record_count, preserved_count: row.preserved_count,
    active_count: row.active_count };
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

/** #344: checked from reviewed source *before* any production publish step.
 * An unbound D1 Worker would return 503 and drop every existing connection. */
export function verifyDatabaseCutoverSource(conf) {
  invariant(conf?.name === "database-mcp-worker" &&
    conf.main === "src/index.ts", "Database source identity drift");
  const secrets = conf.secrets?.required;
  invariant(Array.isArray(secrets) &&
    JSON.stringify([...secrets].sort()) ===
    JSON.stringify(["MCP_ACCESS_TOKEN", "DATABASE_ENCRYPTION_KEY", "DATABASE_KEY_ID", "DATABASE_GITHUB_ACTIONS_TOKEN"].sort()),
    "Database source must require D1 keys, never legacy DATABASE_CONFIG");
  const databases = conf.d1_databases;
  invariant(Array.isArray(databases) && databases.length === 1 &&
    databases[0]?.binding === "DB" &&
    databases[0]?.database_name === "database-mcp-registry" &&
    databases[0]?.database_id === "cbfe6a05-4979-4e6a-9cc2-4f6468586e4a" &&
    databases[0]?.migrations_dir === "migrations" &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(databases[0]?.database_id ?? ""),
    "Database dedicated production D1 not bound or not approved");
  const manifest = JSON.parse(readFileSync(new URL("../apps/database-mcp-worker/hyperdrive-bindings.json", import.meta.url), "utf8"));
  verifyDatabaseHyperdriveSource(conf, manifest);
  const ownerHost = conf.vars?.DATABASE_SETUP_HOST;
  invariant(typeof ownerHost === "string" &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(ownerHost) &&
    !ownerHost.endsWith(".workers.dev") &&
    Array.isArray(conf.routes) && conf.routes.length === 1 &&
    conf.routes[0]?.custom_domain === true &&
    conf.routes[0].pattern === ownerHost &&
    conf.workers_dev === true && conf.preview_urls === false,
    "Database Owner route and dedicated HTTPS hostname not configured");
  const limit = (name, namespaceId, max) => conf.ratelimits?.some(b =>
    b.name === name && String(b.namespace_id) === namespaceId &&
    Number(b.simple?.limit) === max && Number(b.simple?.period) === 60);
  invariant(conf.ratelimits?.length === 2 &&
    limit("RATE_LIMITER", "1001", 120) &&
    limit("SETUP_RATE_LIMITER", "1002", 20),
    "Database Owner and MCP rate-limit policies must be declared");
  return true;
}

export function verifyBindings(worker, settings, secrets, options = {}) {
  invariant(WORKERS.has(worker), "Release target not enabled");
  const bindings = settings?.bindings;
  invariant(Array.isArray(bindings), "Cloudflare bindings unavailable");
  const find = (name, type) => bindings.find((x) => x.name === name && x.type === type);
  const secretNames = new Set(Array.isArray(secrets) ? secrets.map((x) => x.name) : []);
  for (const name of REQUIRED_SECRETS[worker]) {
    // On preflight a missing runtime Secret can be repaired from GitHub.
    // The unconditional Secrets staging step fails closed before deployment.
    // Readback must still prove that every required Secret binding exists.
    if (options.mode !== "preflight") {
      invariant(secretNames.has(name), "Required runtime Secret missing: " + name);
      invariant(!!find(name, "secret_text"), "Required Secret binding missing: " + name);
    }
  }
  if (worker === "http-mcp-worker") {
    const managed = secretNames.has("HTTP_CREDENTIALS_JSON") &&
      !!find("HTTP_CREDENTIALS_JSON", "secret_text");
    const configured = options.expectedHttpCredentials === true;
    invariant(!find("HTTP_CREDENTIALS_JSON", "plain_text"),
      "Managed HTTP credentials must be a Secret");
    // --secrets-file preserves omitted Secrets. Block a stale credential when
    // the selected GitHub Environment no longer supplies it.
    if (options.mode === "preflight") {
      invariant(configured || (!bindings.some(b => b.name === "HTTP_CREDENTIALS_JSON") &&
        !secretNames.has("HTTP_CREDENTIALS_JSON")),
        "Stale HTTP_CREDENTIALS_JSON must be removed before release");
    } else {
      invariant(managed === configured &&
        secretNames.has("HTTP_CREDENTIALS_JSON") === configured &&
        bindings.some(b => b.name === "HTTP_CREDENTIALS_JSON") === configured,
        "Optional HTTP_CREDENTIALS_JSON binding inventory drift");
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
    const logs = ["remote-control-mcp-worker", "email-mcp-worker", "browser-mcp-worker"].includes(worker) ? false : true;
    invariant(settings.observability?.enabled === true &&
      settings.observability?.logs?.invocation_logs === logs,
      "Unexpected Invocation Logs configuration");
  }
  if (worker === "workflow-mcp-worker") {
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
      invariant(find("MCP_PORTAL_ENDPOINT", "plain_text")?.text ===
        "https://mcp.lirtual.dpdns.org/mcp", "Pinned Workflow MCP Portal drift");
      invariant(!bindings.some(x => ["GITHUB_EXECUTOR_REPOSITORY",
        "GITHUB_EXECUTOR_REPOSITORY_ID","GITHUB_EXECUTOR_REF",
        "GITHUB_EXECUTOR_AUDIENCE","GITHUB_TEST_WORKER_NAME",
        "GITHUB_TEST_DEDICATED_EXECUTOR"].includes(x.name)),
        "Retired fixed GitHub executor variables must be removed");
      invariant(find("GITHUB_ACTION_OIDC_AUDIENCE","plain_text")?.text ===
        "workflow-github-action:production", "Workflow Action OIDC audience drift");
      for (const name of ["MCP_PORTAL_CLIENT_SECRET","WORKFLOW_GITHUB_DISPATCH_TOKEN"]) {
        invariant(secretNames.has(name) && !!find(name,"secret_text"),
          "Workflow runtime credential binding missing: " + name);
      }
      invariant(bindings.filter(x => x.name === "MCP_PORTAL_CLIENT_ID").length === 1 &&
        typeof find("MCP_PORTAL_CLIENT_ID", "plain_text")?.text === "string" &&
        find("MCP_PORTAL_CLIENT_ID", "plain_text").text.trim().length > 0 &&
        !secretNames.has("MCP_PORTAL_CLIENT_ID"),
        "Workflow Portal Client ID must be exactly one plaintext Variable");
      const providerVersion=find("WEIXIN_ACTION_DEPLOYMENT_ID","plain_text");
      invariant(bindings.filter(x=>x.name==="WEIXIN_ACTION_DEPLOYMENT_ID").length===1 &&
        typeof providerVersion?.text==="string" &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(providerVersion.text) &&
        !secretNames.has("WEIXIN_ACTION_DEPLOYMENT_ID"),
        "Workflow reviewed Weixin Provider Version ID drift");
      const barkVersion=find("BARK_ACTION_DEPLOYMENT_ID","plain_text");
      invariant(bindings.filter(x=>x.name==="BARK_ACTION_DEPLOYMENT_ID").length===1 &&
        typeof barkVersion?.text==="string" &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(barkVersion.text) &&
        !secretNames.has("BARK_ACTION_DEPLOYMENT_ID"),
        "Workflow reviewed Bark Provider Version ID drift");
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
  if (worker === "email-mcp-worker") {
    const d1 = find("DB", "d1");
    invariant((d1?.id || d1?.database_id) === "1fa50616-effb-458e-b798-b1ca1a0da24f",
      "Email production D1 binding drift");
    const expected = { ACCESS_TEAM_DOMAIN: "lirtualzero.cloudflareaccess.com",
      ACCESS_AUD: "cea1cd806f0f68552c5bed2acd917afcaf8e18a7eda3fb19f5c9704c3a00cd1b",
      OWNER_EMAIL: "lirtual@outlook.com" };
    for (const [name, value] of Object.entries(expected)) {
      invariant(bindings.filter(b => b.name === name).length === 1 &&
        find(name, "plain_text")?.text === value && !secretNames.has(name),
        "Email production Access Variable drift: " + name);
    }
    invariant(!bindings.some(b => b.type === "plain_text" && !(b.name in expected)),
      "Email has unexpected plaintext bindings");
  }
  if (worker === "database-mcp-worker") {
    if (options.mode !== "preflight") {
      const source = options.sourceConfig;
      const expectedD1 = source?.d1_databases?.[0]?.database_id;
      invariant(expectedD1 &&
        (find("DB", "d1")?.id || find("DB", "d1")?.database_id) === expectedD1,
        "Database production D1 binding mismatch");
      const owner = find("DATABASE_SETUP_HOST", "plain_text");
      invariant(owner?.text === source?.vars?.DATABASE_SETUP_HOST,
        "Database Owner hostname not bound to reviewed custom domain");
      for (const name of ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "OWNER_EMAIL"]) {
        const text = find(name, "plain_text")?.text;
        invariant(typeof text === "string" && text.length > 0 && text.length <= 256,
          "Database Owner Access variable missing: " + name);
      }
      invariant(!find("DATABASE_CONFIG", "plain_text"), "Legacy DB catalog must not be a plain variable");
      const expectedHD = source?.hyperdrive ?? [];
      const actualHD = bindings.filter(b => b.type === "hyperdrive");
      invariant(actualHD.length === expectedHD.length && expectedHD.every(cfg =>
        actualHD.filter(b => b.name === cfg.binding && b.id === cfg.id).length === 1),
        "Database deployed Hyperdrive binding IDs differ from protected release manifest");
    }
    const setup = find("SETUP_RATE_LIMITER", "ratelimit");
    invariant(options.mode === "preflight" || (setup &&
      String(setup.namespace_id) === "1002" &&
      Number(setup.simple?.limit) === 20 && Number(setup.simple?.period) === 60),
      "Database SETUP_RATE_LIMITER missing or changed");
    const limiter = find("RATE_LIMITER", "ratelimit");
    invariant(limiter && String(limiter.namespace_id) === "1001" &&
      Number(limiter.simple?.limit) === 120 && Number(limiter.simple?.period) === 60,
      "Database RATE_LIMITER binding/policy drift");
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
    // The default release has only its DO and Bearer. An approved activation
    // must supply every owner binding with an exact production identity; never
    // accept a partially applied approval configuration or stale extra bindings.
    const approval = BROWSER_APPROVAL_VARIABLES.map(name => find(name, "plain_text"));
    const count = approval.filter(Boolean).length;
    invariant(count === 0 || count === BROWSER_APPROVAL_VARIABLES.length,
      "Browser approval binding inventory incomplete");
    if (count) {
      const env = Object.fromEntries(BROWSER_APPROVAL_VARIABLES.map((name, i) => [name, approval[i].text]));
      collectWorkerVars("browser-mcp-worker", env);
    }
    if (options.mode === "readback")
      invariant(count === (options.expectedBrowserApproval ? BROWSER_APPROVAL_VARIABLES.length : 0),
        "Browser approval binding inventory differs from reviewed GitHub Environment");
    invariant(coordinator?.class_name === "BrowserOwner" &&
      typeof coordinator.namespace_id === "string" && coordinator.namespace_id.length > 0 &&
      !coordinator.script_name && bindings.length === 2 + count &&
      !!find("MCP_ACCESS_TOKEN", "secret_text") &&
      !bindings.some(b => b.type === "plain_text" && !BROWSER_APPROVAL_VARIABLES.includes(b.name)),
      "Browser binding inventory drift");
    invariant(settings.observability?.logs?.head_sampling_rate === 0,
      "Browser logs sampling must remain zero");
    if (options.mode === "readback" && options.browserNamespaceId)
      invariant(coordinator.namespace_id === options.browserNamespaceId,
        "Browser namespace changed; preserve pairing and Unknown receipts");
  }
  const allowed = new Set(worker === "browser-mcp-worker" ? ["BROWSER_OWNER"] : worker === "workflow-mcp-worker"
    ? (options.mode === "preflight" ? ["DB", "WORKFLOW", "WORKFLOW_LEGACY", "WEIXIN_ACTION_PROVIDER", "BARK_ACTION_PROVIDER"] : ["DB", "WORKFLOW", "WEIXIN_ACTION_PROVIDER", "BARK_ACTION_PROVIDER"]) :
    worker === "email-mcp-worker" ? ["DB"] :
    worker === "ima-mcp-worker"
    ? ["IMA_IMAGE_REFRESH_SHARD"]
    : worker === "database-mcp-worker"
      ? ["RATE_LIMITER", "SETUP_RATE_LIMITER", "DB", ...((options.sourceConfig?.hyperdrive ?? []).map(x => x.binding))]
      : worker === "ssh-mcp-worker" ? (options.mode === "preflight" ? ["EDGE_SSH_BROKER", "EDGE_SSH_DB", "SSH_OPERATIONS"] : ["EDGE_SSH_DB", "SSH_OPERATIONS"])
      : worker === "remote-control-mcp-worker"
        ? (options.mode === "preflight"
          ? ["DEVICE_COORDINATOR", "V2_OWNER", "REMOTE_CONTROL_DEVICE"]
          : ["DEVICE_COORDINATOR"]) : []);
  if (worker === "workflow-mcp-worker" && options.mode === "readback") {
    invariant(bindings.filter(x=>x.name === "WEIXIN_ACTION_PROVIDER").length === 1 &&
      !!find("WEIXIN_ACTION_PROVIDER", "service"),
      "Workflow reviewed Weixin Service Binding missing after release");
    invariant(bindings.filter(x=>x.name === "BARK_ACTION_PROVIDER").length === 1 &&
      !!find("BARK_ACTION_PROVIDER", "service"),
      "Workflow reviewed Bark Service Binding missing after release");
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
  invariant(conf.services?.length === 2 &&
    conf.services[0]?.binding === "WEIXIN_ACTION_PROVIDER" &&
    conf.services[0]?.service === "weixin-mcp-worker" &&
    conf.services[0]?.entrypoint === "WeixinActionProvider" &&
    conf.services[1]?.binding === "BARK_ACTION_PROVIDER" &&
    conf.services[1]?.service === "bark-provider" &&
    conf.services[1]?.entrypoint === "BarkActionProvider" &&
    conf.services.every(x=>Object.keys(x).sort().join(",")==="binding,entrypoint,service"),
    "Workflow reviewed Cloudflare Service Bindings drift");
  invariant(JSON.stringify(conf.secrets?.required) === JSON.stringify(["MCP_ACCESS_TOKEN", "MCP_PORTAL_CLIENT_SECRET", "WORKFLOW_GITHUB_DISPATCH_TOKEN", "SESSION_RUNTIME_DATA_KEY"]),
    "Workflow Portal Secret declaration drift");
  invariant(!conf.vars || Object.keys(conf.vars).length===0,
    "Workflow MCP source cannot declare runtime feature flags");
  invariant(!(conf.compatibility_flags || []).includes("global_fetch_strictly_public"),
    "Workflow must never enable or import MCP dynamic-target behavior");
  return true;
}

function reviewedTerminalRunSql(sql) {
  const exclusions=[
    [process.env.WORKFLOW_TERMINAL_RUN_ID,TERMINAL_RUN_ID],
    [process.env.WORKFLOW_SECOND_TERMINAL_RUN_ID,SECOND_TERMINAL_RUN_ID],
    [process.env.WORKFLOW_THIRD_TERMINAL_RUN_ID,THIRD_TERMINAL_RUN_ID],
    [process.env.WORKFLOW_FOURTH_TERMINAL_RUN_ID,FOURTH_TERMINAL_RUN_ID],
    [process.env.WORKFLOW_FIFTH_TERMINAL_RUN_ID,FIFTH_TERMINAL_RUN_ID],
    [process.env.WORKFLOW_SIXTH_TERMINAL_RUN_ID,SIXTH_TERMINAL_RUN_ID],
  ].filter(([supplied,exact])=>supplied===exact).map(([,exact])=>exact);
  if(exclusions.length===0)return sql;
  const sqlIds=exclusions.map(id=>"'"+id+"'").join(",");
  return sql.replace(
    "outcome NOT IN ('succeeded','failed','cancelled')) AS nonterminal_runs",
    "outcome NOT IN ('succeeded','failed','cancelled') AND id NOT IN ("+sqlIds+")) AS nonterminal_runs"
  ).replace(
    "status NOT IN ('succeeded','failed','skipped')) AS unresolved_steps",
    "status NOT IN ('succeeded','failed','skipped') AND run_id NOT IN ("+sqlIds+")) AS unresolved_steps"
  );
}

export function verifyWorkflowD1Readiness(response, bootstrap, requireCompleteSchema = false) {
  invariant(Array.isArray(response) && response.length === 1 &&
    response[0]?.success === true && response[0]?.results?.length === 1,
    "Workflow remote D1 readback unavailable");
  const row = response[0].results[0];
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
  const fullV11Schema = row?.migration_v10 === 1 &&
    row?.migration_v11 === 1 && row?.runtime_table === 1 &&
    row?.capacity_column === 1 && row?.parent_column === 1 &&
    row?.parent_step_column === 1 && row?.child_index === 1 &&
    row?.child_cancel_table === 1 && row?.child_terminate_fence_column === 1 &&
    row?.capacity_guard_trigger === 1 &&
    row?.migration_v6 === 1 && row?.migration_v7 === 1 &&
    row?.migration_v8 === 1 && row?.migration_v9 === 1 &&
    row?.locator_column === 1 && row?.fixed_column === 1 && row?.fixed_index === 1 &&
    row?.session_table === 1 && row?.cancellation_table === 1;
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
  const complete = row?.migration_count === 15 &&
    row?.migration_v12 === 1 && row?.event_receipts_table === 1 &&
    row?.migration_v13 === 1 && row?.invocations_table === 1 &&
    row?.cloudflare_cancel_table === 1 &&
    row?.migration_v14 === 1 && row?.deleted_column === 1 &&
    row?.migration_v15 === 1 && row?.approval_gates_table === 1 &&
    row?.approvals_table === 1 && fullV11Schema;
  invariant(base && (requireCompleteSchema ? complete : (before || partial || current || previous || oldComplete || runtimeComplete || completeV11 || completeV12 || completeV13 || completeV14 || complete)),
    "Workflow production D1 schema migrations missing, partial or drifted");
  invariant(Number.isSafeInteger(row?.active_runs) && row.active_runs === 0,
    "Workflow cannot redeploy while Runs are active or indeterminate");
  // D1 migration may change Session reservations even after the parent Run
  // succeeded at Ready. Require a physically quiescent Tailnet before schema
  // changes; completed-schema code-only releases use their separate gate.
  if(!complete) invariant(Number.isSafeInteger(row?.active_sessions) &&
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
    '0014_workflow_deletion.sql','0015_runtime_approval.sql')) AS expected_migrations,
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
   status NOT IN ('succeeded','failed','skipped')) AS unresolved_steps,
 (SELECT count(*) FROM step_attempts WHERE state IS NULL OR
   state NOT IN ('rejected','succeeded','failed','cancelled')) AS nonterminal_attempts,
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
    "nonterminal_runs","unresolved_starts","unresolved_steps",
    "nonterminal_attempts","nonterminated_sessions","undelivered_callbacks",
  ];
  for (const key of nonnegative) {
    invariant(Number.isSafeInteger(row?.[key]) && row[key] >= 0,
      "Workflow migration D1 count unavailable or invalid: " + key);
  }
  invariant([12,13,14,15].includes(row.migration_count) &&
    row.expected_migrations === row.migration_count,
    "Workflow migration requires the exact reviewed D1 migrations");
  for (const key of [
    "nonterminal_runs","unresolved_starts","unresolved_steps",
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
export function verifyWorkflowCodeReleaseReadiness(response) {
  invariant(Array.isArray(response) && response.length === 1 &&
    response[0]?.success === true && response[0]?.results?.length === 1,
    "Workflow code-only release D1 readback unavailable");
  const row=response[0].results[0];
  for (const key of [
    "migration_count","expected_migrations","nonterminal_runs",
    "unresolved_starts","unresolved_steps","nonterminal_attempts",
    "nonterminated_sessions","undelivered_callbacks","confirmed_ready_sessions",
  ]) invariant(Number.isSafeInteger(row?.[key]) && row[key]>=0,
    "Workflow code-only release count unavailable or invalid: "+key);
  invariant(row.migration_count===15 && row.expected_migrations===15,
    "Workflow code-only release blocked by D1 migration drift");
  for (const key of [
    "nonterminal_runs","unresolved_starts","unresolved_steps","undelivered_callbacks",
  ]) invariant(row[key]===0,"Workflow code-only release blocked by "+key);
  invariant(row.nonterminal_attempts===row.confirmed_ready_sessions &&
    row.nonterminated_sessions===row.confirmed_ready_sessions,
    "Workflow code-only release blocked by unconfirmed Session or Attempt");
  return {confirmed_ready_sessions:row.confirmed_ready_sessions};
}

export function parseWranglerVersion(output) {
  const match = output.match(/(?:Current )?Version ID:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  invariant(!!match, "Wrangler did not report a release Version ID");
  return match[1].toLowerCase();
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

export function readConfiguration(worker, content) {
  const conf = JSON.parse(content.replace(/^\s*\/\/.*$/gm, ""));
  if (worker === "workflow-mcp-worker") verifyWorkflowReleaseConfig(conf);
  if (worker === "database-mcp-worker") verifyDatabaseCutoverSource(conf);
  invariant(conf.name === worker && conf.main === WORKER_ENTRIES[worker],
    "Worker script name or entry differs from selected target");
  invariant(conf.keep_vars === false,
    "GitHub/Wrangler must own all runtime Variables; keep_vars must be false");
  if (worker === "ssh-mcp-worker") {
    invariant(conf.observability?.enabled === true &&
      conf.observability?.logs?.invocation_logs === true,
      "SSH observability and invocation logs must stay enabled");
  } else {
    const logs = ["remote-control-mcp-worker", "email-mcp-worker", "browser-mcp-worker"].includes(worker) ? false : true;
    invariant(conf.observability?.logs?.invocation_logs === logs,
      "Source Invocation Logs setting differs from production");
  }
  invariant(REQUIRED_SECRETS[worker].every((s) => conf.secrets?.required?.includes(s)),
    "Source required Secret names changed unexpectedly");
  if (worker === "http-mcp-worker") {
    invariant(conf.workers_dev === true && conf.preview_urls === false &&
      JSON.stringify(conf.compatibility_flags) === JSON.stringify(["global_fetch_strictly_public"]) &&
      JSON.stringify(conf.secrets?.required) === JSON.stringify(["MCP_ACCESS_TOKEN"]) &&
      !conf.services?.length && !conf.vpc_services && !conf.d1_databases?.length &&
      !conf.durable_objects?.bindings?.length && !conf.r2_buckets?.length &&
      !conf.ratelimits?.length && !conf.vars,
      "HTTP strict-public Worker source or binding drift");
  }
  if (worker === "email-mcp-worker") {
    invariant(JSON.stringify(conf.secrets?.required) === JSON.stringify(["MCP_ACCESS_TOKEN", "MAIL_ENCRYPTION_KEY"]),
      "Email source Secret declaration drift");
    const routes = conf.routes ?? [];
    invariant(conf.workers_dev === false && conf.preview_urls === false &&
      routes.length === 2 && routes.every(x => x.custom_domain === true) &&
      routes[0].pattern === "email.lirtual.dpdns.org" &&
      routes[1].pattern === "email-mcp.lirtual.dpdns.org",
      "Email production custom domains must keep Setup and MCP separate");
    invariant(conf.observability?.logs?.invocation_logs === false,
      "Email may not log mailbox operations");
    invariant(conf.d1_databases?.length === 1 &&
      conf.d1_databases[0].binding === "DB" &&
      conf.d1_databases[0].database_name === "email-mcp-db" &&
      conf.d1_databases[0].database_id === "1fa50616-effb-458e-b798-b1ca1a0da24f" &&
      conf.d1_databases[0].migrations_dir === "migrations",
      "Email production D1 source drift");
    invariant(!conf.vars || Object.keys(conf.vars).length === 0,
      "Email secrets must not be staged as plain-text vars");
  }
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
    invariant(Object.keys(conf).every(k=>["$schema","name","main","compatibility_date","compatibility_flags","workers_dev","preview_urls","keep_vars","durable_objects","migrations","observability","secrets","routes"].includes(k)) &&
      conf.workers_dev === false && conf.preview_urls === false &&
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
      (["remote-control-mcp-worker", "email-mcp-worker", "browser-mcp-worker"].includes(worker) ? false : true),
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

/** Cloudflare deployment version and Secret inventories may propagate
 * independently. Retry only these two exact post-deploy readback states;
 * identity, configuration, schema and other version failures remain fatal. */
export async function retryReleaseReadback(read, pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try { return await read(); }
    catch (error) {
      const message = error instanceof Error ? error.message : "";
      const transient = /^Required (Secret binding|runtime Secret) missing: /.test(message) ||
        message === "Optional HTTP_CREDENTIALS_JSON binding inventory drift" ||
        message === "Active Worker version does not match the Wrangler-published version";
      if (attempt === 5 || !transient) throw error;
      await pause(2000);
    }
  }
}

async function main() {
  const [mode, worker] = process.argv.slice(2);
  invariant(["preflight", "readback", "version", "diagnostic", "d1-check", "migration-sql", "migration-check", "code-release-check", "database-d1-sql", "database-d1-check"].includes(mode), "Unknown release validation mode");
  if (mode === "database-d1-sql") {
    invariant(worker === "database-mcp-worker", "Database SQL readiness target mismatch");
    console.log(databaseD1ReadinessSql(REQUIRED_LEGACY_IDS));
    return;
  }
  if (mode === "database-d1-check") {
    invariant(worker === "database-mcp-worker", "Database D1 readiness target mismatch");
    const expected = REQUIRED_LEGACY_IDS;
    // Generic registry shape only. Exact first-cutover ID, ciphertext and
    // revision checks are enforced separately by database-direct-preflight.
    const counts = verifyDatabaseD1Readiness(JSON.parse(await readFile("/dev/stdin", "utf8")),
      expected.length, 'registry');
    console.log("Database production D1 schema and encrypted-row shape: PASS; records=" +
      counts.record_count + "; first-cutover source and ciphertext are separately gated; live TLS requires separate evidence");
    return;
  }
  if (mode === "migration-sql") {
    invariant(worker === "workflow-mcp-worker", "Migration SQL restricted to Workflow");
    console.log(reviewedTerminalRunSql(WORKFLOW_MIGRATION_READINESS_SQL));
    return;
  }
  if (mode === "code-release-check") {
    invariant(worker === "workflow-mcp-worker", "Release gate restricted to Workflow");
    const result = verifyWorkflowCodeReleaseReadiness(
      JSON.parse(await readFile("/dev/stdin", "utf8")));
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
      process.env.WORKFLOW_REQUIRE_COMPLETE_SCHEMA === "true");
    console.log("Workflow production D1 migrations and Run-state gate verified");
    return;
  }
  if (mode === "diagnostic") {
    invariant(worker, "Wrangler log path missing");
    const log = await readFile(worker, "utf8");
    const codes = [...log.matchAll(/\b(?:error\s+code|code)\s*[:=]?\s*(\d{4,6})\b/gi)]
      .map((match) => match[1]).slice(0, 3);
    console.error("Wrangler diagnostic: stage=deploy; code=" +
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
  const previous = mode === "readback"
    ? JSON.parse(await readFile(statePath, "utf8")) : null;
  if (previous) invariant(previous.worker === worker && previous.sourceSha === sourceSha,
    "Release source changed");
  const exists = mode === "preflight" ? await scriptExists(account, worker, token) : true;
  const read = async () => {
    const observed = await current(account, worker, token, {
      mode, sourceConfig, previousNamespaceId: previous?.previousNamespaceId,
      browserNamespaceId: previous?.browserNamespaceId,
      expectedHttpCredentials: worker === "http-mcp-worker" && !!process.env.HTTP_CREDENTIALS_JSON,
      expectedBrowserApproval: worker === "browser-mcp-worker" &&
        process.env.BROWSER_APPROVAL_EXPECTED === "isolated-owner-profile-and-mailbox-v1",
    });
    // Compare active deployments inside the existing bounded retry loop.
    // Keep identity and binding drift failures fatal.
    if (mode === 'readback' && (worker === 'workflow-mcp-worker' || worker === 'http-mcp-worker'))
      verifyPublishedVersion(previous, observed, process.env.EXPECTED_VERSION_ID);
    return observed;
  };
  const observed = !exists ? { mode: "bootstrap" }
    : mode === "readback" && (worker === "workflow-mcp-worker" || worker === "http-mcp-worker")
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
