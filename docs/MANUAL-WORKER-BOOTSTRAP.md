# Manual GitHub Actions bootstrap for missing MCP Workers

Scope: `database-mcp-worker`, `ima-mcp-worker`, `raindrop-mcp-worker`, and `ssh-mcp-worker`.
**Do not delete or bootstrap `remote-control-mcp-worker`, `remote-control-v2-preview`, or the `edgessh` broker.**

## One-time setup (GitHub Actions environment: production)

Existing environment prerequisites: `CLOUDFLARE_API_TOKEN` (GitHub Actions secret) and
`CLOUDFLARE_ACCOUNT_ID` (GitHub Actions variable) with permission to manage Workers
and the required Durable Objects.

For a **missing Worker** only, add the appropriate **one** GitHub Actions
**environment secret** (Settings → Environments → production → Environment secrets).
Each value must be a single JSON object of nonempty **string** values, using
exactly the following keys. Placeholders below are NOT real credentials.

| Selected Worker | GitHub environment secret | JSON keys |
| --- | --- | --- |
| raindrop-mcp-worker | `RAINDROP_MCP_SECRETS_JSON` | `MCP_ACCESS_TOKEN`, `RAINDROP_ACCESS_TOKEN` |
| ima-mcp-worker | `IMA_MCP_SECRETS_JSON` | `MCP_ACCESS_TOKEN`, `API_KEY`, `CLIENT_ID` |
| database-mcp-worker | `DATABASE_MCP_SECRETS_JSON` | `MCP_ACCESS_TOKEN`, `DATABASE_CONFIG` |
| ssh-mcp-worker | `SSH_MCP_SECRETS_JSON` | `MCP_ACCESS_TOKEN`, `MCP_BROKER_TOKEN` |

Example structure for **Raindrop only**, with placeholders:

```json
{
  "MCP_ACCESS_TOKEN": "PASTE_EXISTING_PORTAL_SHARED_BEARER",
  "RAINDROP_ACCESS_TOKEN": "PASTE_EXISTING_RAINDROP_API_TOKEN"
}
```

Each Worker may have its own MCP bearer; preserve the token that the upstream
MCP Portal expects. `DATABASE_CONFIG` is a **string containing its original
JSON**, not a nested JSON object. If writing this JSON manually, escape quotes;
a JSON encoder is recommended. Never paste actual values into PRs, CI logs,
issues, chat, committed files or Wrangler config `vars`.

For **SSH**, `MCP_BROKER_TOKEN` must be the existing broker token configured
on `edgessh` (minimum 32 characters) and `edgessh` must still have the
intended `MCP_BROKER_HOST_IDS` allowlist. The SSH Worker uses a private
`EDGE_SSH_BROKER` Service Binding targeting `edgessh` entrypoint
`HostBrokerEntrypoint`; no production `ENCRYPTION_KEY` or D1 database is
copied. `MCP_BROKER_FULL_ACCESS` is **not** configured, so the initial SSH
deployment remains in the restricted read-only G5 scope; wider privileges
require a separate explicit release.

## Deployment

1. Review/merge the release-workflow PR into `main`. The regular
   `push`/PR CI path **does not publish** production Workers.
2. Visit GitHub → Actions → **CI** → **Run workflow**; select branch **main**.
3. Select **one Worker**. Wait for that run to finish successfully before
   starting the next Worker.
4. For missing Workers, preflight records `bootstrap=true`; the workflow
   validates the corresponding environment JSON secret *before upload*,
   stages a mode-0600 temporary secrets file on the isolated runner,
   calls `wrangler deploy --secrets-file`, deletes that temporary file,
   and verifies the exact active Cloudflare version and bindings.
5. For Workers that already exist, preflight verifies the current
   deployment and normal publishing **does not require or re-upload**
   bootstrap Secrets. Remote Control remains existing-Worker-only.
6. Confirm unauthenticated `/mcp` calls fail with HTTP 401/403 and
   complete the authenticated Portal tool check separately. For SSH,
   verify the existing `edgessh` WebSSH/file listing baseline is intact
   before any intentional broader authorization.

## Important failure boundaries

- Missing GitHub environment secret, missing/wrong JSON keys or an incomplete
  Worker-specific bundle: **fail before any Cloudflare deployment**.
- Invalid or missing Cloudflare API credentials or incomplete Worker inventory:
  preflight fails closed. It never interprets a network/permissions failure as
  proof that a Worker was deleted.
- A preflight missing Worker is **not** grounds to run the Remote Control
  release, and no workflow step deletes a Worker.
- New SQLite Durable Object namespaces are created by IMA/SSH source config
  on first deploy. Old namespaces and receipts from the deleted Workers
  are **not restored**.
- The workflow captures Wrangler errors in a restricted runner file
  and emits only sanitized diagnostics, not raw output containing secrets.
- If deployment fails after Cloudflare has accepted a new version, inspect
  the Worker state and repair the same target. Do not blindly treat a
  failed CI run as evidence that the Worker is absent.
