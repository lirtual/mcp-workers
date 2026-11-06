# MCP Worker 手动发布约束

本项目使用唯一的 `main` 分支和唯一一套 Cloudflare Worker，不维护 production/staging 环境切换。GitHub **Environments 只用于每个 Worker 的 Secrets / Variables 配置隔离**。

详细配置与迁移说明：[MANUAL-WORKER-BOOTSTRAP.md](./MANUAL-WORKER-BOOTSTRAP.md)。

## 发布准入

- 仅由 GitHub Actions → Release Worker → `workflow_dispatch` 在当前 `main` 触发；PR 和 push CI 只运行检查，不执行发布。
- 只能选择一个明确白名单 Worker。数据库必须通过真正的 PostgreSQL/MySQL 集成检查；其他 Worker 不得被数据库集成步骤错误阻挡。
- 每个 Worker 使用与脚本同名的 GitHub Environment，例如 `ima-mcp-worker`。Actions 自动选择该名称，无须维护 `WORKER_CONFIG_SCOPE`。GitHub 可能自动建立尚不存在的空 Environment，应事先配置 Worker 专属 Secrets、审批与分支保护；每次手动部署缺少必需密钥都必须在上传前失败。
- Repository Secrets 放 `CLOUDFLARE_API_TOKEN`、默认的 `MCP_ACCESS_TOKEN`；Repository Variable 放 `CLOUDFLARE_ACCOUNT_ID`。Worker 自己的 Environment 保存其余敏感字段。对应同名 Environment Secret 可覆盖全局 Portal Token。
- **仅对仍使用旧 `production` Environment 的部署**，先将其必需密钥与保护规则迁移到对应 Worker Environment，并完成读回核对；在此之前不要启动新的手动发布，也不要删除旧 Environment。已完成迁移的 Worker 无需重复执行。所有敏感值不得出现在代码/日志/PR 中。
- 发布前检查当前 `main` SHA，校验 Cloudflare 状态及 Worker 是否存在；首次发布还须满足对应 Worker 的专项前置检查；不能将不存在的 Worker 或自动创建的空 Environment 当作部署许可。
- 首次部署及后续每次手动发布，均通过 `wrangler deploy --secrets-file` 同步被选 Worker 的全部必需 GitHub Secrets；缺失或空值则拒绝发布，不再静默沿用现网旧值。其他 Worker、`edgessh` 不受该次发布影响。
- 受管 Worker 使用 `keep_vars: false`；运行时普通 Variables 仅来自 Wrangler 配置默认值及被选 GitHub Environment 白名单覆盖，不再保留 Dashboard 临时配置。凭据必须使用 Secret，不以 Variable 传递；IMA 的 `IMA_CLIENT_ID` 和 Workflow 的 `WORKFLOW_MCP_PORTAL_CLIENT_ID` 是明确允许的非秘密标识符 Variable。

## 手动入口

- `CI`：Push / PR 自动检查，不接受手动发布参数；`Release Worker`：选择 Worker 并明确勾选 `deploy_to_production`，在 `main` 上复用 CI 检查后发布。
- `Workflow Acceptance`：手动选择唯一的 `test_type`。`portal-readonly` 仅执行正式 Portal MCP 认证、`tools/list` 和只读 `workflow_list`，不读取 IMA 笔记及其他业务数据；在 GitHub Environment 尚未更名时从现有 `MCP_PORTAL_CLIENT_ID` / `MCP_PORTAL_CLIENT_SECRET` 安全映射至客户端输入（不修改 Settings、不可当作解密 E2E）；`production-*` 会创建并清理随机测试记录，其中 GitHub 类型还会触发真实 GitHub Job；`github-action-result-cloud` 使用隔离 D1；`portal-register` **会修改正式 Portal 配置**，与 Worker 部署相互独立，必须额外勾选 `confirm_portal_write`；普通验收保持此选项关闭。

## Workflow 当前生产资源

正式 Worker 绑定 `DB` → `workflow-mcp-db`、`WORKFLOW` → `workflow-mcp-orchestrator` / `WorkflowOrchestrator`，以及 `ACTIONS` → `cloudflare-actions` / `ActionsEntrypoint` Service Binding。旧 Cloudflare Workflow 实例及资源已在所有者授权后退役，不再保留 `WORKFLOW_LEGACY`、`WorkflowRunner` 等兼容入口。已应用的 D1 Migration 文件名属于数据库历史标识，保持不变。

后续 Workflow 日常发布继续使用现有 GitHub Actions Release Worker，保留严格的 D1 schema、真实 GitHub Executor/OIDC 和生产绑定读回校验。不为本次历史清理增加功能开关、迁移系统或第二套发布链路。

## 发布后核对

