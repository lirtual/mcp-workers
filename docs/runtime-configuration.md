# Cloudflare runtime configuration

**Spec #392 and subsequent Bark-only retirement:** The legacy Weixin MCP Worker and release entry are no longer maintained in this repository. [cloudflare-actions](https://github.com/lirtual/cloudflare-actions) owns the unified Action Provider; its current executable catalog contains no Weixin send operation. Historical data and recovery evidence are governed separately and are not deleted by GitHub configuration cleanup.

The eight independently managed MCP Workers share an MCP-entry Secret **name**, not a uniform hostname, credential or logging policy. Authoritative release contracts: `.github/workflows/release.yml`, `scripts/bootstrap-worker-secrets.mjs`, `scripts/worker-release-variables.mjs`, `scripts/manual-worker-release.mjs` and each app's `wrangler.jsonc`.

Spec #392 生产 Workflow 发布的单记录历史例外：仅对 2026-10-26 的 OpenList Run `47739981-0534-4966-8034-1e79c1d17481`，在 D1 原始结果、Cloudflare 原生实例已完成，以及 GitHub Session 实际终止全部只读核对成功后，允许其不阻断发布门禁；业务状态仍是 `indeterminate`，不得重试发送或删除历史。所有其他未解决的 Run、Session 和 Attempt 保持原来的拒绝规则。该例外不构成通用忽略开关，部署不自动停止现有 Session。

## Source of truth

- Wrangler defines non-secret settings, Cloudflare bindings and required Secret names; never commit secret values.
- The GitHub Repository provides Secret `CLOUDFLARE_API_TOKEN`, the default `MCP_ACCESS_TOKEN` and Variable `CLOUDFLARE_ACCOUNT_ID`. A matching same-name GitHub Environment Secret overrides the default. Without an override, the next Worker release stages the Repository token; binding names do not establish whether deployed token values match. Shared Bearer values can widen the impact of credential disclosure, and existing Worker-specific security requirements are not waived by retaining the default.
- Every selected Worker has its own same-name GitHub Environment for app Secrets and whitelisted Variables. Only a separately approved, `main`-only, manual **Release Worker** run publishes it. Editing a GitHub Secret alone does not rotate live credentials.
- All Workers require `MCP_ACCESS_TOKEN`. `IMA_CLIENT_ID` and `MCP_PORTAL_CLIENT_ID` are required **plain-text Variables**, not Secrets.

## Worker-scoped configuration

| Worker | Additional Environment Secrets | Environment Variables |
| --- | --- | --- |
| `database-mcp-worker` | `DATABASE_ENCRYPTION_KEY`、`DATABASE_GITHUB_ACTIONS_TOKEN`（轮换时可选 `DATABASE_ENCRYPTION_PREVIOUS_KEY`） | `DATABASE_KEY_ID`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`OWNER_EMAIL`（必填）；可选 `DATABASE_PREVIOUS_KEY_ID` 和 SQL 限额 |
| `browser-mcp-worker` | 既有设计要求独立的同名 `MCP_ACCESS_TOKEN` Environment 覆盖；实际覆盖状态未核验 | `BROWSER_ACCESS_ISSUER`、`BROWSER_OWNER_EMAIL`、`BROWSER_ACTIVATION_ORIGIN`、`BROWSER_ACTIVATION_AUDIENCE`；可选 `BROWSER_REMEMBERED_IDLE_DAYS` |
| `ima-mcp-worker` | `IMA_API_KEY` | `IMA_CLIENT_ID`、`IMA_BASE_URL` |
| `raindrop-mcp-worker` | `RAINDROP_ACCESS_TOKEN` | `RAINDROP_RATE_LIMIT_MAX_RETRIES` |
| `ssh-mcp-worker` | `ENCRYPTION_KEY` | 无 |
| `remote-control-mcp-worker` | 无 | 无 |
| `github-actions-mcp-worker` | `ACTIONS_GITHUB_DISPATCH_TOKENS` | 无 |
| `workflow-mcp-worker` | `MCP_PORTAL_CLIENT_SECRET`、`WORKFLOW_GITHUB_DISPATCH_TOKEN`、`SESSION_RUNTIME_DATA_KEY` | `MCP_PORTAL_CLIENT_ID`、`WORKFLOW_ACTION_APPROVED_REPOSITORIES` |

Database MCP Spec #344 runs in production with encrypted, Owner-managed connections in D1 `database-mcp-registry`. The current release contract requires `DATABASE_ENCRYPTION_KEY`, `DATABASE_KEY_ID`, Owner Access Variables and `DB`; it neither consumes `DATABASE_CONFIG` nor imports historical records. Old database resources are retired only by a separately reviewed cleanup after deployment verification. See [Database production and recovery runbook](./database-cutover-344.md).

