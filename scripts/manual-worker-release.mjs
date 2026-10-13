// Narrow, credential-free-to-import Cloudflare release checks for #19.
// Never log API bodies: Workers settings can include runtime plain-text values.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKERS = new Set(["raindrop-mcp-worker", "ima-mcp-worker", "database-mcp-worker", "remote-control-mcp-worker"]);
const REQUIRED_SECRETS = {
  "raindrop-mcp-worker": ["MCP_ACCESS_TOKEN", "RAINDROP_ACCESS_TOKEN"],
  "ima-mcp-worker": ["MCP_ACCESS_TOKEN", "API_KEY", "CLIENT_ID"],
  "database-mcp-worker": ["MCP_ACCESS_TOKEN", "DATABASE_CONFIG"],
  "remote-control-mcp-worker": ["MCP_ACCESS_TOKEN", "REMOTE_CONTROL_DEVICE_TOKEN"],
};
const WORKER_ENTRIES = {
  "raindrop-mcp-worker": "src/worker.ts",
  "ima-mcp-worker": "src/index.ts",
  "database-mcp-worker": "src/index.ts",
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
  const logs = worker === "remote-control-mcp-worker" ? false : true;
  invariant(settings.observability?.enabled === true &&
    settings.observability?.logs?.invocation_logs === logs,
    "Unexpected Invocation Logs configuration");
  if (worker === "ima-mcp-worker") {
    const durable = find("IMA_IMAGE_REFRESH_SHARD", "durable_object_namespace");
    invariant(durable?.class_name === "ImaImageRefreshShard", "IMA Durable Object missing or class drift");
    invariant(settings.observability?.traces?.enabled === true, "IMA tracing drift");
    if (options.mode === "readback") {
      invariant(!bindings.some((x) => x.name === "R2_BUCKET"), "Legacy IMA R2 binding remains after cutover");
    } else if (bindings.some((x) => x.name === "R2_BUCKET")) {
      invariant(!!find("R2_BUCKET", "r2_bucket"), "IMA legacy R2 binding has an unexpected type");
      invariant(options.ackIma === true, "IMA public Litterbox cutover needs explicit acknowledgement");
    }
  }
  if (worker === "database-mcp-worker") {
    const limiter = find("RATE_LIMITER", "ratelimit");
    invariant(limiter && String(limiter.namespace_id) === "1001" &&
      Number(limiter.simple?.limit) === 120 && Number(limiter.simple?.period) === 60,
      "Database RATE_LIMITER binding/policy drift");
  }
  if (worker === "remote-control-mcp-worker") {
    const id = options.vpcId;
    invariant(typeof id === "string" && /^[a-fA-F0-9-]{36}$/.test(id) &&
      id !== "00000000-0000-4000-8000-000000000000", "Valid Remote VPC identity missing");
    invariant(find("REMOTE_CONTROL_DEVICE", "vpc_service")?.service_id === id,
      "Remote VPC Service binding/type mismatch");
    for (const name of ["REMOTE_CONTROL_ENABLE_FILE_WRITES", "REMOTE_CONTROL_ENABLE_SHELL"]) {
      invariant(find(name, "plain_text")?.text === "true",
        "Approved Remote Control permission gate drift: " + name);
    }
  }
  const allowed = new Set(worker === "ima-mcp-worker"
    ? ["IMA_IMAGE_REFRESH_SHARD", ...(options.mode === "preflight" ? ["R2_BUCKET"] : [])]
    : worker === "database-mcp-worker" ? ["RATE_LIMITER"]
      : worker === "remote-control-mcp-worker" ? ["REMOTE_CONTROL_DEVICE"] : []);
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
  invariant(previous.version_id !== observed.version_id &&
    previous.deployment_id !== observed.deployment_id, "Active Worker version did not change");
  return true;
}

