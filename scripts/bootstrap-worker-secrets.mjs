// Stage only the selected Worker's GitHub Environment + repository secrets.
// Used for EVERY authorized manual release, not only for first deployment.
// GitHub resolves an Environment secret over a same-name repository secret.
// Never print credentials, and never fall back to the removed *_SECRETS_JSON.
import { writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const BOOTSTRAP_SECRETS = Object.freeze({
  "raindrop-mcp-worker": ["MCP_ACCESS_TOKEN", "RAINDROP_ACCESS_TOKEN"],
  "ima-mcp-worker": ["MCP_ACCESS_TOKEN", "API_KEY"],
  "database-mcp-worker": ["MCP_ACCESS_TOKEN", "DATABASE_CONFIG"],
  "ssh-mcp-worker": ["MCP_ACCESS_TOKEN", "MCP_BROKER_TOKEN"],
  "remote-control-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "github-actions-mcp-worker": ["MCP_ACCESS_TOKEN", "GH_TOKEN"],
  "workflow-mcp-worker": ["MCP_ACCESS_TOKEN", "MCP_PORTAL_CLIENT_ID", "MCP_PORTAL_CLIENT_SECRET", "WORKFLOW_EXECUTOR_GITHUB_TOKEN"],
});

export function collectBootstrapSecrets(worker, env) {
  const required = BOOTSTRAP_SECRETS[worker];
  if (!required) throw new Error("Bootstrap is not enabled for this Worker");
  const payload = {};
  const selected = required;
  for (const name of selected) {
    const value = env[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error("Missing or empty bootstrap Secret: " + name);
    }
    payload[name] = value;
  }
  if (worker === "workflow-mcp-worker" && (payload.WORKFLOW_EXECUTOR_GITHUB_TOKEN.length < 20 ||
      payload.WORKFLOW_EXECUTOR_GITHUB_TOKEN.length > 512 ||
      /\s/.test(payload.WORKFLOW_EXECUTOR_GITHUB_TOKEN)))
    throw new Error("Invalid WORKFLOW_EXECUTOR_GITHUB_TOKEN");
  if (worker === "ssh-mcp-worker" && payload.MCP_BROKER_TOKEN.length < 32) {
    throw new Error("SSH Broker token must be at least 32 characters");
  }
  if (worker === "github-actions-mcp-worker") {
    // Preserve the single, multiline GitHub Environment Secret unchanged.
    // Reject malformed/duplicated entries before any Worker deployment.
    const tokens = payload.GH_TOKEN.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
    if (!tokens.length || tokens.length > 8 ||
      tokens.some((t) => t.length > 512 || /\s/.test(t)) ||
      new Set(tokens).size !== tokens.length) {
      throw new Error("Invalid or duplicate GitHub PAT in GH_TOKEN");
    }
    // Avoid copying older secondary Secret even when it remains in GitHub settings.
  }
  return payload;
}

async function main() {
  const [worker, outputPath] = process.argv.slice(2);
  const root = process.env.RUNNER_TEMP;
  if (!outputPath || !root || !resolve(outputPath).startsWith(resolve(root) + sep)) {
    throw new Error("Bootstrap Secrets must be staged inside runner temporary directory");
  }
  const payload = collectBootstrapSecrets(worker, process.env);
  await writeFile(outputPath, JSON.stringify(payload), { flag: "wx", mode: 0o600 });
  console.log("Selected Worker release Secrets validated and staged (values withheld)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error("Bootstrap Secrets preparation failed: " + error.message);
    process.exitCode = 1;
  });
}
