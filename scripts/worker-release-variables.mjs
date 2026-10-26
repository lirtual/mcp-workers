// Only explicitly supported GitHub Variables may override non-secret Worker vars.
// The selected Worker is the sole target. Never forward the whole GitHub vars context.
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const INTEGER_LIMITS = Object.freeze({
  RAINDROP_RATE_LIMIT_MAX_RETRIES: [0, 10],
  MAX_ROWS: [1, 5000],
  MAX_RESULT_BYTES: [1, 8388608],
  MAX_SCHEMA_BYTES: [1, 4194304],
  QUERY_TIMEOUT_MS: [1, 60000],
  MAX_WRITE_AFFECTED_ROWS: [1, 100],
});

export const WORKER_VARIABLES = Object.freeze({
  "raindrop-mcp-worker": ["RAINDROP_RATE_LIMIT_MAX_RETRIES"],
  "ima-mcp-worker": ["IMA_CLIENT_ID", "IMA_BASE_URL"],
  "database-mcp-worker": [
    "MAX_ROWS", "MAX_RESULT_BYTES", "MAX_SCHEMA_BYTES", "QUERY_TIMEOUT_MS",
    "MAX_WRITE_AFFECTED_ROWS",
  ],
  "email-mcp-worker": [],
  "ssh-mcp-worker": [],
  "remote-control-mcp-worker": [],
  "github-actions-mcp-worker": [],
  "http-mcp-worker": [],
  "workflow-mcp-worker": ["MCP_PORTAL_CLIENT_ID"],
});

// The Wrangler Custom Domain is the one authoritative installation origin.
// Deriving it removes duplicated hostnames in application code and GitHub vars.
export function remoteControlInstallOrigin(config) {
  const routes = config?.routes;
  if (!Array.isArray(routes) || routes.length !== 1 ||
      routes[0]?.custom_domain !== true ||
      typeof routes[0]?.pattern !== "string") {
    throw new Error("Remote Control requires exactly one Custom Domain");
  }
  const host = routes[0].pattern;
  if (host.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
    throw new Error("Invalid Remote Control Custom Domain hostname");
  }
  return "https://" + host;
}

export function collectWorkerVars(worker, env, options = {}) {
  const allowed = WORKER_VARIABLES[worker];
  if (!allowed) throw new Error("Unsupported Worker release target");
  const variables = [];
  if (worker === "workflow-mcp-worker") {
    variables.push(
      "MCP_PORTAL_ENDPOINT:https://mcp.lirtual.dpdns.org/mcp",
      "GITHUB_ACTION_OIDC_AUDIENCE:workflow-github-action:production"
    );
    // Repository onboarding is an explicit GitHub Environment Variable.
    // The owner must approve a repository ID and its immutable commit SHA;
    // ordinary workflow inputs cannot add execution/discovery grants.
    const grants = env.GITHUB_ACTION_APPROVED_REPOSITORIES;
    if (grants != null && grants !== "") {
      if (typeof grants !== "string" || grants.length > 8192) {
        throw new Error("Invalid GITHUB_ACTION_APPROVED_REPOSITORIES");
      }
      let parsed;
      try { parsed = JSON.parse(grants); }
      catch { throw new Error("Invalid GITHUB_ACTION_APPROVED_REPOSITORIES"); }
      const seen = new Set();
      if (!Array.isArray(parsed) || parsed.length > 16 ||
          parsed.some(entry => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
            const keys = Object.keys(entry).sort().join(",");
            const name = entry.repository;
            if (keys !== "commitSha,repository,repositoryId" ||
                typeof name !== "string" ||
                !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) ||
                name.includes("..") ||
                !Number.isSafeInteger(entry.repositoryId) || entry.repositoryId <= 0 ||
                typeof entry.commitSha !== "string" ||
                !/^[a-f0-9]{40}$/i.test(entry.commitSha) ||
                seen.has(name.toLowerCase())) return true;
            seen.add(name.toLowerCase());
            return false;
          })) throw new Error("Invalid GITHUB_ACTION_APPROVED_REPOSITORIES");
      variables.push("GITHUB_ACTION_APPROVED_REPOSITORIES:" + JSON.stringify(parsed));
    }
  }
  if (worker === "remote-control-mcp-worker") {
    const origin=remoteControlInstallOrigin(options.config);
    variables.push("REMOTE_CONTROL_INSTALL_ORIGIN:" + origin);
  }
  for (const name of allowed) {
    const value = env[name];
    if ((name === "IMA_CLIENT_ID" || name === "MCP_PORTAL_CLIENT_ID") &&
        (typeof value !== "string" || value.trim().length === 0)) {
      throw new Error("Missing or empty required Worker Variable: " + name);
    }
    if (value == null || value === "") continue;
    if (typeof value !== "string") throw new Error("Invalid Worker Variable: " + name);
    if ((name === "IMA_CLIENT_ID" || name === "MCP_PORTAL_CLIENT_ID") &&
        (value.length > 512 || value.trim() !== value ||
          /[\u0000-\u001f\u007f\s]/.test(value))) {
      throw new Error("Invalid Worker Variable: " + name);
    }
    if (Object.hasOwn(INTEGER_LIMITS, name)) {
      const [min, max] = INTEGER_LIMITS[name];
      if (!/^(0|[1-9][0-9]*)$/.test(value) ||
          !Number.isSafeInteger(Number(value)) ||
          Number(value) < min || Number(value) > max) {
        throw new Error("Invalid numeric Worker Variable: " + name);
      }
    } else if (name === "IMA_BASE_URL") {
      let parsed;
      try { parsed = new URL(value); } catch { throw new Error("Invalid IMA_BASE_URL"); }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
          parsed.hash || value.length > 1024 || /[\r\n]/.test(value)) {
        throw new Error("Invalid IMA_BASE_URL");
      }
    }
    variables.push(name + ":" + value);
  }
  return variables;
}

async function main() {
  const [worker, outputPath] = process.argv.slice(2);
  const root = process.env.RUNNER_TEMP;
  if (!outputPath || !root || !resolve(outputPath).startsWith(resolve(root) + sep)) {
    throw new Error("Worker vars must be staged inside runner temporary directory");
  }
  // Source config drives the single trusted origin; no extra GitHub Variable is required.
  const config = worker === "remote-control-mcp-worker"
    ? JSON.parse((await readFile(join(process.cwd(), "apps", worker, "wrangler.jsonc"), "utf8"))
      .replace(/^\s*\/\/.*$/gm, "")) : undefined;
  const flags = collectWorkerVars(worker, process.env, { config });
  await writeFile(outputPath, flags.length ? flags.join("\n") + "\n" : "",
    { flag: "wx", mode: 0o600 });
  console.log("Selected Worker Variables validated: " + flags.length + " override(s)");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error("Worker Variable preparation failed: " + error.message);
    process.exitCode = 1;
  });
}
