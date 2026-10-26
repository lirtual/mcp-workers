// Stage only the selected Worker's GitHub Environment + repository secrets.
// Used for EVERY authorized manual release, not only for first deployment.
// GitHub resolves an Environment secret over a same-name repository secret.
// Never print credentials, and never fall back to the removed *_SECRETS_JSON.
import { writeFile } from "node:fs/promises";
import { parseCredentials } from "../apps/http-mcp-worker/src/http.ts";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const BOOTSTRAP_SECRETS = Object.freeze({
  "raindrop-mcp-worker": ["MCP_ACCESS_TOKEN", "RAINDROP_ACCESS_TOKEN"],
  "ima-mcp-worker": ["MCP_ACCESS_TOKEN", "IMA_API_KEY"],
  "database-mcp-worker": ["MCP_ACCESS_TOKEN", "DATABASE_CONFIG"],
  "email-mcp-worker": ["MCP_ACCESS_TOKEN", "MAIL_ENCRYPTION_KEY", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "OWNER_EMAIL"],
  "ssh-mcp-worker": ["MCP_ACCESS_TOKEN", "ENCRYPTION_KEY"],
  "remote-control-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "github-actions-mcp-worker": ["MCP_ACCESS_TOKEN", "ACTIONS_GITHUB_DISPATCH_TOKENS"],
  "http-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "workflow-mcp-worker": ["MCP_ACCESS_TOKEN", "MCP_PORTAL_CLIENT_SECRET", "WORKFLOW_GITHUB_DISPATCH_TOKEN", "SESSION_RUNTIME_DATA_KEY"],
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
  if (worker === "workflow-mcp-worker" && (payload.WORKFLOW_GITHUB_DISPATCH_TOKEN.length < 20 ||
      payload.WORKFLOW_GITHUB_DISPATCH_TOKEN.length > 512 ||
      /\s/.test(payload.WORKFLOW_GITHUB_DISPATCH_TOKEN)))
    throw new Error("Invalid WORKFLOW_GITHUB_DISPATCH_TOKEN");
  if (worker === "email-mcp-worker") {
    const key = payload.MAIL_ENCRYPTION_KEY;
    if (!/^[A-Za-z0-9+/]{43}=$/.test(key) ||
        Buffer.from(key, "base64").length !== 32 ||
        Buffer.from(key, "base64").toString("base64") !== key)
      throw new Error("MAIL_ENCRYPTION_KEY must be canonical Base64 for a 32-byte key");
    if (payload.ACCESS_TEAM_DOMAIN !== "lirtualzero.cloudflareaccess.com" ||
        payload.ACCESS_AUD !== "cea1cd806f0f68552c5bed2acd917afcaf8e18a7eda3fb19f5c9704c3a00cd1b" ||
        payload.OWNER_EMAIL !== "lirtual@outlook.com")
      throw new Error("Email production Access owner, team or audience mismatch");
  }
  if (worker === "workflow-mcp-worker") {
    const key = payload.SESSION_RUNTIME_DATA_KEY;
    if (!/^[A-Za-z0-9+/]{43}=$/.test(key) ||
        Buffer.from(key, "base64").length !== 32 ||
        Buffer.from(key, "base64").toString("base64") !== key)
      throw new Error("SESSION_RUNTIME_DATA_KEY must be canonical Base64 for a 32-byte key");
  }
  if (worker === "ssh-mcp-worker") {
    const key = payload.ENCRYPTION_KEY;
    if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").length !== 32 || Buffer.from(key, "base64").toString("base64") !== key) throw new Error("ENCRYPTION_KEY must be canonical Base64 for a 32-byte key");
  }
  if (worker === "github-actions-mcp-worker") {
    // Preserve the single, multiline GitHub Environment Secret unchanged.
    // Reject malformed/duplicated entries before any Worker deployment.
    const tokens = payload.ACTIONS_GITHUB_DISPATCH_TOKENS.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
    if (!tokens.length || tokens.length > 8 ||
      tokens.some((t) => t.length > 512 || /\s/.test(t)) ||
      new Set(tokens).size !== tokens.length) {
      throw new Error("Invalid or duplicate GitHub PAT in ACTIONS_GITHUB_DISPATCH_TOKENS");
    }
    // Avoid copying older secondary Secret even when it remains in GitHub settings.
  }
  if (worker === "http-mcp-worker" && env.HTTP_CREDENTIALS_JSON) {
    const raw = env.HTTP_CREDENTIALS_JSON;
    try { parseCredentials(raw); }
    catch { throw Error("Invalid HTTP_CREDENTIALS_JSON"); }
    payload.HTTP_CREDENTIALS_JSON = raw;
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
