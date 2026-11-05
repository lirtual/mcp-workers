# Cloudflare runtime configuration

**Spec #392 and subsequent Bark-only retirement:** The legacy Weixin MCP Worker and release entry are no longer maintained in this repository. [cloudflare-actions](https://github.com/lirtual/cloudflare-actions) owns the unified Action Provider; its current executable catalog contains no Weixin send operation. Historical data and recovery evidence are governed separately and are not deleted by GitHub configuration cleanup.

The eight independently managed MCP Workers share an MCP-entry Secret **name**, not a uniform hostname, credential or logging policy. Authoritative release contracts: `.github/workflows/release.yml`, `scripts/bootstrap-worker-secrets.mjs`, `scripts/worker-release-variables.mjs`, `scripts/manual-worker-release.mjs` and each app's `wrangler.jsonc`.

Spec #392 生产 Workflow 发布的单记录历史例外：仅对 2026-10-26 的 OpenList Run `47739981-0534-4966-8034-1e79c1d17481`，在 D1 原始结果、Cloudflare 原生实例已完成，以及 GitHub Session 实际终止全部只读核对成功后，允许其不阻断发布门禁；业务状态仍是 `indeterminate`，不得重试发送或删除历史。所有其他未解决的 Run、Session 和 Attempt 保持原来的拒绝规则。该例外不构成通用忽略开关，部署不自动停止现有 Session。

## Source of truth

- Wrangler defines non-secret settings, Cloudflare bindings and required Secret names; never commit secret values.
- The Repository is the canonical owner for `ACCESS_TEAM_DOMAIN` and `OWNER_EMAIL`; Browser and Database Environments must not override them. The GitHub Repository provides Secret `CLOUDFLARE_API_TOKEN`, the default `MCP_ACCESS_TOKEN` and Variable `CLOUDFLARE_ACCOUNT_ID`. A matching same-name GitHub Environment Secret overrides the default. Without an override, the next Worker release stages the Repository token; binding names do not establish whether deployed token values match. Shared Bearer values can widen the impact of credential disclosure, and existing Worker-specific security requirements are not waived by retaining the default.
- Every selected Worker has its own same-name GitHub Environment for app Secrets and whitelisted Variables. Only a separately approved, `main`-only, manual **Release Worker** run publishes it. Editing a GitHub Secret alone does not rotate live credentials.
- All Workers require `MCP_ACCESS_TOKEN`. `IMA_CLIENT_ID` and `WORKFLOW_MCP_PORTAL_CLIENT_ID` are required **plain-text Variables**, not Secrets.

## Worker-scoped configuration

| Worker | Additional Environment Secrets | Environment Variables |
| --- | --- | --- |
| `database-mcp-worker` | `DATABASE_ENCRYPTION_KEY`、`DATABASE_GITHUB_ACTIONS_TOKEN`（轮换时可选 `DATABASE_ENCRYPTION_PREVIOUS_KEY`） | `DATABASE_KEY_ID`、`DATABASE_ACCESS_AUD`（Environment 必填）；`ACCESS_TEAM_DOMAIN`、`OWNER_EMAIL`（Repository 必填，无同名 Environment 覆盖）；可选 `DATABASE_PREVIOUS_KEY_ID` 和 SQL 限额 |
| `browser-mcp-worker` | 当前无同名 `MCP_ACCESS_TOKEN` Environment Secret 覆盖；下一次发布将使用 Repository Secret，部署值兼容性尚未验收 | `ACCESS_TEAM_DOMAIN`、`OWNER_EMAIL`（Repository）、`BROWSER_ACTIVATION_AUDIENCE`（Environment）；其余运行时 Browser Access 值从共享源及 Wrangler Custom Domain 派生；可选 `BROWSER_REMEMBERED_IDLE_DAYS` |
| `ima-mcp-worker` | `IMA_API_KEY` | `IMA_CLIENT_ID`、`IMA_BASE_URL` |
| `raindrop-mcp-worker` | `RAINDROP_ACCESS_TOKEN` | `RAINDROP_RATE_LIMIT_MAX_RETRIES` |
| `ssh-mcp-worker` | `SSH_ENCRYPTION_KEY` | 无 |
| `remote-control-mcp-worker` | 无 | 无 |
| `github-actions-mcp-worker` | `ACTIONS_GITHUB_DISPATCH_TOKENS` | 无 |
| `workflow-mcp-worker` | `WORKFLOW_MCP_PORTAL_CLIENT_SECRET`、`WORKFLOW_GITHUB_DISPATCH_TOKEN`、`WORKFLOW_SESSION_RUNTIME_DATA_KEY` | `WORKFLOW_MCP_PORTAL_CLIENT_ID`、`WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES` |

Database MCP Spec #344 runs in production with encrypted, Owner-managed connections in D1 `database-mcp-registry`. The current release contract requires `DATABASE_ENCRYPTION_KEY`, `DATABASE_KEY_ID`, Owner Access Variables and `DB`; it neither consumes `DATABASE_CONFIG` nor imports historical records. Old database resources are retired only by a separately reviewed cleanup after deployment verification. See [Database production and recovery runbook](./database-cutover-344.md).

Notes: `IMA_BASE_URL`, Raindrop retry count, Browser remembered-idle override, Database limits and Workflow's `WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES` are optional Variables. IMA's `IMA_CLIENT_ID` and Workflow's `WORKFLOW_MCP_PORTAL_CLIENT_ID` are **required**. Workflow's approved-repositories GitHub Variable is translated to the `WORKFLOW_GITHUB_ACTION_APPROVED_REPOSITORIES` runtime binding.