- Wrangler 返回的确切 Version ID 与 Cloudflare 100% 活跃 Version ID 必须一致；更新时还需验证是新部署。
- 验证该 Worker 必需的 Secret 名称、Durable Objects、限流、Service Binding、观测配置及源码兼容标识。不打印原始 Wrangler 失败日志或敏感内容。
- 对 IMA、Raindrop 等已有健康检查接口复核响应；未经授权请求必须被拒绝（HTTP 401/403），然后再由用户在原 MCP Portal 完成受认证的 `initialize`、`tools/list` 和安全只读操作。
- 发布失败不得自动重置 Durable Objects、重放不确定的远程操作、批量发布其他 Worker 或修改原 `edgessh`。
- SSH 使用既有 EdgeSSH D1 的只读应用访问和自己的 `SSH_OPERATIONS` Durable Object，并以相同的 `SSH_ENCRYPTION_KEY` 解密选定主机记录；它不是数据库级只读权限。现行方案不使用已退役的 `EDGE_SSH_BROKER` Service Binding，不重建数据库，也不擅自轮换已有密钥。
- Remote Control 严格维持独立 SQLite `DeviceCoordinator`（不能复用 Preview DO、不能使用 VPC 和 v1/v2 运行模式开关）；不将既有的配对、身份或回执验收默认为新环境测试。

正常版本回退需重新审核代码并人工发布，不要在不确定性操作发生后盲目重试或擦除状态。`MCP_ACCESS_TOKEN` 来自 Repository Secret（允许每个 Environment 同名覆盖），并在被选 Worker 每次手动发布时同步。修改 Repository Secret 不会自动部署全部 Worker；需要协调逐个手动发布与 Portal 客户端凭据切换，尤其共享的 `MCP_ACCESS_TOKEN` 和 SSH 的 `SSH_ENCRYPTION_KEY`（EdgeSSH 与 SSH MCP 需与既有加密记录对应并分别验收），以及 GitHub Actions MCP 的 `ACTIONS_GITHUB_DISPATCH_TOKENS`。发布前确认 GitHub 中的 IMA 等凭据已与现网有效值一致，否则会覆盖现有生效 Secret。IMA 的 `IMA_CLIENT_ID` 改由该 Worker 的必填 GitHub Environment Variable 提供，`IMA_API_KEY` 仍保密。只有遗留部署仍带有旧 `CLIENT_ID` Variable 时，才需要按部署指南执行一次性迁移；当前 IMA 生产绑定已是 `IMA_CLIENT_ID` 的 `plain_text`，正常发布仍须通过绑定读回，不能把失败当成迁移完成。

Browser 当前使用已审核的 Custom Domain `browser.lirtual.dpdns.org` 和 Owner Access 激活配置；旧独立 Unknown Review / `BROWSER_APPROVAL_*` 运行时配置已退役。既有 Browser 独立 `MCP_ACCESS_TOKEN` 要求不因仓库级默认 Token 机制而自动豁免。参见 [runtime configuration](./runtime-configuration.md) 的当前配置与历史候选清单；本文档修改不触发 Worker 发布或凭据更新。

### Spec #733 first migration and post-cleanup

The protected release now fails closed if both old and renamed Workflow identity/grants variables exist with different values, or if any Database numeric limit would change from its previously deployed binding or default. The Workflow identity/grants GitHub Variables were migrated with exact-value proof. Under the approved Spec #733 naming exception, SSH/Workflow old-name GitHub Environment Secrets remain the sole release inputs mapped to canonical runtime names; do not copy, replace or rotate them merely to rename a binding. The independent cleanup acceptance path is `Workflow Acceptance` → `legacy-cleanup-readonly-ssh` / `legacy-cleanup-readonly-workflow` with the reviewed active version. This check **only reads** Cloudflare resources after separately authorized old Secret deletion; do not confuse its PASS with approval to perform deletion or a new Worker release.

## Database Spec #760

Database now uses the [flat URI/Secret configuration and cutover contract](../apps/database-mcp-worker/README.md). Setup, D1/encryption checks and Hyperdrive lifecycle dispatch inputs/jobs are retired. Only `database_expected_release_sha` remains as a Database-specific release input. Production requires independent authorization and fresh old-registry/Unknown-operation/recovery inspection; source merge does not perform this inspection or the cutover. Old D1, keys, Secrets, Hyperdrive resources and rollback versions are preserved until separately approved cleanup.

### Spec #733 — optional legacy runtime Secret cleanup (separately authorized)

