# Cloudflare runtime configuration

**Spec #392 handoff:** `weixin-mcp-worker` remains in this repository for source/CI and backward compatibility, but is excluded from its production release target list. The dedicated `cloudflare-actions` manual release owns future Weixin deployments only after credential isolation and authorized cutover. The Weixin row below is retained as historical runtime configuration, not as authority to deploy from here.

The eleven independently managed MCP Workers share an MCP-entry Secret **name**, not a uniform hostname, credential or logging policy. Authoritative release contracts: `.github/workflows/release.yml`, `scripts/bootstrap-worker-secrets.mjs`, `scripts/worker-release-variables.mjs`, `scripts/manual-worker-release.mjs` and each app's `wrangler.jsonc`.

Spec #392 生产 Workflow 发布的单记录历史例外：仅对 2026-10-26 的 OpenList Run `47739981-0534-4966-8034-1e79c1d17481`，在 D1 原始结果、Cloudflare 原生实例已完成，以及 GitHub Session 实际终止全部只读核对成功后，允许其不阻断发布门禁；业务状态仍是 `indeterminate`，不得重试发送或删除历史。所有其他未解决的 Run、Session 和 Attempt 保持原来的拒绝规则。该例外不构成通用忽略开关，部署不自动停止现有 Session。

## Source of truth

- Wrangler defines non-secret settings, Cloudflare bindings and required Secret names; never commit secret values.
- The GitHub Repository provides Secret `CLOUDFLARE_API_TOKEN`, the default `MCP_ACCESS_TOKEN` and Variable `CLOUDFLARE_ACCOUNT_ID`. A matching same-name GitHub Environment Secret overrides the default.
- Every selected Worker has its own same-name GitHub Environment for app Secrets and whitelisted Variables. Only a separately approved, `main`-only, manual **Release Worker** run publishes it. Editing a GitHub Secret alone does not rotate live credentials.
- All Workers require `MCP_ACCESS_TOKEN`. `IMA_CLIENT_ID` and `MCP_PORTAL_CLIENT_ID` are required **plain-text Variables**, not Secrets.

## Worker-scoped configuration

| Worker | Additional Environment Secrets | Environment Variables |
| --- | --- | --- |
| `database-mcp-worker` | `DATABASE_CONFIG` | `MAX_ROWS`、`MAX_RESULT_BYTES`、`MAX_SCHEMA_BYTES`、`QUERY_TIMEOUT_MS`、`MAX_WRITE_AFFECTED_ROWS` |
| `email-mcp-worker` | `MAIL_ENCRYPTION_KEY` | `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`OWNER_EMAIL` |
| `weixin-mcp-worker` | `WEIXIN_ENCRYPTION_KEY` | 无（Wrangler 固定 Access owner、双域名和独立 D1） |
| `ima-mcp-worker` | `IMA_API_KEY` | `IMA_CLIENT_ID`、`IMA_BASE_URL` |
| `raindrop-mcp-worker` | `RAINDROP_ACCESS_TOKEN` | `RAINDROP_RATE_LIMIT_MAX_RETRIES` |
| `ssh-mcp-worker` | `ENCRYPTION_KEY` | 无 |
| `remote-control-mcp-worker` | 无 | 无 |
| `github-actions-mcp-worker` | `ACTIONS_GITHUB_DISPATCH_TOKENS` | 无 |
| `http-mcp-worker` | `HTTP_CREDENTIALS_JSON` | 无 |
| `openlist-mcp-worker` | `OPENLIST_API_TOKEN` | `OPENLIST_ALLOWED_ROOTS` |
| `workflow-mcp-worker` | `MCP_PORTAL_CLIENT_SECRET`、`WORKFLOW_GITHUB_DISPATCH_TOKEN`、`SESSION_RUNTIME_DATA_KEY` | `MCP_PORTAL_CLIENT_ID`、`WORKFLOW_ACTION_APPROVED_REPOSITORIES` |

Notes: `HTTP_CREDENTIALS_JSON` is an **optional Secret**, not a required placeholder. `IMA_BASE_URL`, Raindrop retry count, Database limits and Workflow's `WORKFLOW_ACTION_APPROVED_REPOSITORIES` are optional Variables. Email's three Access Variables, OpenList's `OPENLIST_ALLOWED_ROOTS`, IMA's `IMA_CLIENT_ID` and Workflow's `MCP_PORTAL_CLIENT_ID` are **required**. Workflow's approved-repositories GitHub Variable is translated to the `GITHUB_ACTION_APPROVED_REPOSITORIES` runtime binding.

`WEIXIN_ENCRYPTION_KEY` is an independent canonical 32-byte Base64 key for encrypted owner QR/session records in `weixin-mcp-db`. It must never reuse another Worker's key or be committed to the repository. Weixin owner Setup remains on its Access-protected custom domain, with workers.dev disabled. The legacy Weixin MCP custom domain and GitHub Portal registration are retired by Spec #392; only the internal Action Provider is used for sending. An available Access policy or migrated schema is not proof of successful production acceptance.

`MAIL_ENCRYPTION_KEY` and `SESSION_RUNTIME_DATA_KEY` are canonical 32-byte Base64-encoded keys. SSH's `ENCRYPTION_KEY` must match the real EdgeSSH key protecting existing D1 records; the retired `SSH_BROKER_TOKEN` is not a release requirement. The existing Email D1, OpenList Service Binding and legacy IMA DO binding must not be deleted during documentation maintenance. Other pinned variables (e.g. Workflow Portal endpoint and Remote Control installation origin) come from scripts or Wrangler, not arbitrary GitHub Environment input.

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