`WORKFLOW_SESSION_RUNTIME_DATA_KEY` is a canonical 32-byte Base64-encoded key. SSH's `SSH_ENCRYPTION_KEY` must match the real EdgeSSH key protecting existing D1 records; the retired `SSH_BROKER_TOKEN` is not a release requirement. The legacy IMA DO binding must not be deleted during documentation maintenance. Other pinned variables (e.g. Workflow Portal endpoint and Remote Control installation origin) come from scripts or Wrangler, not arbitrary GitHub Environment input.

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

The Browser Worker uses `https://browser.lirtual.dpdns.org` as its production custom domain (`workers_dev: false`, `preview_urls: false`). Current activation uses Owner Access verification and a one-use same-Profile proof; the sole independent activation Environment Variable is `BROWSER_ACTIVATION_AUDIENCE`; runtime issuer and Owner are derived from shared Repository Variables and activation origin from the reviewed Wrangler Custom Domain. The independent Unknown Review page, Access application, and `BROWSER_APPROVAL_*` runtime settings were retired, but historical Unknown receipts and no-replay safeguards remain. The Browser GitHub Environment was independently verified to have no `MCP_ACCESS_TOKEN` Secret override as of 2026-11-06. This establishes the source for a **future** release, not the source used by historical releases or equality with the currently deployed Secret bytes. Before any Browser production release, a separately authorized protected Runner must verify that the effective Repository token can authenticate a safe read-only `tools/list` against the current direct Worker, and the release authorization must explicitly account for Portal registration/sync side effects. Do not create a new Environment Secret to satisfy an obsolete isolation assumption.

## Spec #733: separately authorized configuration cutover

As of 2026-11-06, the Database first production cutover passed independently in [Release Worker #42080572652](https://github.com/lirtual/mcp-workers/actions/runs/42080572652), including new runtime names, original D1/Secret identities, and safe unauthenticated checks. Its legacy GitHub Environment `ACCESS_AUD` Variable remains for rollback; that is not a completed GitHub cleanup. The Browser Environment's three obsolete Variables (`BROWSER_ACCESS_ISSUER`, `BROWSER_OWNER_EMAIL`, `BROWSER_ACTIVATION_ORIGIN`) were independently removed and `BROWSER_ACTIVATION_AUDIENCE` retained, but the Browser Worker has **not** been republished under Spec #733. SSH and Workflow Secret renames, production cutovers and separately authorized legacy cleanup are not completed. The [Spec #733 issue](https://github.com/lirtual/mcp-workers/issues/733) records the per-stage receipts and remains open.

The protected selected-Worker release preflight compares its effective identity with the Repository source captured by reusable CI; a separate authorized GitHub Settings inspection must verify same-name Environment variables are absent. Never rotate or expose existing Secret values during a rename. The SSH MCP `SSH_ENCRYPTION_KEY` must use the existing EdgeSSH `ENCRYPTION_KEY` bytes; the Workflow session and Portal Secrets must retain their existing values, published Plans, D1 ciphertext and target identity. Browser runtime issuer/owner/origin are derived from the Repository variables and reviewed Wrangler Custom Domain. Only newly approved GitHub Settings migration and Worker publication may change deployed bindings.

Wrangler can preserve omitted old `secret_text` names after the initial SSH/Workflow publication. Pending legacy bindings are not deletion evidence: first verify the new version and bindings, separately authorize old binding cleanup, then require independent negative Secret/binding inventory. `workflow_code_only` cannot perform the first rename migration. Unknown receipts are never replayed. See [ADR](./adr/0001-global-config-owner-names.md).

### Repository identity provenance check

The existing CI's pre-release job (which has **no** Worker GitHub Environment) captures `ACCESS_TEAM_DOMAIN` and `OWNER_EMAIL` as Repository-resolved values. The selected release job compares its effective values to these CI outputs and fails closed on mismatch. This comparison does **not** prove absence of a same-value Environment shadow. Before the separately authorized first Browser/Database production switch, inspect the actual GitHub Settings read-only, remove any same-name Environment variable with its own authorization, and verify that absence independently. The built-in `GITHUB_TOKEN` has no assumed Variables/Environments inventory permission and is not used to claim proof.

### Spec #733: migration-original-value gates and cleanup readback

Before the separately authorized first SSH or Workflow cutover, both old and new Workflow Portal Client IDs and repository-approval lists (when present) must exactly match the original reviewed values. Database preflight compares each of the five legacy numeric limits and any already-present renamed binding against the GitHub input (falling back to the source Wrangler default). An absent legacy limit is treated as the existing original runtime default, **not** permission to change it. Wrong types, invalid values or mismatches fail before Secret staging and deployment. Database postflight additionally verifies all renamed limits and absence of unprefixed bindings. This is a code-level guard; the GitHub Settings source-value migration is not done by merging this code.

For an independently authorized *post-deletion* negative-inventory acceptance, use the existing **Workflow Acceptance** manual workflow on `main`, selecting `legacy-cleanup-readonly-ssh` or `legacy-cleanup-readonly-workflow`, with `confirm_portal_write=false` and `cleanup_expected_version` equal to the exact approved live Worker version UUID. Its separate environment-scoped job checks GitHub main SHA, performs **only Cloudflare GET** for the selected Worker's settings, Secret inventory, deployments and script settings, verifies current required bindings and forbids the old Secret names, and compares the exact active version. It never removes a Secret, updates a GitHub setting, publishes a Worker or mutates the release state file. A failed or Unknown readback must be investigated without retrying deletion. Deletion itself requires a separate approval under the existing protected release mechanism. Until successful negative-inventory evidence exists, cleanup remains **Not performed**.
