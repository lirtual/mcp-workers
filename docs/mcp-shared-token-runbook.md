# MCP entry token rotation: operator runbook

Every maintained MCP Worker in this repository uses runtime Secret **name** `MCP_ACCESS_TOKEN` for MCP/Portal calls. The shared GitHub Repository Secret is the release-time default; any same-name Worker Environment Secret overrides it. Identical names do **not** prove the deployed values are equal or that Portal clients are synchronized. Business credentials remain independent.

| Worker | MCP entry Secret | Other Environment Secrets |
| --- | --- | --- |
| `database-mcp-worker` | `MCP_ACCESS_TOKEN` | `DATABASE_ENCRYPTION_KEY`, `DATABASE_KEY_ID` |
| `email-mcp-worker` | `MCP_ACCESS_TOKEN` | `MAIL_ENCRYPTION_KEY` |
| `ima-mcp-worker` | `MCP_ACCESS_TOKEN` | `IMA_API_KEY` |
| `raindrop-mcp-worker` | `MCP_ACCESS_TOKEN` | `RAINDROP_ACCESS_TOKEN` |
| `ssh-mcp-worker` | `MCP_ACCESS_TOKEN` | `ENCRYPTION_KEY` |
| `remote-control-mcp-worker` | `MCP_ACCESS_TOKEN` | 无 |
| `github-actions-mcp-worker` | `MCP_ACCESS_TOKEN` | `ACTIONS_GITHUB_DISPATCH_TOKENS` |
| `http-mcp-worker` | `MCP_ACCESS_TOKEN` | `HTTP_CREDENTIALS_JSON` |
| `openlist-mcp-worker` | `MCP_ACCESS_TOKEN` | `OPENLIST_API_TOKEN` |
| `workflow-mcp-worker` | `MCP_ACCESS_TOKEN` | `MCP_PORTAL_CLIENT_SECRET`、`WORKFLOW_GITHUB_DISPATCH_TOKEN`、`SESSION_RUNTIME_DATA_KEY` |

`HTTP_CREDENTIALS_JSON` is optional. Additional required **non-secret** Variables are Email's `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL`; IMA's `IMA_CLIENT_ID`; OpenList's `OPENLIST_ALLOWED_ROOTS`; and Workflow's `MCP_PORTAL_CLIENT_ID`. See [runtime configuration](./runtime-configuration.md) and [bootstrap guide](./MANUAL-WORKER-BOOTSTRAP.md).

## Rotation and verification

1. Inventory all **ten** maintained MCP Workers above, their actual Cloudflare deployments, existing Environment-level overrides and the affected One-MCP server/client connections. Check for any extra legacy live service outside the source tree before defining the rotation scope.
2. Verify Secret **name/presence/type**, not plaintext values; preserve unrelated upstream credentials and independently scoped Worker tokens.
3. Generate the replacement in an operator-controlled secret store and update the appropriate Repository or same-name Environment Secret without exposing its value in Git, Issues or logs.
4. Coordinate a **non-atomic** cutover: manually release each affected Worker on trusted current `main` with explicit per-Worker approval and update its corresponding Portal/client credential. A GitHub Secret edit alone does not deploy or rotate live credentials.
5. For each affected Worker verify its active version, actual MCP ingress, denied anonymous access, authenticated Portal discovery and one explicitly safe read-only call. A health endpoint or source test alone is insufficient.
6. On failure stop and use operator-held prior values and the reviewed Worker-specific release/Portal procedure to restore service. Do not assume the operation was atomic, fetch live Secret plaintext or automatically replay uncertain writes.

Source deletion does not retire a Cloudflare Worker, remove a Portal client or expire a deployed token; retirement is separately authorized.

Browser T8：`browser-mcp-worker` 使用独立 `MCP_ACCESS_TOKEN`（同名 GitHub Environment Secret，不沿用共享值），无额外 Variable。Manifest Key 是公开安装标识，不是 Secret。当前 `workers_dev: false`、`preview_urls: false` 且没有生产路由；现有手动 Release 的 Browser 预检将阻断发布。不得以本次接线创建资源、写 Portal/Access 或切换凭据；参见 [T8 发布与验收边界](../apps/browser-mcp-worker/docs/t8-release.md)。
