// Manual-only release safety checks. Runtime secret values are never read or printed.
import { readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKERS = {
  "raindrop-mcp-worker": ["MCP_ACCESS_TOKEN", "RAINDROP_ACCESS_TOKEN"],
  "ima-mcp-worker": ["MCP_ACCESS_TOKEN", "API_KEY", "CLIENT_ID"],
  "database-mcp-worker": ["MCP_ACCESS_TOKEN", "DATABASE_CONFIG"],
  "remote-control-mcp-worker": ["MCP_ACCESS_TOKEN", "REMOTE_CONTROL_DEVICE_TOKEN"],
};
const VPC_PLACEHOLDER = "00000000-0000-4000-8000-000000000000";
const REMOTE_CONFIG = "apps/remote-control-mcp-worker/wrangler.release.jsonc";

function requireThat(ok, message) {
  if (!ok) throw new Error(message);
}

export function parseConfig(text) {
  // Checked-in configs only use full-line // comments.
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
}

function binding(bindings, name, type) {
  return (bindings || []).find((item) => item.name === name && item.type === type);
}

export function verifyWorker(worker, config, settings, secrets, scriptSettings, phase, vpcId) {
  requireThat(Object.hasOwn(WORKERS, worker), "Worker is not allowlisted");
  requireThat(config.name === worker && config.keep_vars === true && !!config.main, "Worker name, entry or keep_vars differs");
  requireThat(config.workers_dev === true, "Expected workers.dev entry missing");
  const required = WORKERS[worker];
  requireThat(required.every((name) => config.secrets?.required?.includes(name)), "Required secret declarations missing");
  for (const name of required) {
    requireThat((secrets || []).some((item) => item.name === name && item.type === "secret_text"), "Required runtime Secret name missing");
    requireThat(!!binding(settings.bindings, name, "secret_text"), "Required runtime Secret binding missing");
  }

  requireThat(config.compatibility_date === settings.compatibility_date, "Compatibility date drift");
  const desiredLogs = config.observability?.logs?.invocation_logs;
  requireThat(typeof desiredLogs === "boolean", "Invocation logging declaration missing");
  for (const obs of [settings.observability, scriptSettings.observability]) {
    requireThat(obs?.enabled === config.observability.enabled, "Observability enabled drift");
    requireThat(obs?.logs?.invocation_logs === desiredLogs, "Invocation logging drift");
    if (typeof config.observability?.traces?.enabled === "boolean") {
      requireThat(obs?.traces?.enabled === config.observability.traces.enabled, "Tracing drift");
    }
  }

  const resources = [];
  if (worker === "ima-mcp-worker") {
    const imageShard = config.durable_objects?.bindings?.find((item) => item.name === "IMA_IMAGE_REFRESH_SHARD");
    requireThat(imageShard?.class_name === "ImaImageRefreshShard", "IMA durable object class missing");
    requireThat(config.exports?.ImaImageRefreshShard?.storage === "sqlite", "IMA SQLite DO export missing");
    const live = binding(settings.bindings, "IMA_IMAGE_REFRESH_SHARD", "durable_object_namespace");
    requireThat(live?.class_name === imageShard.class_name, "IMA DO binding missing or class drift");
    requireThat(!(config.r2_buckets || []).length, "IMA source still declares legacy R2 binding");
    resources.push("IMA_IMAGE_REFRESH_SHARD");
    if (phase === "before") resources.push("R2_BUCKET");
    // The previous R2 Worker binding is a known functional cutover.
    if (phase === "after") {
      requireThat(!settings.bindings.some((item) => item.name === "R2_BUCKET"), "Legacy IMA R2 Worker binding still present");
    }
  }
  if (worker === "database-mcp-worker") {
    const planned = config.ratelimits?.find((item) => item.name === "RATE_LIMITER");
    const live = binding(settings.bindings, "RATE_LIMITER", "ratelimit");
    requireThat(!!planned && !!live, "Database RATE_LIMITER binding missing");
    requireThat(String(live.namespace_id) === String(planned.namespace_id) &&
      Number(live.simple?.limit) === Number(planned.simple?.limit) &&
      Number(live.simple?.period) === Number(planned.simple?.period), "Database RATE_LIMITER limits drift");
    resources.push("RATE_LIMITER");
  }
  if (worker === "remote-control-mcp-worker") {
    const declared = config.vpc_services?.find((item) => item.binding === "REMOTE_CONTROL_DEVICE");
    const live = binding(settings.bindings, "REMOTE_CONTROL_DEVICE", "vpc_service");
    requireThat(declared?.service_id === VPC_PLACEHOLDER, "Checked-in Remote VPC placeholder changed");
    requireThat(!!vpcId && vpcId !== VPC_PLACEHOLDER &&
      /^[a-fA-F0-9-]{36}$/.test(vpcId) && live?.service_id === vpcId, "Remote VPC Service ID/type mismatch");
    resources.push("REMOTE_CONTROL_DEVICE");
    for (const name of ["REMOTE_CONTROL_ENABLE_FILE_WRITES", "REMOTE_CONTROL_ENABLE_SHELL"]) {
      const gate = binding(settings.bindings, name, "plain_text");
      requireThat(gate?.text === "true", "Approved Remote Control runtime permission is not enabled");
    }
    requireThat(desiredLogs === false, "Remote Control Invocation Logs must remain disabled");
  }
  // Do not silently drop another Cloudflare resource binding. IMA's R2 is the one approved exception.
  for (const item of settings.bindings || []) {
    if (!["plain_text", "secret_text"].includes(item.type)) {
      requireThat(resources.includes(item.name), "Unexpected production resource binding: " + item.name);
      requireThat(item.name !== "R2_BUCKET" || item.type === "r2_bucket", "Legacy IMA R2 binding type drift");
    }
  }
}

async function readCloudflare(worker) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  requireThat(!!token && /^[a-f0-9]{32}$/i.test(accountId || ""), "Dedicated Cloudflare deploy credentials are missing");
  const base = "https://api.cloudflare.com/client/v4/accounts/" + accountId +
    "/workers/scripts/" + encodeURIComponent(worker) + "/";
  async function get(which) {
    const response = await fetch(base + which, {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(15000),
    });
    requireThat(response.ok, "Cloudflare read-only " + which + " failed (HTTP " + response.status + ")");
    const envelope = await response.json();
    requireThat(envelope.success === true, "Cloudflare read-only " + which + " rejected");
    return envelope.result;
  }
  const [settings, secrets, scriptSettings, deployments] = await Promise.all([
    get("settings"), get("secrets"), get("script-settings"), get("deployments"),
  ]);
  return { settings, secrets, scriptSettings, deployments };
}

