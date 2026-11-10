# 手动发布 MCP Workers：GitHub Repository 统一配置

> **Spec #849 迁移准入：** 本文描述迁移完成后的发布契约，**不表示 GitHub Settings 已迁移**。2026-11-10 预检时 Repository 有 4 个 Variables 和 4 个 Secrets，另有 2 个 Environment Variables、6 个 Environment Secrets 和 10 个 Environments。先保证全部凭据原值可安全转移、独立验证后再切换工作流消费者；不要仅凭代码 PR、CI 成功或 Secret 更新时间合并切换 / 删除旧来源。GitHub Settings 修改、Environment 删除和生产发布需要分别明确授权。

本项目每个 Worker 只有一个既有 Cloudflare 生产实例，没有 staging/production 多运行环境。GitHub Actions 的 `Release Worker` 仅在受控手动派发、`main`、Owner 和现有预检通过后选择一个 Worker；普通 `main` Push 只运行 CI，不自动部署。

## 一、单一 GitHub Repository 配置源（迁移目标）

在 [GitHub Actions Secrets and variables](https://github.com/lirtual/mcp-workers/settings/secrets/actions) 按现有名称和类型管理：

| 类型 | 名称 |
| --- | --- |
| Repository Variable | `CLOUDFLARE_ACCOUNT_ID`、`DATABASE_CONNECTIONS`、`OWNER_EMAIL`、`WORKFLOW_GITHUB_ACTION_REPOSITORY`、`IMA_CLIENT_ID`、`WORKFLOW_MCP_PORTAL_CLIENT_ID` |
| Repository Secret | `CLOUDFLARE_API_TOKEN`、`DATABASE_B2B_PASSWORD`、`DATABASE_SCRAPE_RELAY_PASSWORD`、`MCP_ACCESS_TOKEN`、`ACTIONS_GITHUB_DISPATCH_TOKENS`、`IMA_API_KEY`、`RAINDROP_ACCESS_TOKEN`、`SSH_ENCRYPTION_KEY`、`WORKFLOW_GITHUB_DISPATCH_TOKEN`、`WORKFLOW_MCP_PORTAL_CLIENT_SECRET` |

迁移后应严格为 **6 Variables、10 Secrets、0 GitHub Environments**。上述两个 Client ID 是非秘密 `plain_text` 输入，不能错误转换为 Secret。六个新 Repository Secret 必须与旧 Environment Secret **完整原始字节一致**；尤其保留多行 PAT 和 SSH 加密历史数据的密钥。不得轮换、重命名或生成替代值。

`DATABASE_CONNECTIONS` 是现行 Database 连接清单；引用的密码依旧是独立 GitHub Repository Secrets，Hyperdrive 在 Cloudflare 原生管理，不能恢复旧 D1 Setup 方案。`OWNER_EMAIL` 为 Browser 唯一人工维护的 Owner 邮箱来源，Issuer/Audience/Origin 按现有 Cloudflare/发布脚本派生。`WORKFLOW_GITHUB_ACTION_REPOSITORY` 指向受控目标仓库，旧批准列表不再是配置源。

## Worker 配置映射（迁移目标）

| Worker | Repository Secret（另加共享 `MCP_ACCESS_TOKEN`） | Repository Variable |
| --- | --- | --- |
| `database-mcp-worker` | `DATABASE_B2B_PASSWORD`、`DATABASE_SCRAPE_RELAY_PASSWORD` | `DATABASE_CONNECTIONS` |
| `browser-mcp-worker` | 无额外 Secret | `OWNER_EMAIL` |
| `ima-mcp-worker` | `IMA_API_KEY` | `IMA_CLIENT_ID` |
| `raindrop-mcp-worker` | `RAINDROP_ACCESS_TOKEN` | 无必填 |
| `ssh-mcp-worker` | `SSH_ENCRYPTION_KEY` | 无 |
| `remote-control-mcp-worker` | 无额外 Secret | 无 |
| `github-actions-mcp-worker` | `ACTIONS_GITHUB_DISPATCH_TOKENS` | 无 |
| `workflow-mcp-worker` | `WORKFLOW_MCP_PORTAL_CLIENT_SECRET`、`WORKFLOW_GITHUB_DISPATCH_TOKEN` | `WORKFLOW_MCP_PORTAL_CLIENT_ID`、`WORKFLOW_GITHUB_ACTION_REPOSITORY` |

## 二、切换准入与不可逆清理

1. 只读检查最新 `main`、成功 CI、触发链、权限、有效值来源、正在运行/等待审批的 Jobs、10 个 Environment 当前条目及可恢复基线。
2. **在任何配置写入前**核实全部 6 个现存 Secret 均有平台允许的安全原值传递与独立字节验证途径；GitHub API 不能读回 Secret 原文。若不可行，停止该项，不删旧源，不用功能 smoke/时间戳冒充字节一致。
3. 获得独立授权后，先复制 2 个 Variables 和 6 个 Secrets 到 Repository，独立核对原值、名称与类型；旧 Environment 保留作为此阶段的可用来源。仍绑定 Environment 的 Job 读取同名 Secret 时会被旧来源遮蔽，不能当作 Repository 来源已验证。
4. 仅在全部迁移来源验证 Pass 后，才允许按受控路径切换移除所有 `job.environment` 引用的发布/验收工作流；通过静态契约与 CI，并在确实没有 Environment 绑定的真实受信任只读消费边界核验来源。不要为此触发 Worker 发布、数据写入或不必要的多服务 E2E。
5. Environment 删除需另行授权。按真实可执行路径批量排查历史分支/工作流旧引用及在途 Jobs（GitHub 可能在引用不存在的 Environment 时重新创建空 Environment）。串行删除全部 10 个并独立回读，结果 Unknown 时先只读消歧。不要新增长期清扫服务。

Repository Secrets 对仓库内符合条件的工作流开放，不能再视为按 Worker 的 GitHub 权限隔离。Owner 已接受 Repository 暴露范围扩大、Agent Release 人工审批退役、`main` 无平台分支保护等风险；现有代码门禁不等价于 GitHub 平台审批。

## 三、按选中 Worker 发布（迁移后）

打开 [Release Worker](https://github.com/lirtual/mcp-workers/actions/workflows/release.yml)，固定 `main`，选择一个 `worker`；生产发布需显式授权并设置 `deploy_to_production=true`。当前工作流持续执行 Owner/main/SHA/CI/互斥与 Worker 范围检查，先行校验必需配置，再只针对所选 Worker 上传其运行时 Secret / Variable。

- 全部 Worker 使用共享 `MCP_ACCESS_TOKEN`；`CLOUDFLARE_API_TOKEN` 仅供必要的受控发布步骤使用。
- IMA 必需 `IMA_CLIENT_ID`（Repository Variable）和 `IMA_API_KEY`（Repository Secret），运行时分别为 `plain_text` / `secret_text`。
- Workflow 必需 `WORKFLOW_MCP_PORTAL_CLIENT_ID`（Repository Variable）和 `WORKFLOW_MCP_PORTAL_CLIENT_SECRET`、`WORKFLOW_GITHUB_DISPATCH_TOKEN`（Repository Secrets），原运行时绑定名不变。
- SSH 继续用原始 `SSH_ENCRYPTION_KEY`；GitHub Actions MCP 继续用原始可多行 `ACTIONS_GITHUB_DISPATCH_TOKENS`；Raindrop 使用 `RAINDROP_ACCESS_TOKEN`。数据库继续使用现有命名密码 Secrets。
- 非目标 Worker 的 Secret 不注入通用暂存步骤。代码仅在选中 Worker 的步骤里暂存其必需项，不改变 GitHub Repository Secrets 对仓库工作流的访问信任边界。
- 可选非密变量沿用现有 `worker-release-variables.mjs` 白名单、类型与默认值；未被白名单允许的 Repository Variable 不会自动复制到 Cloudflare。

每次实际发布都要独立核对 100% 活跃版本、运行时 Secret/Variable 类型、DO/D1/Service Bindings，以及已授权的只读功能；**修改 GitHub Settings 或合并代码不等于部署 Cloudflare**。不得重建历史 UU Session Secret、旧 SSH Secret、旧 Browser 手工 Audience 或旧 Weixin 来源。

历史 Spec #733/#774/#804 审计和 Waived 证据保留在 [当前运行配置](./runtime-configuration.md) 与各独立 Spec 中；本指南不对历史事件重定性。恢复旧版本前必须重新核实其绑定与密钥要求，不假设原 GitHub Environment 已可恢复。

## 附录：历史验收记录（原文保留，非现行操作指引）

Spec #774 补充（非生产，尚未执行切换）：原表格记录 Spec #733
历史映射；新 Worker 源码将 UU 来源 SESSION_RUNTIME_DATA_KEY
退役，不再装载运行时 WORKFLOW_SESSION_RUNTIME_DATA_KEY。
Production 原绑定和 GitHub 来源 Secret 仍存在并受保护，
仅在单独授权的 Version Prepare/Publish 及回读验收后
才可通过独立授权删除 GitHub 来源值。

### Spec #804 Browser 发布输入（生产已切换，冗余 GitHub 来源已清理）

Repository `OWNER_EMAIL` 是唯一人工维护的 Owner 身份 Variable。
受保护 Release Runner 只读取得 Zero Trust Organization `auth_domain` 与
固定 Browser Access App `aud`，与生产身份基线独立核对并保留必要的
运行时 issuer、Audience、Owner、Origin 绑定。
[生产 Release #42752829111](https://github.com/lirtual/mcp-workers/actions/runs/42752829111)
于 2026-11-10 成功，100% 活跃版本与 Portal 已独立回读。
Repository `ACCESS_TEAM_DOMAIN` 和 Browser Environment
`BROWSER_ACTIVATION_AUDIENCE` 的**旧 GitHub 来源**随后分别获授权删除，
各自回读 HTTP 404；不得把已退役来源重新设置为发布必需项。

#804 发布当时仍采用 Owner-only 15m SSO+OTP，JWT 验证和同 Profile
一次性证明未变。已观察到真实 SSO 登录、Owner 确认 OFF→ON 激活及在线可控的
Edge Endpoint；这些证据不等于新的单次 Proof 消费或 Replay 拒绝物理验收。
Owner 明确接受沿用 #531 既有真实物理测试，将本次未重跑的 Proof/Replay/
跨 Profile 测试记为 **Waived（非 Pass）**，Spec #804 已关闭（[Spec #804 final Owner acceptance](https://github.com/lirtual/mcp-workers/issues/804#issuecomment-6760463590)）。
历史 Weixin Access 应用已单独授权退役并回读不存在（[separately authorized Weixin retirement](https://github.com/lirtual/mcp-workers/issues/804#issuecomment-6760249436)）；
Database Access 仍保护整个数据库域名，需继续保留。

**2026-11-10 后续 Browser 认证变更：** 仅 Browser Activation Access 应用
改为 `lirtual@qq.com` 单一 OTP 登录，并修正旧 Outlook Policy 显示名称；
Access Application/Audience、Owner Allow 邮箱、15m、Worker 运行时绑定及同 Profile
证明不变。现行 Browser Release 门禁要求且仅允许此 OTP IdP，拒绝重引入 SSO。
上述 #804 SSO 实测属于历史证据，不代表本次 OTP-only 切换后的新 E2E。
