// Narrow, credential-free-to-import Cloudflare release checks for #19.
// Never log API bodies: Workers settings can include runtime plain-text values.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKERS = new Set(["raindrop-mcp-worker", "ima-mcp-worker", "database-mcp-worker", "ssh-mcp-worker", "remote-control-mcp-worker"]);
const REQUIRED_SECRETS = {
  "raindrop-mcp-worker": ["MCP_ACCESS_TOKEN", "RAINDROP_ACCESS_TOKEN"],
  "ima-mcp-worker": ["MCP_ACCESS_TOKEN", "API_KEY", "CLIENT_ID"],
  "database-mcp-worker": ["MCP_ACCESS_TOKEN", "DATABASE_CONFIG"],
  "ssh-mcp-worker": ["MCP_ACCESS_TOKEN", "MCP_BROKER_TOKEN"],
  "remote-control-mcp-worker": ["MCP_ACCESS_TOKEN"],
};
const WORKER_ENTRIES = {
  "raindrop-mcp-worker": "src/worker.ts",
  "ima-mcp-worker": "src/index.ts",
  "database-mcp-worker": "src/index.ts",
  "ssh-mcp-worker": "src/index.ts",
  "remote-control-mcp-worker": "src/worker.ts",
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
    invariant(secretNames.has(name), "Required runtime Secret missing: " + name);
    invariant(!!find(name, "secret_text"), "Required Secret binding missing: " + name);
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
  if (worker === "ima-mcp-worker") {
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
  const remoteLegacy = worker === "remote-control-mcp-worker" &&
    options.mode === "preflight" && !!find("REMOTE_CONTROL_DEVICE", "vpc_service");
  if (remoteLegacy) {
    invariant(secretNames.has("REMOTE_CONTROL_DEVICE_TOKEN"),
      "Legacy VPC rollback credential missing");
    const id = find("REMOTE_CONTROL_DEVICE", "vpc_service")?.service_id;
    invariant(typeof id === "string" && /^[a-fA-F0-9-]{36}$/.test(id),
      "Legacy Remote VPC identity missing");
  } else if (worker === "remote-control-mcp-worker") {
    const owner = find("V2_OWNER", "durable_object_namespace");
    invariant(typeof options.v2OwnerNamespaceId === "string" &&
      owner?.namespace_id === options.v2OwnerNamespaceId,
      "Production V2_OWNER must reference current Preview owner namespace");
    invariant(find("REMOTE_CONTROL_V2_ONLY", "plain_text")?.text === "true",
      "Production must be strictly v2-only");
    invariant(!bindings.some(x => x.type === "vpc_service" || x.name === "REMOTE_CONTROL_DEVICE"),
      "Production VPC binding must be removed");
  }
  const allowed = new Set(worker === "ima-mcp-worker"
    ? ["IMA_IMAGE_REFRESH_SHARD"]
    : worker === "database-mcp-worker" ? ["RATE_LIMITER"]
      : worker === "remote-control-mcp-worker" ? [remoteLegacy ? "REMOTE_CONTROL_DEVICE" : "V2_OWNER"]
        : worker === "ssh-mcp-worker" ? ["EDGE_SSH_BROKER", "SSH_OPERATIONS"] : []);
  for (const item of bindings) {
    if (!["plain_text", "secret_text"].includes(item.type)) {
      invariant(allowed.has(item.name), "Unexpected production resource binding: " + item.name);
    }
  }
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
  invariant(conf.name === worker && conf.main === WORKER_ENTRIES[worker],
    "Worker script name or entry differs from selected target");
  invariant(conf.keep_vars === (worker !== "remote-control-mcp-worker"),
    "Runtime variable cleanup must match selected Worker release contract");
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
    invariant(conf.vars?.REMOTE_CONTROL_V2_ONLY === "true" &&
      conf.vars?.REMOTE_CONTROL_V2_PREVIEW_ONLY === undefined &&
      !conf.vpc_services && !conf.exports && conf.preview_urls === false,
      "Production must be v2-only without VPC or new DO class exports");
    const bindings = conf.durable_objects?.bindings;
    invariant(Array.isArray(bindings) && bindings.length === 1 &&
      bindings[0]?.name === "V2_OWNER" &&
      bindings[0]?.class_name === "V2OwnerCoordinator" &&
      bindings[0]?.script_name === "remote-control-v2-preview",
      "Production must reference existing Preview DO owner, no new namespace");
  }
  return conf;
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
  let v2OwnerNamespaceId;
  if (worker === "remote-control-mcp-worker") {
    const preview = await cfGet(account, "remote-control-v2-preview", token, "/settings");
    const owners = preview.bindings?.filter(x =>
      x.name === "V2_OWNER" && x.type === "durable_object_namespace" &&
      x.class_name === "V2OwnerCoordinator");
    invariant(owners?.length === 1 && typeof owners[0].namespace_id === "string",
      "Preview V2_OWNER identity unavailable");
    v2OwnerNamespaceId = owners[0].namespace_id;
  }
  verifyBindings(worker, settings, secrets, { ...options, v2OwnerNamespaceId });
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
  return activeVersion(deployments);
}

async function main() {
  const [mode, worker] = process.argv.slice(2);
  invariant(["preflight", "readback", "version", "diagnostic"].includes(mode), "Unknown release validation mode");
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
  const exists = mode === "preflight" ? await scriptExists(account, worker, token) : true;
  invariant(exists || worker !== "remote-control-mcp-worker",
    "Remote Control may not be created through bootstrap");
  const observed = exists ? await current(account, worker, token, {
    mode, sourceConfig,
  }) : { mode: "bootstrap" };
  if (mode === "preflight") {
    await writeFile(statePath, JSON.stringify({ worker, sourceSha, ...observed }), { mode: 0o600 });
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, "bootstrap=" + (!exists) + "\n");
    }
    console.log("Preflight OK: " + worker + " (" + (exists ? "update" : "bootstrap") +
      "; source " + sourceSha.slice(0, 12) + ")");
  } else {
    const previous = JSON.parse(await readFile(statePath, "utf8"));
    invariant(previous.worker === worker && previous.sourceSha === sourceSha, "Release source changed");
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
