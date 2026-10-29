# Cloudflare runtime configuration

**Spec #392 completed:** The Weixin Worker is now maintained only by [cloudflare-actions](https://github.com/lirtual/cloudflare-actions). This repository no longer contains its legacy MCP source, release configuration or Portal ingress. Its original D1 and encrypted owner state remain with the Provider.

The ten independently managed MCP Workers share an MCP-entry Secret **name**, not a uniform hostname, credential or logging policy. Authoritative release contracts: `.github/workflows/release.yml`, `scripts/bootstrap-worker-secrets.mjs`, `scripts/worker-release-variables.mjs`, `scripts/manual-worker-release.mjs` and each app's `wrangler.jsonc`.

Spec #392 生产 Workflow 发布的单记录历史例外：仅对 2026-10-26 的 OpenList Run `47739981-0534-4966-8034-1e79c1d17481`，在 D1 原始结果、Cloudflare 原生实例已完成，以及 GitHub Session 实际终止全部只读核对成功后，允许其不阻断发布门禁；业务状态仍是 `indeterminate`，不得重试发送或删除历史。所有其他未解决的 Run、Session 和 Attempt 保持原来的拒绝规则。该例外不构成通用忽略开关，部署不自动停止现有 Session。

## Source of truth

- Wrangler defines non-secret settings, Cloudflare bindings and required Secret names; never commit secret values.
- The GitHub Repository provides Secret `CLOUDFLARE_API_TOKEN`, the default `MCP_ACCESS_TOKEN` and Variable `CLOUDFLARE_ACCOUNT_ID`. A matching same-name GitHub Environment Secret overrides the default.
- Every selected Worker has its own same-name GitHub Environment for app Secrets and whitelisted Variables. Only a separately approved, `main`-only, manual **Release Worker** run publishes it. Editing a GitHub Secret alone does not rotate live credentials.
- All Workers require `MCP_ACCESS_TOKEN`. `IMA_CLIENT_ID` and `MCP_PORTAL_CLIENT_ID` are required **plain-text Variables**, not Secrets.

## Worker-scoped configuration

| Worker | Additional Environment Secrets | Environment Variables |
| --- | --- | --- |
| `database-mcp-worker` | `DATABASE_ENCRYPTION_KEY`、`DATABASE_KEY_ID`（轮换时可选两项 previous-key Secret） | `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`OWNER_EMAIL`（必填）；SQL 行数、结果大小及超时上限（可选） |
| `email-mcp-worker` | `MAIL_ENCRYPTION_KEY` | `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`OWNER_EMAIL` |
| `ima-mcp-worker` | `IMA_API_KEY` | `IMA_CLIENT_ID`、`IMA_BASE_URL` |
| `raindrop-mcp-worker` | `RAINDROP_ACCESS_TOKEN` | `RAINDROP_RATE_LIMIT_MAX_RETRIES` |
| `ssh-mcp-worker` | `ENCRYPTION_KEY` | 无 |
| `remote-control-mcp-worker` | 无 | 无 |
| `github-actions-mcp-worker` | `ACTIONS_GITHUB_DISPATCH_TOKENS` | 无 |
| `http-mcp-worker` | `HTTP_CREDENTIALS_JSON` | 无 |
| `workflow-mcp-worker` | `MCP_PORTAL_CLIENT_SECRET`、`WORKFLOW_GITHUB_DISPATCH_TOKEN`、`SESSION_RUNTIME_DATA_KEY` | `MCP_PORTAL_CLIENT_ID`、`WORKFLOW_ACTION_APPROVED_REPOSITORIES` |

Database MCP Spec #344 runs in production with encrypted, Owner-managed connections in D1 `database-mcp-registry`. The current release contract requires `DATABASE_ENCRYPTION_KEY`, `DATABASE_KEY_ID`, Owner Access Variables and `DB`; it neither consumes `DATABASE_CONFIG` nor imports historical records. Old database resources are retired only by a separately reviewed cleanup after deployment verification. See [Database production and recovery runbook](./database-cutover-344.md).

Notes: `HTTP_CREDENTIALS_JSON` is an **optional Secret**, not a required placeholder. `IMA_BASE_URL`, Raindrop retry count, Database limits and Workflow's `WORKFLOW_ACTION_APPROVED_REPOSITORIES` are optional Variables. Email's three Access Variables, IMA's `IMA_CLIENT_ID` and Workflow's `MCP_PORTAL_CLIENT_ID` are **required**. Workflow's approved-repositories GitHub Variable is translated to the `GITHUB_ACTION_APPROVED_REPOSITORIES` runtime binding.


`MAIL_ENCRYPTION_KEY` and `SESSION_RUNTIME_DATA_KEY` are canonical 32-byte Base64-encoded keys. SSH's `ENCRYPTION_KEY` must match the real EdgeSSH key protecting existing D1 records; the retired `SSH_BROKER_TOKEN` is not a release requirement. The existing Email D1, legacy IMA DO binding must not be deleted during documentation maintenance. Other pinned variables (e.g. Workflow Portal endpoint and Remote Control installation origin) come from scripts or Wrangler, not arbitrary GitHub Environment input.

See [bootstrap guide](./MANUAL-WORKER-BOOTSTRAP.md) and [token rotation runbook](./mcp-shared-token-runbook.md).

## Ingress and observability

Use [ingress policy](./ingress-policy.md) rather than deriving `workers.dev` for Email or Workflow. Invocation logs are disabled for Email and Remote Control, rather than having one monorepo-wide value. Never emit authentication headers, credentials, private responses or unredacted sensitive query strings to logs.

## Deployment verification

1. Verify selected GitHub Repository/Environment Secrets, Variables, branch protection and approvals. Do not use Cloudflare Builds or unreviewed direct Wrangler deploys for routine production publishing.
2. Manually dispatch **Release Worker** from current `main` with exactly one Worker selected and `deploy_to_production` explicitly approved.
3. Confirm exact Cloudflare active Version ID and required Secret/Variable/DO/D1/Service Bindings and custom-domain settings where applicable.
4. Verify public health where implemented and reject anonymous `/mcp` requests. A 401/403 alone does not prove end-to-end authenticated access.
5. Verify actual One-MCP server address, reusable Access policy IDs/order, authenticated discovery and a safe read-only call.

Git, Wrangler or README changes cannot decommission live Cloudflare resources or Portal clients. Retire them only under separate authorization and verification.

Browser T8：`browser-mcp-worker` 使用独立 `MCP_ACCESS_TOKEN`（同名 GitHub Environment Secret，不沿用共享值），无额外 Variable。Manifest Key 是公开安装标识，不是 Secret。当前 `workers_dev: false`、`preview_urls: false` 且没有生产路由；现有手动 Release 的 Browser 预检将阻断发布。不得以本次接线创建资源、写 Portal/Access 或切换凭据；参见 [T8 发布与验收边界](../apps/browser-mcp-worker/docs/t8-release.md)。
