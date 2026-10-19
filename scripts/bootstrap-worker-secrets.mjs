// Safe, fail-closed JSON staging for a *missing* Worker during manual production bootstrap.
// Never print, interpolate in the shell, or commit secret values.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const BOOTSTRAP_SECRETS = Object.freeze({
  "raindrop-mcp-worker": ["MCP_ACCESS_TOKEN", "RAINDROP_ACCESS_TOKEN"],
  "ima-mcp-worker": ["MCP_ACCESS_TOKEN", "API_KEY", "CLIENT_ID"],
  "database-mcp-worker": ["MCP_ACCESS_TOKEN", "DATABASE_CONFIG"],
  "ssh-mcp-worker": ["MCP_ACCESS_TOKEN", "MCP_BROKER_TOKEN"],
});

export function parseBootstrapSecrets(worker, source) {
  const required = BOOTSTRAP_SECRETS[worker];
  if (!required) throw new Error("Bootstrap is not enabled for this Worker");
  if (!source || typeof source !== "string") {
    throw new Error("Missing worker-specific production bootstrap secret");
  }
  let values;
  try {
    values = JSON.parse(source);
  } catch {
    throw new Error("Bootstrap secrets must be valid JSON");
  }
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("Bootstrap secrets must be a JSON object");
  }
  const names = Object.keys(values);
  if (names.length !== required.length || required.some((name) =>
    !Object.hasOwn(values, name) || typeof values[name] !== "string" ||
    values[name].length === 0
  ) || names.some((name) => !required.includes(name))) {
    throw new Error("Bootstrap secret keys and nonempty string values must match selected Worker exactly");
  }
  if (worker === "ssh-mcp-worker" && values.MCP_BROKER_TOKEN.length < 32) {
    throw new Error("SSH Broker token must be at least 32 characters");
  }
  return Object.fromEntries(required.map((name) => [name, values[name]]));
}

async function main() {
  const [worker, outputPath] = process.argv.slice(2);
  if (!outputPath || !process.env.RUNNER_TEMP ||
      !resolve(outputPath).startsWith(resolve(process.env.RUNNER_TEMP) + "/")) {
    throw new Error("Bootstrap secrets must be staged in the Actions runner temporary directory");
  }
  const payload = parseBootstrapSecrets(worker, process.env.WORKER_SECRETS_JSON);
  await writeFile(outputPath, JSON.stringify(payload), { flag: "wx", mode: 0o600 });
  console.log("Worker-specific bootstrap secrets staged securely (values withheld)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error("Bootstrap secrets preparation failed: " + error.message);
    process.exitCode = 1;
  });
}