function activeVersion(deployments) {
  const latest = deployments?.deployments?.[0];
  const active = latest?.versions || [];
  requireThat(active.length === 1 && active[0].percentage === 100 &&
    /^[a-fA-F0-9-]{36}$/.test(active[0].version_id || ""), "Current active Worker version is not 100%");
  return active[0].version_id.toLowerCase();
}

export function parseWranglerVersion(text) {
  const match = text.match(/(?:Current )?Version ID:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  requireThat(!!match, "Wrangler did not report a verifiable deployed version");
  return match[1].toLowerCase();
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  const worker = process.env.SELECTED_WORKER;
  if (command === "version") {
    requireThat(!!arg, "Wrangler log file not provided");
    console.log(parseWranglerVersion(await readFile(arg, "utf8")));
    return;
  }
  requireThat(Object.hasOwn(WORKERS, worker), "Invalid selected Worker");
  const sourcePath = "apps/" + worker + "/wrangler.jsonc";
  const raw = await readFile(sourcePath, "utf8");
  const config = parseConfig(raw);
  if (command === "prepare-remote") {
    requireThat(worker === "remote-control-mcp-worker", "VPC substitution is Remote-only");
    requireThat((raw.match(new RegExp(VPC_PLACEHOLDER, "g")) || []).length === 1,
      "Remote VPC placeholder must occur exactly once");
    const id = process.env.REMOTE_CONTROL_VPC_SERVICE_ID;
    requireThat(!!id && id !== VPC_PLACEHOLDER && /^[a-fA-F0-9-]{36}$/.test(id), "Valid VPC ID required");
    await writeFile(REMOTE_CONFIG, raw.replace(VPC_PLACEHOLDER, id), { mode: 0o600, flag: "wx" });
    console.log("Temporary Remote Control Wrangler config created");
    return;
  }
  if (command === "cleanup-remote") {
    requireThat(worker === "remote-control-mcp-worker", "Remote-only cleanup");
    await rm(REMOTE_CONFIG, { force: true });
    return;
  }
  requireThat(["preflight", "readback"].includes(command), "Invalid release validation mode");
  const phase = command === "preflight" ? "before" : "after";
  const live = await readCloudflare(worker);
  verifyWorker(worker, config, live.settings, live.secrets, live.scriptSettings, phase,
    process.env.REMOTE_CONTROL_VPC_SERVICE_ID);
  const current = activeVersion(live.deployments);
  if (phase === "after") {
    requireThat(!!process.env.EXPECTED_VERSION_ID &&
      current === process.env.EXPECTED_VERSION_ID.toLowerCase(), "Active version differs from Wrangler release");
  }
  console.log(worker + " " + phase + " validation OK; active_version=" + current);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Do not output API bodies, authorization data, settings or full configs.
    console.error("Worker release validation failed: " + error.message);
    process.exitCode = 1;
  });
}
