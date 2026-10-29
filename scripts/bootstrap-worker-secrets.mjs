// Stage only the selected Worker's GitHub Environment + repository secrets.
// Used for EVERY authorized manual release, not only for first deployment.
// GitHub resolves an Environment secret over a same-name repository secret.
// Never print credentials, and never fall back to the removed *_SECRETS_JSON.
import { writeFile } from "node:fs/promises";
import { parseCredentials } from "../apps/http-mcp-worker/src/http.ts";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const BOOTSTRAP_SECRETS = Object.freeze({
  "browser-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "raindrop-mcp-worker": ["MCP_ACCESS_TOKEN", "RAINDROP_ACCESS_TOKEN"],
  "ima-mcp-worker": ["MCP_ACCESS_TOKEN", "IMA_API_KEY"],
  "database-mcp-worker": ["MCP_ACCESS_TOKEN", "DATABASE_ENCRYPTION_KEY", "DATABASE_KEY_ID", "DATABASE_GITHUB_ACTIONS_TOKEN"],
  "email-mcp-worker": ["MCP_ACCESS_TOKEN", "MAIL_ENCRYPTION_KEY"],
  "ssh-mcp-worker": ["MCP_ACCESS_TOKEN", "ENCRYPTION_KEY"],
  "remote-control-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "github-actions-mcp-worker": ["MCP_ACCESS_TOKEN", "ACTIONS_GITHUB_DISPATCH_TOKENS"],
  "http-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "openlist-mcp-worker": ["MCP_ACCESS_TOKEN", "OPENLIST_API_TOKEN"],
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
  if (worker === "database-mcp-worker") {
    const canonicalKey = (key, name) => {
      if (typeof key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(key) ||
          Buffer.from(key, "base64").length !== 32 ||
          Buffer.from(key, "base64").toString("base64") !== key)
        throw new Error("Invalid " + name + ": require canonical 32-byte Base64");
      return key;
    };
    const keyId = (id, name) => {
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(id))
        throw new Error("Invalid " + name);
      return id;
    };
    canonicalKey(payload.DATABASE_ENCRYPTION_KEY, "DATABASE_ENCRYPTION_KEY");
    keyId(payload.DATABASE_KEY_ID, "DATABASE_KEY_ID");
    if (payload.DATABASE_GITHUB_ACTIONS_TOKEN.length < 20 ||
        payload.DATABASE_GITHUB_ACTIONS_TOKEN.length > 512 ||
        /\s/.test(payload.DATABASE_GITHUB_ACTIONS_TOKEN))
      throw new Error("Invalid DATABASE_GITHUB_ACTIONS_TOKEN");
    const previous = env.DATABASE_ENCRYPTION_PREVIOUS_KEY;
    const previousId = env.DATABASE_PREVIOUS_KEY_ID;
    if ((previous !== undefined && previous !== "") !==
        (previousId !== undefined && previousId !== ""))
      throw new Error("Both Database previous-key recovery values are required together");
    if (previous) {
      canonicalKey(previous, "DATABASE_ENCRYPTION_PREVIOUS_KEY");
      keyId(previousId, "DATABASE_PREVIOUS_KEY_ID");
      if (previousId === payload.DATABASE_KEY_ID)
        throw new Error("Database recovery key ID must differ from active key ID");
      payload.DATABASE_ENCRYPTION_PREVIOUS_KEY = previous;
      payload.DATABASE_PREVIOUS_KEY_ID = previousId;
    }
    // The legacy DATABASE_CONFIG must never be restaged into the D1-only Worker.
  }
  if (worker === "openlist-mcp-worker" && payload.OPENLIST_API_TOKEN === payload.MCP_ACCESS_TOKEN)
    throw new Error("OpenList admin Token must differ from MCP_ACCESS_TOKEN");
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