Notes: `IMA_BASE_URL`, Raindrop retry count, Browser remembered-idle override, Database limits and Workflow's `WORKFLOW_ACTION_APPROVED_REPOSITORIES` are optional Variables. IMA's `IMA_CLIENT_ID` and Workflow's `MCP_PORTAL_CLIENT_ID` are **required**. Workflow's approved-repositories GitHub Variable is translated to the `GITHUB_ACTION_APPROVED_REPOSITORIES` runtime binding.


`SESSION_RUNTIME_DATA_KEY` is a canonical 32-byte Base64-encoded key. SSH's `ENCRYPTION_KEY` must match the real EdgeSSH key protecting existing D1 records; the retired `SSH_BROKER_TOKEN` is not a release requirement. The legacy IMA DO binding must not be deleted during documentation maintenance. Other pinned variables (e.g. Workflow Portal endpoint and Remote Control installation origin) come from scripts or Wrangler, not arbitrary GitHub Environment input.

See [bootstrap guide](./MANUAL-WORKER-BOOTSTRAP.md) and [token rotation runbook](./mcp-shared-token-runbook.md).

## Historical GitHub configuration cleanup candidates (2026-11-05)

Current CI / Acceptance / Release Workflows and Secret / Variable staging do not consume the ten entries below. None appear in the deployed binding inventories of the eight maintained Workers. Historical release guards may still intentionally **reject** these obsolete names and must be retained. This is a *candidate inventory*, not proof that the entries were deleted or lack external/recovery consumers:

- Browser Environment Variables: `BROWSER_ACCESS_AUDIENCE`, `BROWSER_APPROVAL_ISOLATION`, `BROWSER_APPROVAL_ORIGIN`.
- Remote Control Environment Secrets: `BROWSER_APPROVAL_ACCESS_AUD`, `BROWSER_APPROVAL_ACCESS_ISSUER`, `BROWSER_APPROVAL_ALLOWED_EMAIL`.
- Workflow Environment Variable: `WEIXIN_ACTION_DEPLOYMENT_ID`; legacy Weixin Environment Secret: `WEIXIN_ENCRYPTION_KEY`.
- Repository Secrets: `DATABASE_TEST_MYSQL_PASSWORD`, `DATABASE_TEST_POSTGRES_PASSWORD` (current CI uses ephemeral database service credentials).

Before any separately authorized deletion, verify the live GitHub names/scopes plus external and recovery dependencies. Do not delete Environments, Cloudflare resources, Portal credentials, or historical receipts. No credential rotation or Worker release is part of this cleanup.

## Ingress and observability

Use [ingress policy](./ingress-policy.md) rather than deriving `workers.dev` for Workflow. Invocation logs are disabled for Remote Control, rather than having one monorepo-wide value. Never emit authentication headers, credentials, private responses or unredacted sensitive query strings to logs.

## Deployment verification

1. Verify selected GitHub Repository/Environment Secrets, Variables, branch protection and approvals. Do not use Cloudflare Builds or unreviewed direct Wrangler deploys for routine production publishing.
2. Manually dispatch **Release Worker** from current `main` with exactly one Worker selected and `deploy_to_production` explicitly approved.
3. Confirm exact Cloudflare active Version ID and required Secret/Variable/DO/D1/Service Bindings and custom-domain settings where applicable.
4. Verify public health where implemented and reject anonymous `/mcp` requests. A 401/403 alone does not prove end-to-end authenticated access.
5. Verify actual One-MCP server address, reusable Access policy IDs/order, authenticated discovery and a safe read-only call.

Git, Wrangler or README changes cannot decommission live Cloudflare resources or Portal clients. Retire them only under separate authorization and verification.

## Browser activation (current)

The Browser Worker uses `https://browser.lirtual.dpdns.org` as its production custom domain (`workers_dev: false`, `preview_urls: false`). Current activation uses Owner Access verification and a one-use same-Profile proof; reviewed Environment Variables are `BROWSER_ACCESS_ISSUER`, `BROWSER_OWNER_EMAIL`, `BROWSER_ACTIVATION_ORIGIN`, and `BROWSER_ACTIVATION_AUDIENCE` (the activation pair is validated together). The independent Unknown Review page, Access application, and `BROWSER_APPROVAL_*` runtime settings were retired, but historical Unknown receipts and no-replay safeguards remain. Historical Browser-independent MCP credentials must not be reported as verified without establishing the actual Environment override and Portal configuration.
