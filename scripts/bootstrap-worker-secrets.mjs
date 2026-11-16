import {databaseCatalogStage} from './database-catalog-stage.mjs';
import {createPrivateKey,createPublicKey} from 'node:crypto';
// Stage only the selected Worker's Repository Secrets.
// Used for EVERY authorized manual release, not only for first deployment.
// Source scope must remain unambiguous; do not add Environment-bound jobs.
// Never print credentials, and never fall back to the removed *_SECRETS_JSON.
import { writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const BOOTSTRAP_SECRETS = Object.freeze({
  "browser-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "raindrop-mcp-worker": ["MCP_ACCESS_TOKEN", "RAINDROP_ACCESS_TOKEN"],
  "mcp-gateway-worker": ["CLERK_SECRET_KEY", "MCP_GATEWAY_PORTAL_CLIENT_SECRET"],
  "ima-mcp-worker": ["MCP_ACCESS_TOKEN", "IMA_API_KEY"],
  "database-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "ssh-mcp-worker": ["MCP_ACCESS_TOKEN", "SSH_ENCRYPTION_KEY"],
  "remote-control-mcp-worker": ["MCP_ACCESS_TOKEN"],
  "github-actions-mcp-worker": ["MCP_ACCESS_TOKEN", "ACTIONS_GITHUB_DISPATCH_TOKENS"],
  "workflow-mcp-worker": ["MCP_ACCESS_TOKEN", "WORKFLOW_MCP_PORTAL_CLIENT_SECRET", "WORKFLOW_GITHUB_DISPATCH_TOKEN"],
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
  if (worker === "mcp-gateway-worker") {
    payload.CF_ACCESS_CLIENT_SECRET = payload.MCP_GATEWAY_PORTAL_CLIENT_SECRET;
    delete payload.MCP_GATEWAY_PORTAL_CLIENT_SECRET;
  }
  if (worker === "database-mcp-worker") {
    Object.assign(payload,databaseCatalogStage(env).secrets);
  }
  if (worker === "workflow-mcp-worker" && (payload.WORKFLOW_GITHUB_DISPATCH_TOKEN.length < 20 ||
      payload.WORKFLOW_GITHUB_DISPATCH_TOKEN.length > 512 ||
      /\s/.test(payload.WORKFLOW_GITHUB_DISPATCH_TOKEN)))
    throw new Error("Invalid WORKFLOW_GITHUB_DISPATCH_TOKEN");
  if (worker === "workflow-mcp-worker") {
    // The two PEMs belong to different RSA pairs: GitHub decrypts the file,
    // while Workflow decrypts the sealed claim receipt. Stage them together.
    const publicName = "WORKFLOW_GITHUB_DROP_PUBLIC_KEY";
    const privateName = "WORKFLOW_GITHUB_DROP_RECEIPT_PRIVATE_KEY";
    const publicPem = env[publicName], privatePem = env[privateName];
    if (publicPem || privatePem) {
      if (!publicPem || !privatePem) throw Error("Incomplete Workflow Drop key configuration");
      try {
        const publicKey = createPublicKey(publicPem);
        const privateKey = createPrivateKey(privatePem);
        for (const key of [publicKey, privateKey]) {
          if (key.asymmetricKeyType !== "rsa" ||
              key.asymmetricKeyDetails?.modulusLength < 2048 ||
              key.asymmetricKeyDetails?.modulusLength > 4096)
            throw Error();
        }
      } catch { throw Error("Invalid Workflow Drop RSA PEM configuration"); }
      payload[publicName] = publicPem;
      payload[privateName] = privatePem;
    }
  }
  if (worker === "ssh-mcp-worker") {
    const key = payload.SSH_ENCRYPTION_KEY;
    if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").length !== 32 || Buffer.from(key, "base64").toString("base64") !== key) throw new Error("SSH_ENCRYPTION_KEY must be canonical Base64 for a 32-byte key");
  }
  if (worker === "github-actions-mcp-worker") {
    // Preserve the single, multiline GitHub Repository Secret unchanged.
    // Reject malformed/duplicated entries before any Worker deployment.
    const tokens = payload.ACTIONS_GITHUB_DISPATCH_TOKENS.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
    if (!tokens.length || tokens.length > 8 ||
      tokens.some((t) => t.length > 512 || /\s/.test(t)) ||
      new Set(tokens).size !== tokens.length) {
      throw new Error("Invalid or duplicate GitHub PAT in ACTIONS_GITHUB_DISPATCH_TOKENS");
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
