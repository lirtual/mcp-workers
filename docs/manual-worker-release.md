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
- `Workflow Acceptance`：手动选择唯一的 `test_type`。`portal-readonly` 仅执行正式 Portal MCP 认证、`tools/list` 和只读 `workflow_list`，不读取 IMA 笔记及其他业务数据；使用规范 Variable `WORKFLOW_MCP_PORTAL_CLIENT_ID`，并将保留原名的 GitHub Secret `MCP_PORTAL_CLIENT_SECRET` 安全映射至客户端输入（不修改 Settings、不可当作解密 E2E）；`production-*` 会创建并清理随机测试记录，其中 GitHub 类型还会触发真实 GitHub Job；`github-action-result-cloud` 使用隔离 D1；`portal-register` **会修改正式 Portal 配置**，与 Worker 部署相互独立，必须额外勾选 `confirm_portal_write`；普通验收保持此选项关闭。

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

The protected release now uses only canonical Workflow identity/grants Variables and still fails closed if any Database numeric limit would change from its previously deployed binding or default. The Workflow identity/grants GitHub Variables were migrated with exact-value proof. Regular Release Worker and Portal read-only Acceptance now use only canonical names; the two old Environment Variable names were deleted after separately authorized exact-value checks and independent negative-inventory readback ([final receipt](https://github.com/lirtual/mcp-workers/issues/733#issuecomment-6687671219)). Under the approved Spec #733 naming exception, SSH/Workflow old-name GitHub Environment Secrets remain the sole release inputs mapped to canonical runtime names; do not copy, replace or rotate them merely to rename a binding. The independent cleanup acceptance path is `Workflow Acceptance` → `legacy-cleanup-readonly-ssh` / `legacy-cleanup-readonly-workflow` with the reviewed active version. This check **only reads** Cloudflare resources after separately authorized old Secret deletion; do not confuse its PASS with approval to perform deletion or a new Worker release.

## Database Spec #760

Database now uses the [flat URI/Secret configuration and cutover contract](../apps/database-mcp-worker/README.md). Setup, D1/encryption checks and Hyperdrive lifecycle dispatch inputs/jobs are retired. Only `database_expected_release_sha` remains as a Database-specific release input. The documented production cutover and Version 46 legacy Secret cleanup are complete; future production releases still require separate authorization, fresh Unknown-operation/recovery inspection and independent runtime readback. A source merge alone does not publish. Old D1, keys, Secrets, Hyperdrive resources and rollback versions are preserved until separately approved cleanup.

### Spec #733 — completed legacy runtime Secret cleanup (separately authorized)

The first canonical runtime Secret cutovers passed under
[SSH Release #42185081301](https://github.com/lirtual/mcp-workers/actions/runs/42185081301)
and [Workflow Release #42186878537](https://github.com/lirtual/mcp-workers/actions/runs/42186878537).
Their **later separately authorized cleanup is complete**:

| Worker | Cleanup production receipt | Active version | Removed **Cloudflare runtime** binding(s) |
| --- | --- | --- | --- |
| SSH | [Publish #42222417701](https://github.com/lirtual/mcp-workers/actions/runs/42222417701) | Version 11 `0cf2a9f5-078d-4811-8f92-813037deea54` (100%) | `ENCRYPTION_KEY` |
| Workflow（Spec #733 历史状态） | [Prepare #42225112645](https://github.com/lirtual/mcp-workers/actions/runs/42225112645), [Publish #42226359925](https://github.com/lirtual/mcp-workers/actions/runs/42226359925) | 当时 Version 141 `3883c6bf-0581-4e3a-8b58-ed8e5ec9f1ba` (100%)；Version 142 为后续历史快照，现行状态见文末 2026-11-09 回读 | `MCP_PORTAL_CLIENT_SECRET`, `SESSION_RUNTIME_DATA_KEY` |

Independent Cloudflare version/settings/Secret-name inventories confirmed the old names absent and all other bindings preserved. SSH's RackNerd/CloudCone authenticated directory reads and Workflow's authenticated `workflow_list`/`workflow_get` read paths passed. Previous active versions remain retained; reverting to one is another production change requiring separate authorization.

The **GitHub Environment** Secrets `ENCRYPTION_KEY`, `MCP_PORTAL_CLIENT_SECRET`, and
`SESSION_RUNTIME_DATA_KEY` were **retained authoritative release inputs under #733**.
For Spec #774, `SESSION_RUNTIME_DATA_KEY` alone is now a pending cleanup target,
but must remain until the active Worker and authorized recovery dependencies no longer need it. Workflow's `session_runtime_data` had zero records: historical
AES-GCM decrypt on Version 141 is **Waived by explicit Owner approval, not Pass** ([decision](https://github.com/lirtual/mcp-workers/issues/733#issuecomment-6687070101)). No production business
Action/Session was invoked. [Detailed receipt](https://github.com/lirtual/mcp-workers/issues/733#issuecomment-6686213244).

The existing Release Worker has a disabled-by-default `legacy_secret_cleanup_mode` input:
`none` (normal release), `prepare`, `publish`, and the narrowly pinned Workflow #774 `restore`.
Prepare/Publish are enabled only for SSH,
Workflow, and Database; they require `deploy_to_production=true`, an exact reviewed `main` SHA and active
Worker version UUID, successful existing CI, Owner dispatch, the selected Worker Environment,
and the normal per-Worker release lock. Each Worker and phase requires **separate production
authorization**; enabling the mode is not itself authorization.

- **Prepare:** set `legacy_cleanup_expected_sha` and
  `legacy_cleanup_expected_active_version`, leave `legacy_cleanup_candidate_version`
  empty. A single `wrangler versions secret bulk` operation creates a **nondeployed**
  version removing only `ENCRYPTION_KEY` (SSH), or the two Spec #733 legacy Workflow runtime names
  together. With Spec #774 `uu_session_secret_cleanup=true`, a separate Prepare removes only
  `WORKFLOW_SESSION_RUNTIME_DATA_KEY`, never the Portal or GitHub dispatch Secret. Read-only checks then confirm the original active version remains at 100%,
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
ETag and runtime. The current Database Version 46 `c28c0af8-e773-4400-9106-425779932fcf` is 100% live with those three legacy bindings absent; Version 46 authenticated `b2b` and `scrape_relay` health and bounded `SELECT 1` are **Pass** ([live E2E](https://github.com/lirtual/mcp-workers/issues/733#issuecomment-6686760458)); the retired Database D1/AES-GCM connection-registry decrypt is not applicable to the current Spec #760 runtime. Ordinary release readback retains its six-name migration allowance;
the cleanup path enforces only these exact three deletion names. GitHub Environment
configuration, D1, and older Worker versions are outside this cleanup.

Never invoke `wrangler secret delete` (immediate publish), raw Cloudflare writes, or a
normal `wrangler deploy` as a shortcut. No Secret plaintext, GitHub Settings changes,
new D1 migrations, key rotation, or alternate release system are required. A failure
or Unknown result must be reconciled through read-only state inspection, without
automatic retry or rollback. The last independently verified live Worker version
is the recovery target until replaced by a freshly inspected baseline, but restoring
an older version is itself another production change requiring authorization.


### Spec #774 UU Secret 退役与精确版本恢复

已完成的 [Prepare #42341187538](https://github.com/lirtual/mcp-workers/actions/runs/42341187538)
仅创建未部署 Version 143 3f27e9ca-790c-4ec9-914e-cb4204a736e6，
候选相对活动 Version 142 414da2d7-a16f-4ce6-9350-013ad4f7166a
仅移除运行时 WORKFLOW_SESSION_RUNTIME_DATA_KEY；其余资源一致。
新恢复入口代码已合并，但 **Version 143 Publish 遭平台安全检查拒绝，Restore 未执行**；
[阻断回执](https://github.com/lirtual/mcp-workers/issues/774#issuecomment-6703911930)
证明没有被接受的设备端派发，GitHub 无新 Release Run。禁止重试、更换渠道或
将其认定为发布成功。正式 Windows 已恢复 Active。

复用同一个受保护 Release Worker、Owner/main 精确 SHA、成功 CI、
workflow-mcp-worker Environment 和 Worker 互斥锁。在单独生产恢复授权下，
选择 worker=workflow-mcp-worker、
legacy_secret_cleanup_mode=restore、uu_session_secret_cleanup=true、
workflow_code_only=false、deploy_to_production=true；
legacy_cleanup_expected_sha 必须为当时重新核准的精确 main SHA，
legacy_cleanup_expected_active_version 必须为 Version 143 上述 UUID，
legacy_cleanup_candidate_version 必须为 Version 142 上述 UUID。
所有无关 Actions 迁移/门禁/Secret Prepare 参数保持关闭。

恢复前必须实际确认 **Version 143 唯一 100% 活动**、Version 142 保留
原 11 个绑定和旧密钥、两个版本的全部其他资源完全一致、Windows 已 Paused、
D1 20 项已应用迁移与空旧表及 12 条历史 Unknown 不变、Sessions 和原生实例
已排空。脚本仅通过已有 wrangler versions deploy <Version142>@100 路径恢复；
事后再独立证明 Version 142 唯一 100% 活动及原旧密钥绑定仍随该版本存在。
Cloudflare 最新版本 Settings 可能仍反映 Version 143 的三个 Secret，不可
据此判断活动 Version 142 是否有四个 Secret。

恢复必须在真实 Publish 结果消歧、用户单独明确批准且全部门禁通过后执行，
**不自动回滚、不对 Unknown 重试**。保留 GitHub Environment 来源
SESSION_RUNTIME_DATA_KEY、旧 D1 表及历史版本；未完成回滚验收前不得
把 Version 142 称作已验证恢复。当前 D1 仍有 20 项 Migration、空表、
12 条历史 indeterminate Run、12 条未终态 Step 和 1 条 claimed Attempt；
[Draft PR #777](https://github.com/lirtual/mcp-workers/pull/777) 的 D1 DROP
受原全局 Migration 门禁阻断且不得合并，不能借 Secret 发布绕过它。

### Spec #774 新的独立 D1 清理入口（覆盖上述历史 Prepare/Restore 状态）

2026-11-07 GitHub [Run #42364599988](https://github.com/lirtual/mcp-workers/actions/runs/42364599988)
已将 Version 143 UUID `3f27e9ca-790c-4ec9-914e-cb4204a736e6` 正式发布为
唯一 100% 活动版本，旧 UU 运行时 Secret 已退出；Windows 已恢复 Active，
详见 [#774 验收](https://github.com/lirtual/mcp-workers/issues/774#issuecomment-6705774013)。
本节之前的「版本未发布」「恢复入口」描述是历史记录而非当前行动方案。

PR #777 只准备隔离的 `workflow-uu-table-retirement` Job，**未授权执行**：
`worker=workflow-mcp-worker`、`uu_cleanup_approved=true`、
`uu_cleanup_expected_sha=<生产时单独审核的精确 main SHA>`、
`uu_cleanup_expected_active_version=3f27e9ca-790c-4ec9-914e-cb4204a736e6`；
`deploy_to_production=false`（该字段指 Worker Publish；此 Job 仍然是
**生产 D1 破坏性写入**）、`workflow_code_only=false`、
`legacy_secret_cleanup_mode=none`，其余 Actions/Secret 开关均保持 false。
此参数集只是设计记录，不构成生产授权；如 main SHA 或运行事实漂移，
必须重新预检并请求新的具体授权。未经此授权不得 Merge、派发或清理。

此 Job 复用现有 CI、workflow-mcp-worker Environment 和互斥锁，
先只读检查 D1 v20/空表、12 条历史 Unknown 原样存在、Version143/10
绑定、Windows Paused、全部 Native 实例排空与分页、精确审核 SHA；
仅由 Wrangler 正式 Migration Registry 执行 v21，随后确认仅此表消失、
21 项 Migration 和历史回执不变。错误或 Unknown 先只读消歧，不重试。
普通 D1 Migration 仍调用原 `verifyWorkflowMigrationReadiness`，
历史 Unknown 不清除、不豁免；其他旧 D1 迁移入口必须拒绝 pending v21。

选择不保持旧 Version142 兼容。v21 应用后，原 `143→142` Restore
会要求旧空表而不再有效；不要以此作为恢复手段。
不修改 Source Secret `SESSION_RUNTIME_DATA_KEY`；它需要另行
批准、核实无生产/恢复引用后，经正常 GitHub 管理路径删除和回读。


### 2026-11-09 当前来源与恢复限制（覆盖上方历史阶段描述）

详细证据见 [配置清单与生产绑定回读](./runtime-configuration.md#2026-11-09-配置与生产绑定最新只读核对)。

- Workflow Environment 当前仅有 `MCP_PORTAL_CLIENT_SECRET`、`WORKFLOW_GITHUB_DISPATCH_TOKEN` 两项 GitHub Secret；#774 已完成 `SESSION_RUNTIME_DATA_KEY` 删除和 v21 旧 UU 表退役。上述「待删除」「Version 142 当前 100%」「PR #777 Draft/Open」均仅属其当时快照。PR #777 已于 2026-11-07 合并，#774 已关闭；Cloudflare 当前活动版本 `7b74910d-03cb-4be8-bd34-9af4146371d9`（100%，10 个绑定）。
- 旧 Version 142 的版本化密钥绑定不等于 v21 后可执行的恢复入口，也不能用绑定名称证明原值；不得按本页历史 143→142 参数直接派发，任何恢复必须重新核对和授权。
- Database 旧配置 `DATABASE_ACCESS_AUD`、`DATABASE_KEY_ID`、`DATABASE_ENCRYPTION_KEY`、`DATABASE_GITHUB_ACTIONS_TOKEN` 当前 Version 46 不使用，但旧 Cloudflare 版本仍有对应绑定，故暂保留作为旧源码恢复来源。本次不修改 GitHub 配置、Secret 原值或生产资源。
