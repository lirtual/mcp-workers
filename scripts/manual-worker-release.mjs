// Narrow, credential-free-to-import Cloudflare release checks for #19.
// Never log API bodies: Workers settings can include runtime plain-text values.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKERS = new Set(["raindrop-mcp-worker", "ima-mcp-worker", "database-mcp-worker", "ssh-mcp-worker", "remote-control-mcp-worker", "github-actions-mcp-worker", "workflow-mcp-worker"]);
const REQUIRED_SECRETS = {
  "raindrop-mcp-worker": ["MCP_ACCESS_TOKEN", "RAINDROP_ACCESS_TOKEN"],
  "ima-mcp-worker": ["MCP_ACCESS_TOKEN", "API_KEY"],
  "database-mcp-worker": ["MCP_ACCESS_TOKEN", "DATABASE_CONFIG"],
  "ssh-mcp-worker": ["MCP_ACCESS_TOKEN", "MCP_BROKER_TOKEN"],
  "remote-control-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "github-actions-mcp-worker": ["MCP_ACCESS_TOKEN", "GH_TOKEN"],
  "workflow-mcp-worker": ["MCP_ACCESS_TOKEN"],
};
const WORKER_ENTRIES = {
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
  if (worker === "ssh-mcp-worker") {
    invariant(settings.observability?.enabled !== true, "SSH observability must remain disabled");
    const broker = find("EDGE_SSH_BROKER", "service");
    invariant(broker?.service === "edgessh" && broker.entrypoint === "HostBrokerEntrypoint",
      "SSH Broker Service Binding missing or changed");
    invariant(find("SSH_OPERATIONS", "durable_object_namespace")?.class_name === "SshOperationsDO",
      "SSH Durable Object binding missing");
    invariant(!bindings.some((x) => ["EDGE_SSH_DB", "ENCRYPTION_KEY", "MCP_BROKER_FULL_ACCESS"].includes(x.name)),
      "SSH must not copy root decryption keys or enable unrestricted broker access");
  } else {
    const logs = worker === "remote-control-mcp-worker" ? false : true;
    invariant(settings.observability?.enabled === true &&
      settings.observability?.logs?.invocation_logs === logs,
      "Unexpected Invocation Logs configuration");
  }
  if (worker === "workflow-mcp-worker") {
    const d1 = find("DB", "d1");
    invariant((d1?.id || d1?.database_id) ===
      "c76850db-b5e3-4128-9150-849a1c9e8d74", "Workflow production D1 runtime binding drift");
    const flow = find("WORKFLOW", "workflow");
    if(options.mode==="readback") invariant(flow?.workflow_name === "workflow-mcp-runner" &&
      flow?.class_name === "WorkflowRunner", "Workflow native Workflow binding drift");
    if (options.mode === "readback") {
      invariant(find("MCP_PORTAL_ENDPOINT", "plain_text")?.text ===
        "https://mcp.lirtual.dpdns.org/mcp", "Pinned Workflow MCP Portal drift");
      const pins = {
        GITHUB_EXECUTOR_REPOSITORY: "lirtual/mcp-workers",
        GITHUB_EXECUTOR_REPOSITORY_ID: "1414936394",
        GITHUB_EXECUTOR_REF: "refs/heads/main",
        GITHUB_EXECUTOR_AUDIENCE: "workflow-github-claim:production",
      };
      for (const [name,value] of Object.entries(pins)) {
        invariant(find(name,"plain_text")?.text === value,
          "Workflow GitHub executor identity drift: " + name);
      }
      invariant(find("GITHUB_ACTION_OIDC_AUDIENCE","plain_text")?.text ===
        "workflow-github-action:production", "Workflow Action OIDC audience drift");
      for (const name of ["MCP_PORTAL_CLIENT_ID","MCP_PORTAL_CLIENT_SECRET","WORKFLOW_EXECUTOR_GITHUB_TOKEN"]) {
        invariant(secretNames.has(name) && !!find(name,"secret_text"),
          "Workflow runtime credential binding missing: " + name);
      }
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
    invariant(secretNames.has("GH_TOKEN") && !!find("GH_TOKEN", "secret_text"),
      "GitHub Actions GH_TOKEN Secret binding missing");
  }
  if (worker === "ima-mcp-worker") {
    // During preflight, accept a legacy CLIENT_ID secret because it will be
    // replaced by the selected GitHub Environment Variable at deploy time.
    // A successful readback MUST prove the type migration happened.
    if (options.mode !== "preflight") {
      const clientId = find("CLIENT_ID", "plain_text");
      invariant(typeof clientId?.text === "string" && clientId.text.trim().length > 0,
        "IMA CLIENT_ID must be a nonempty plain-text Variable after release");
      invariant(!find("CLIENT_ID", "secret_text") && !secretNames.has("CLIENT_ID"),
        "IMA legacy CLIENT_ID Secret still present after release");
    }
    const durable = find("IMA_IMAGE_REFRESH_SHARD", "durable_object_namespace");
    invariant(durable?.class_name === "ImaImageRefreshShard", "IMA Durable Object missing or class drift");
    invariant(settings.observability?.traces?.enabled === true, "IMA tracing drift");
    invariant(!bindings.some((x) => x.name === "R2_BUCKET"), "Legacy IMA R2 Worker binding remains");
  }
  if (worker === "database-mcp-worker") {
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
  const allowed = new Set(worker === "workflow-mcp-worker" ? ["DB", "WORKFLOW"] :
    worker === "ima-mcp-worker"
    ? ["IMA_IMAGE_REFRESH_SHARD"]
    : worker === "database-mcp-worker" ? ["RATE_LIMITER"]
      : worker === "ssh-mcp-worker" ? ["EDGE_SSH_BROKER", "SSH_OPERATIONS"]
      : worker === "remote-control-mcp-worker"
        ? (options.mode === "preflight"
          ? ["DEVICE_COORDINATOR", "V2_OWNER", "REMOTE_CONTROL_DEVICE"]
          : ["DEVICE_COORDINATOR"]) : []);
  for (const item of bindings) {
    if (!["plain_text", "secret_text"].includes(item.type)) {
      // Source manifest controls the new bindings; a production preflight may
      // still observe bindings that this release is about to remove.
      // Readback strictly verifies that no extra resource binding survives.
      if (!(worker === "workflow-mcp-worker" && options.mode === "preflight" && item.type === "service"))
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
    conf.d1_databases[0]?.database_name === "workflow-mcp-worker" &&
    conf.d1_databases[0]?.database_id === "c76850db-b5e3-4128-9150-849a1c9e8d74" &&
    conf.d1_databases[0]?.migrations_dir === "migrations", "Workflow approved production D1 drift");
  invariant(conf.workflows?.length === 1 && conf.workflows[0]?.binding === "WORKFLOW" &&
    conf.workflows[0]?.name === "workflow-mcp-runner" &&
    conf.workflows[0]?.class_name === "WorkflowRunner", "Workflow binding drift");
  invariant(!conf.services?.length, "Workflow must not retain Service Bindings");
  invariant(JSON.stringify(conf.secrets?.required) === JSON.stringify(["MCP_ACCESS_TOKEN"]),
    "Workflow Portal Secret declaration drift");
  invariant(!conf.vars || Object.keys(conf.vars).length===0,
    "Workflow MCP source cannot declare runtime feature flags");
  invariant(!(conf.compatibility_flags || []).includes("global_fetch_strictly_public"),
    "Workflow must never enable or import MCP dynamic-target behavior");
  return true;
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
  const complete = row?.migration_count === 7 &&
    row?.migration_v6 === 1 && row?.migration_v7 === 1 &&
    row?.session_table === 1 && row?.cancellation_table === 1;
  invariant(base && (requireCompleteSchema ? complete : (before || partial || complete)),
    "Workflow production D1 schema migrations missing, partial or drifted");
  invariant(Number.isSafeInteger(row?.active_runs) && row.active_runs === 0,
    "Workflow cannot redeploy while Runs are active or indeterminate");
  if(bootstrap) invariant(row.run_count === 0 && row.workflow_count === 0,
    "Workflow first deployment requires empty production Run and Workflow state");
  return true;
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

function readConfiguration(worker, content) {
  const conf = JSON.parse(content.replace(/^\s*\/\/.*$/gm, ""));
  if (worker === "workflow-mcp-worker") verifyWorkflowReleaseConfig(conf);
  invariant(conf.name === worker && conf.main === WORKER_ENTRIES[worker],
    "Worker script name or entry differs from selected target");
  invariant(conf.keep_vars === false,
    "GitHub/Wrangler must own all runtime Variables; keep_vars must be false");
  if (worker === "ssh-mcp-worker") {
    invariant(conf.observability?.enabled === false, "SSH observability must stay disabled");
  } else {
    const logs = worker === "remote-control-mcp-worker" ? false : true;
    invariant(conf.observability?.logs?.invocation_logs === logs,
      "Source Invocation Logs setting differs from production");
  }
  invariant(REQUIRED_SECRETS[worker].every((s) => conf.secrets?.required?.includes(s)),
    "Source required Secret names changed unexpectedly");
  if (worker === "ima-mcp-worker") {
    invariant(!conf.secrets?.required?.includes("CLIENT_ID"),
      "IMA CLIENT_ID must be provided as a Variable, not a Secret");
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
    invariant(conf.services?.length === 1 &&
      conf.services[0].binding === "EDGE_SSH_BROKER" &&
      conf.services[0].service === "edgessh" &&
      conf.services[0].entrypoint === "HostBrokerEntrypoint", "SSH Broker source binding missing");
    invariant(conf.durable_objects?.bindings?.length === 1 &&
      conf.durable_objects.bindings[0].name === "SSH_OPERATIONS" &&
      conf.durable_objects.bindings[0].class_name === "SshOperationsDO" &&
      conf.migrations?.[0]?.tag === "v1" &&
      conf.migrations[0].new_sqlite_classes?.includes("SshOperationsDO"), "SSH SQLite DO migration drift");
    invariant(!conf.d1_databases?.length && !conf.vars?.MCP_BROKER_FULL_ACCESS,
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

async function scriptExists(account, worker, token) {
  const url = "https://api.cloudflare.com/client/v4/accounts/" +
    encodeURIComponent(account) + "/workers/scripts?per_page=100";
  const response = await fetch(url, {
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
      (worker === "remote-control-mcp-worker" ? false : true),
      "Script-level Invocation Logs drift");
  }
  if (worker === "ima-mcp-worker") {
    invariant(scriptSettings?.observability?.traces?.enabled === true, "IMA script tracing drift");
  }
  return {
    ...activeVersion(deployments),
    ...(options.mode === "preflight" && typeof previousNamespaceId === "string"
      ? { previousNamespaceId } : {}),
  };
}

async function main() {
  const [mode, worker] = process.argv.slice(2);
  invariant(["preflight", "readback", "version", "diagnostic", "d1-check"].includes(mode), "Unknown release validation mode");
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
  invariant(account && token && statePath && sourceSha, "Required release environment missing");
  const previous = mode === "readback"
    ? JSON.parse(await readFile(statePath, "utf8")) : null;
  if (previous) invariant(previous.worker === worker && previous.sourceSha === sourceSha,
    "Release source changed");
  const exists = mode === "preflight" ? await scriptExists(account, worker, token) : true;
  const observed = exists ? await current(account, worker, token, {
    mode, sourceConfig, previousNamespaceId: previous?.previousNamespaceId,
  }) : { mode: "bootstrap" };
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
