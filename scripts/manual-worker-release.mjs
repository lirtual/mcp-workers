// Narrow, credential-free-to-import Cloudflare release checks for #19.
// Never log API bodies: Workers settings can include runtime plain-text values.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const WORKERS = new Set(["raindrop-mcp-worker"]);
const REQUIRED_SECRETS = {
  "raindrop-mcp-worker": ["MCP_ACCESS_TOKEN", "RAINDROP_ACCESS_TOKEN"],
};

function invariant(value, message) {
  if (!value) throw new Error(message);
}

export function verifyBindings(worker, settings, secrets) {
  invariant(WORKERS.has(worker), "Release target not enabled");
  const bindings = settings?.bindings;
  invariant(Array.isArray(bindings), "Cloudflare bindings unavailable");
  const secretNames = new Set(Array.isArray(secrets) ? secrets.map((x) => x.name) : []);
  for (const name of REQUIRED_SECRETS[worker]) {
    invariant(secretNames.has(name), "Required runtime Secret missing: " + name);
    invariant(bindings.some((x) => x.name === name && x.type === "secret_text"),
      "Required Secret binding missing: " + name);
  }
  invariant(settings.observability?.logs?.invocation_logs === true,
    "Unexpected Invocation Logs configuration");
  return true;
}

export function activeVersion(deployments) {
  const deployment = deployments?.deployments?.[0];
  const versions = deployment?.versions;
  invariant(Array.isArray(versions) && versions.length === 1 &&
    versions[0]?.percentage === 100 && typeof versions[0]?.version_id === "string",
    "Active Worker version is not an unambiguous 100% release");
  return { deployment_id: deployment.id, version_id: versions[0].version_id };
}

function readConfiguration(worker, content) {
  const conf = JSON.parse(content.replace(/^\s*\/\/.*$/gm, ""));
  invariant(conf.name === worker, "Worker script name differs from selected target");
  invariant(conf.keep_vars === true, "Runtime variable/Secret preservation must stay enabled");
  invariant(conf.observability?.logs?.invocation_logs === true,
    "Source Invocation Logs setting differs from production");
  invariant(REQUIRED_SECRETS[worker].every((s) => conf.secrets?.required?.includes(s)),
    "Source required Secret names changed unexpectedly");
}

async function cfGet(account, worker, token, endpoint) {
  const url = "https://api.cloudflare.com/client/v4/accounts/" +
    encodeURIComponent(account) + "/workers/scripts/" + encodeURIComponent(worker) + endpoint;
  const response = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  invariant(response.ok, "Cloudflare read-only " + endpoint + " HTTP " + response.status);
  const document = await response.json();
  invariant(document?.success === true && document?.result != null,
    "Cloudflare read-only " + endpoint + " failed");
  return document.result;
}

async function current(account, worker, token) {
  const [settings, secrets, deployments] = await Promise.all([
    cfGet(account, worker, token, "/settings"),
    cfGet(account, worker, token, "/secrets"),
    cfGet(account, worker, token, "/deployments?per_page=1"),
  ]);
  verifyBindings(worker, settings, secrets);
  return activeVersion(deployments);
}

async function main() {
  const [mode, worker] = process.argv.slice(2);
  invariant(["preflight", "readback"].includes(mode), "Unknown release validation mode");
  invariant(WORKERS.has(worker), "Unsupported Worker target");
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const statePath = process.env.RELEASE_STATE_FILE;
  const sourceSha = process.env.GITHUB_SHA;
  invariant(account && token && statePath && sourceSha, "Required release environment missing");
  const configPath = join(process.cwd(), "apps", worker, "wrangler.jsonc");
  readConfiguration(worker, await readFile(configPath, "utf8"));
  const observed = await current(account, worker, token);
  if (mode === "preflight") {
    await writeFile(statePath, JSON.stringify({ worker, sourceSha, ...observed }), { mode: 0o600 });
    console.log("Preflight OK: " + worker + " (source " + sourceSha.slice(0, 12) + ")");
  } else {
    const previous = JSON.parse(await readFile(statePath, "utf8"));
    invariant(previous.worker === worker && previous.sourceSha === sourceSha, "Release source changed");
    invariant(previous.version_id !== observed.version_id &&
      previous.deployment_id !== observed.deployment_id, "Active Worker version did not change");
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