The first canonical runtime Secret cutovers passed under
[SSH Release #42185081301](https://github.com/lirtual/mcp-workers/actions/runs/42185081301)
and [Workflow Release #42186878537](https://github.com/lirtual/mcp-workers/actions/runs/42186878537).
Their **later separately authorized cleanup is complete**:

| Worker | Cleanup production receipt | Active version | Removed **Cloudflare runtime** binding(s) |
| --- | --- | --- | --- |
| SSH | [Publish #42222417701](https://github.com/lirtual/mcp-workers/actions/runs/42222417701) | Version 11 `0cf2a9f5-078d-4811-8f92-813037deea54` (100%) | `ENCRYPTION_KEY` |
| Workflow | [Prepare #42225112645](https://github.com/lirtual/mcp-workers/actions/runs/42225112645), [Publish #42226359925](https://github.com/lirtual/mcp-workers/actions/runs/42226359925) | Version 141 `3883c6bf-0581-4e3a-8b58-ed8e5ec9f1ba` (100%) | `MCP_PORTAL_CLIENT_SECRET`, `SESSION_RUNTIME_DATA_KEY` |

Independent Cloudflare version/settings/Secret-name inventories confirmed the old names absent and all other bindings preserved. SSH's RackNerd/CloudCone authenticated directory reads and Workflow's authenticated `workflow_list`/`workflow_get` read paths passed. Previous active versions remain retained; reverting to one is another production change requiring separate authorization.

The **GitHub Environment** Secrets `ENCRYPTION_KEY`, `MCP_PORTAL_CLIENT_SECRET`, and
`SESSION_RUNTIME_DATA_KEY` are deliberately **retained authoritative release inputs**,
not cleanup targets. Workflow's `session_runtime_data` had zero records: historical
AES-GCM decrypt on Version 141 is **Not performed**, not Pass. No production business
Action/Session was invoked. [Detailed receipt](https://github.com/lirtual/mcp-workers/issues/733#issuecomment-6686213244).

The existing Release Worker has a disabled-by-default `legacy_secret_cleanup_mode` input:
`none` (normal release), `prepare`, and `publish`. The latter two are enabled only for SSH,
Workflow, and Database; they require `deploy_to_production=true`, an exact reviewed `main` SHA and active
Worker version UUID, successful existing CI, Owner dispatch, the selected Worker Environment,
and the normal per-Worker release lock. Each Worker and phase requires **separate production
authorization**; enabling the mode is not itself authorization.

- **Prepare:** set `legacy_cleanup_expected_sha` and
  `legacy_cleanup_expected_active_version`, leave `legacy_cleanup_candidate_version`
  empty. A single `wrangler versions secret bulk` operation creates a **nondeployed**
  version removing only `ENCRYPTION_KEY` (SSH), or the two legacy Workflow runtime names
  together. Read-only checks then confirm the original active version remains at 100%,
  candidate code etag and resource metadata are unchanged, and canonical Secrets remain.
  Record the candidate version UUID from the protected Run. Preparation changes a
  production-version resource but **does not route traffic**.
- **Publish:** separately authorize the exact prepared UUID. Use `legacy_secret_cleanup_mode=publish`
  with the same reviewed source SHA and active baseline plus
  `legacy_cleanup_candidate_version=<approved UUID>`. Re-check everything under the
  existing Worker lock, then use `wrangler versions deploy` to promote that version
  to 100%. The existing `manual-worker-release.mjs cleanup-readback` confirms the
  exact live version and Secret removal; subsequently use Workflow Acceptance
  `legacy-cleanup-readonly-ssh` or `legacy-cleanup-readonly-workflow` for an
  independently authorized GET-only verification. Business/SSH decryption checks need
  their own scope and evidence.

For Database **before its cleanup Prepare**, the live Secret inventory must be exactly `MCP_ACCESS_TOKEN`,
`DATABASE_B2B_PASSWORD`, `DATABASE_SCRAPE_RELAY_PASSWORD`, and the three old runtime
Secrets. Prepare removes only `DATABASE_ENCRYPTION_KEY`,
`DATABASE_GITHUB_ACTIONS_TOKEN`, and `DATABASE_KEY_ID`. The candidate preserves
`DATABASE_CONNECTIONS`, Variables, `RATE_LIMITER`, Hyperdrive/resource bindings, script
ETag and runtime. The current Database Version 46 `c28c0af8-e773-4400-9106-425779932fcf` is 100% live with those three legacy bindings absent; a fresh Version 46 business query/decrypt E2E remains **Not performed** ([readback evidence](https://github.com/lirtual/mcp-workers/issues/733#issuecomment-6685620405)). Ordinary release readback retains its six-name migration allowance;
the cleanup path enforces only these exact three deletion names. GitHub Environment
configuration, D1, and older Worker versions are outside this cleanup.

Never invoke `wrangler secret delete` (immediate publish), raw Cloudflare writes, or a
normal `wrangler deploy` as a shortcut. No Secret plaintext, GitHub Settings changes,
new D1 migrations, key rotation, or alternate release system are required. A failure
or Unknown result must be reconciled through read-only state inspection, without
automatic retry or rollback. The last independently verified live Worker version
is the recovery target until replaced by a freshly inspected baseline, but restoring
an older version is itself another production change requiring authorization.
