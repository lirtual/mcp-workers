# MCP entry token rotation: operator runbook

All eight maintained MCP Workers use runtime Secret **name** `MCP_ACCESS_TOKEN` for MCP/Portal calls. The GitHub Repository Secret is the release-time default; any same-name Worker Environment Secret overrides it. Names and deployed Secret bindings do **not** prove token values are equal or that Portal clients are synchronized. Releasing a Worker without an Environment override stages the Repository default; shared Bearer values can broaden credential compromise. The shared-default mechanism remains in place, without waiving existing Browser or Remote Control independent-credential requirements. Business credentials stay separate.

| Worker | MCP entry Secret | Other Environment Secrets |
| --- | --- | --- |
| `database-mcp-worker` | `MCP_ACCESS_TOKEN` | Independent Secrets referenced by `DATABASE_CONNECTIONS` (see Database README) |
| `browser-mcp-worker` | `MCP_ACCESS_TOKEN` (independent Environment override required by prior design, current source unverified) | 无 |
| `ima-mcp-worker` | `MCP_ACCESS_TOKEN` | `IMA_API_KEY` |
| `raindrop-mcp-worker` | `MCP_ACCESS_TOKEN` | `RAINDROP_ACCESS_TOKEN` |
| `ssh-mcp-worker` | `MCP_ACCESS_TOKEN` | `ENCRYPTION_KEY` |
| `remote-control-mcp-worker` | `MCP_ACCESS_TOKEN` | 无 |
| `github-actions-mcp-worker` | `MCP_ACCESS_TOKEN` | `ACTIONS_GITHUB_DISPATCH_TOKENS` |
| `workflow-mcp-worker` | `MCP_ACCESS_TOKEN` | `MCP_PORTAL_CLIENT_SECRET`、`WORKFLOW_GITHUB_DISPATCH_TOKEN`、`SESSION_RUNTIME_DATA_KEY` |

Additional required **non-secret** Variables include Database's `DATABASE_CONNECTIONS` and referenced `DB_HOST`; Browser's Owner Access / activation variables; IMA's `IMA_CLIENT_ID`; and Workflow's `MCP_PORTAL_CLIENT_ID`. See [runtime configuration](./runtime-configuration.md) and [bootstrap guide](./MANUAL-WORKER-BOOTSTRAP.md).

## Rotation and verification

1. Inventory all maintained MCP Workers listed above, their actual Cloudflare deployments, existing Environment-level overrides and the affected One-MCP server/client connections. Check for any extra legacy live service outside the source tree before defining the rotation scope.
2. Verify Secret **name/presence/type**, not plaintext values; preserve unrelated upstream credentials and independently scoped Worker tokens.
3. Generate the replacement in an operator-controlled secret store and update the appropriate Repository or same-name Environment Secret without exposing its value in Git, Issues or logs.
4. Coordinate a **non-atomic** cutover: manually release each affected Worker on trusted current `main` with explicit per-Worker approval and update its corresponding Portal/client credential. A GitHub Secret edit alone does not deploy or rotate live credentials.
5. For each affected Worker verify its active version, actual MCP ingress, denied anonymous access, authenticated Portal discovery and one explicitly safe read-only call. A health endpoint or source test alone is insufficient.
6. On failure stop and use operator-held prior values and the reviewed Worker-specific release/Portal procedure to restore service. Do not assume the operation was atomic, fetch live Secret plaintext or automatically replay uncertain writes.

Source deletion does not retire a Cloudflare Worker, remove a Portal client or expire a deployed token; retirement is separately authorized.

Browser now has a production custom domain and Owner Access activation Variables; the historical T8 no-route/no-variable note is obsolete. The actual Browser Environment token override and Portal credential alignment remain unverified. See [runtime configuration](./runtime-configuration.md) for the current contract and separately authorized historical GitHub configuration cleanup candidates. No credential rotation or deployment is authorized by this runbook update.