function readConfiguration(worker, content) {
  const conf = JSON.parse(content.replace(/^\s*\/\/.*$/gm, ""));
  invariant(conf.name === worker && conf.main === WORKER_ENTRIES[worker],
    "Worker script name or entry differs from selected target");
  invariant(conf.keep_vars === true, "Runtime variable/Secret preservation must stay enabled");
  const logs = worker === "remote-control-mcp-worker" ? false : true;
  invariant(conf.observability?.logs?.invocation_logs === logs,
    "Source Invocation Logs setting differs from production");
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
  if (worker === "remote-control-mcp-worker") {
    const expected = "00000000-0000-4000-8000-000000000000";
    invariant(conf.vpc_services?.length === 1 &&
      conf.vpc_services[0]?.binding === "REMOTE_CONTROL_DEVICE" &&
      conf.vpc_services[0]?.service_id === expected,
      "Remote VPC source must retain one safe placeholder");
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

async function current(account, worker, token, options) {
  const [settings, secrets, deployments, scriptSettings] = await Promise.all([
    cfGet(account, worker, token, "/settings"),
    cfGet(account, worker, token, "/secrets"),
    cfGet(account, worker, token, "/deployments?per_page=1"),
    cfGet(account, worker, token, "/script-settings"),
  ]);
  verifyBindings(worker, settings, secrets, options);
  if (options.sourceConfig) {
    invariant(settings.compatibility_date === options.sourceConfig.compatibility_date,
      "Compatibility date drift");
    const actualFlags = [...(settings.compatibility_flags || [])].sort();
    const expectedFlags = [...(options.sourceConfig.compatibility_flags || [])].sort();
    invariant(JSON.stringify(actualFlags) === JSON.stringify(expectedFlags),
      "Compatibility flag drift");
  }
  invariant(scriptSettings?.observability?.logs?.invocation_logs ===
    (worker === "remote-control-mcp-worker" ? false : true),
    "Script-level Invocation Logs drift");
  if (worker === "ima-mcp-worker") {
    invariant(scriptSettings?.observability?.traces?.enabled === true, "IMA script tracing drift");
  }
  return activeVersion(deployments);
}

async function main() {
  const [mode, worker] = process.argv.slice(2);
  invariant(["preflight", "readback", "prepare-remote", "version", "diagnostic"].includes(mode), "Unknown release validation mode");
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
  if (mode === "prepare-remote") {
    invariant(worker === "remote-control-mcp-worker", "Temporary config is Remote-only");
    const placeholder = "00000000-0000-4000-8000-000000000000";
    const id = process.env.REMOTE_CONTROL_VPC_SERVICE_ID;
    invariant(typeof id === "string" && id !== placeholder && /^[a-fA-F0-9-]{36}$/.test(id),
      "Remote VPC identity missing");
    invariant(rawConfig.split(placeholder).length === 2, "Expected one Remote VPC placeholder");
    const target = join(process.cwd(), "apps", worker, ".wrangler-release.jsonc");
    await writeFile(target, rawConfig.replace(placeholder, id), { mode: 0o600, flag: "wx" });
    console.log("Temporary Remote VPC deploy configuration ready");
    return;
  }
  invariant(account && token && statePath && sourceSha, "Required release environment missing");
  const observed = await current(account, worker, token, {
    mode,
    vpcId: process.env.REMOTE_CONTROL_VPC_SERVICE_ID,
    ackIma: process.env.IMA_PUBLIC_UPLOAD_ACK === "true",
    sourceConfig,
  });
  if (mode === "preflight") {
    await writeFile(statePath, JSON.stringify({ worker, sourceSha, ...observed }), { mode: 0o600 });
    console.log("Preflight OK: " + worker + " (source " + sourceSha.slice(0, 12) + ")");
  } else {
    const previous = JSON.parse(await readFile(statePath, "utf8"));
    invariant(previous.worker === worker && previous.sourceSha === sourceSha, "Release source changed");
    verifyPublishedVersion(previous, observed, process.env.EXPECTED_VERSION_ID);
    console.log("Release verified: " + worker + " version " + observed.version_id +
      " source " + sourceSha.slice(0, 12));
  }
}

if (process.argv[1]?.endsWith("/manual-worker-release.mjs")) {
  main().catch((error) => {
    console.error("Release validation failed: " + error.message);
    process.exitCode = 1;
  });
}
