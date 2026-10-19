// Only explicitly supported GitHub Variables may override non-secret Worker vars.
// The selected Worker is the sole target. Never forward the whole GitHub vars context.
import { writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
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
  "ima-mcp-worker": ["IMA_BASE_URL"],
  "database-mcp-worker": [
    "MAX_ROWS", "MAX_RESULT_BYTES", "MAX_SCHEMA_BYTES", "QUERY_TIMEOUT_MS",
    "MAX_WRITE_AFFECTED_ROWS",
  ],
  "ssh-mcp-worker": [],
  "remote-control-mcp-worker": [],
});

export function collectWorkerVars(worker, env) {
  const allowed = WORKER_VARIABLES[worker];
  if (!allowed) throw new Error("Unsupported Worker release target");
  const variables = [];
  for (const name of allowed) {
    const value = env[name];
    if (value == null || value === "") continue;
    if (typeof value !== "string") throw new Error("Invalid Worker Variable: " + name);
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
  const flags = collectWorkerVars(worker, process.env);
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
