# 手动发布 MCP Workers：GitHub Repository 统一配置

> **Spec #849 已完成：** Repository 配置源已切换，GitHub Environments 已退役（本轮只读回读为 0）。历史迁移授权、字节一致性证据与清理记录见 [#849](https://github.com/lirtual/mcp-workers/issues/849)。以下以现行 Repository 来源为准，不重新执行历史迁移。

本项目每个 Worker 只有一个既有 Cloudflare 生产实例，没有 staging/production 多运行环境。GitHub Actions 的 `Release Worker` 仅在受控手动派发、`main`、Owner 和现有预检通过后选择一个 Worker；普通 `main` Push 只运行 CI，不自动部署。

## 一、单一 GitHub Repository 配置源

在 [GitHub Actions Secrets and variables](https://github.com/lirtual/mcp-workers/settings/secrets/actions) 按现有名称和类型管理：

| 类型 | 名称 |
| --- | --- |
| Repository Variable | `CLOUDFLARE_ACCOUNT_ID`、`DATABASE_CONNECTIONS`、`OWNER_EMAIL`、`WORKFLOW_GITHUB_ACTION_REPOSITORY`、`IMA_CLIENT_ID`、`WORKFLOW_MCP_PORTAL_CLIENT_ID` |
| Repository Secret | `CLOUDFLARE_API_TOKEN`、`DATABASE_B2B_PASSWORD`、`DATABASE_SCRAPE_RELAY_PASSWORD`、`MCP_ACCESS_TOKEN`、`ACTIONS_GITHUB_DISPATCH_TOKENS`、`IMA_API_KEY`、`RAINDROP_ACCESS_TOKEN`、`SSH_ENCRYPTION_KEY`、`WORKFLOW_GITHUB_DISPATCH_TOKEN`、`WORKFLOW_MCP_PORTAL_CLIENT_SECRET` |

当前有效配置由源码白名单及各 Worker 契约确定；#849 初始迁移清单不能作为后续配置数量上限。GitHub Environments 为 0。两个 Client ID 是非秘密输入；原值迁移证据保留在 #849，不得擅自轮换或替换现有凭据。

`DATABASE_CONNECTIONS` 是现行 Database 连接清单；引用的密码依旧是独立 GitHub Repository Secrets，Hyperdrive 在 Cloudflare 原生管理，不能恢复旧 D1 Setup 方案。`OWNER_EMAIL` 为 Browser 唯一人工维护的 Owner 邮箱来源，Issuer/Audience/Origin 按现有 Cloudflare/发布脚本派生。`WORKFLOW_GITHUB_ACTION_REPOSITORY` 指向受控目标仓库，旧批准列表不再是配置源。

## Worker 配置映射

| Worker | Repository Secret（另加共享 `MCP_ACCESS_TOKEN`） | Repository Variable |
| --- | --- | --- |
| `database-mcp-worker` | `DATABASE_B2B_PASSWORD`、`DATABASE_SCRAPE_RELAY_PASSWORD` | `DATABASE_CONNECTIONS` |
| `browser-mcp-worker` | 无额外 Secret | `OWNER_EMAIL` |
| `ima-mcp-worker` | `IMA_API_KEY` | `IMA_CLIENT_ID` |
| `raindrop-mcp-worker` | `RAINDROP_ACCESS_TOKEN` | 无必填 |
| `ssh-mcp-worker` | `SSH_ENCRYPTION_KEY` | 无 |
| `remote-control-mcp-worker` | 无额外 Secret | 复用 `CLERK_PILOT_PUBLISHABLE_KEY`、`CLERK_PILOT_OWNER_USER_ID`、`CLERK_PILOT_ISSUER`；可选 `RCA_PERMANENT_IDLE_DAYS` |
| `github-actions-mcp-worker` | `ACTIONS_GITHUB_DISPATCH_TOKENS` | 无 |
| `workflow-mcp-worker` | `WORKFLOW_MCP_PORTAL_CLIENT_SECRET`、`WORKFLOW_GITHUB_DISPATCH_TOKEN` | `WORKFLOW_MCP_PORTAL_CLIENT_ID`、`WORKFLOW_GITHUB_ACTION_REPOSITORY` |
| `mcp-gateway-worker` | `CLERK_SECRET_KEY`、`MCP_GATEWAY_PORTAL_CLIENT_SECRET`（不使用共享 `MCP_ACCESS_TOKEN`） | `MCP_GATEWAY_PORTAL_CLIENT_ID`；Gateway 身份仍读取历史命名的 `CLERK_PILOT_*` GitHub Variables（不是 Raindrop 试点运行时绑定） |

## 二、配置维护边界

#849 一次性迁移和 Environment 清理已完成，不再保留专用迁移入口或长期清理流程。修改当前配置、密钥、Cloudflare 资源或生产部署仍须分别授权，按真实引用和回读核验结果。旧迁移历史在原 Issue 与 Git 中保留。

Repository Secrets 对仓库内符合条件的工作流开放，不能再视为按 Worker 的 GitHub 权限隔离。Owner 已接受 Repository 暴露范围扩大、Agent Release 人工审批退役、`main` 无平台分支保护等风险；现有代码门禁不等价于 GitHub 平台审批。

## 三、按选中 Worker 发布（迁移后）

打开 [Release Worker](https://github.com/lirtual/mcp-workers/actions/workflows/release.yml)，固定 `main`，选择一个 `worker`；生产发布需显式授权并设置 `deploy_to_production=true`。当前工作流持续执行 Owner/main/SHA/CI/互斥与 Worker 范围检查，先行校验必需配置，再只针对所选 Worker 上传其运行时 Secret / Variable。

- 原有八个业务 Worker 使用共享 `MCP_ACCESS_TOKEN`；`CLOUDFLARE_API_TOKEN` 仅供必要的受控发布步骤使用。
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

### Spec #878 Gateway 受控手动发布

`mcp-gateway-worker` 只能在 `main` 上由 Owner 手动使用 `Release Worker` 发布。仓库级 Secret `MCP_GATEWAY_PORTAL_CLIENT_SECRET` 在暂存时映射为运行时 `CF_ACCESS_CLIENT_SECRET`；Client ID 和现有 Clerk Resource 身份来自仓库级 Variables，运行时 `GATEWAY_ORIGIN` 从当前唯一 Wrangler Custom Domain（`mcp.lirtual.dpdns.org`） 派生。Gateway 与 Workflow 使用各自独立的 Service Token Client ID/Secret，Access 侧共用包含两枚 Token Include 规则的 `MCP Gateway Service Auth` 可复用 Policy；不复用机器凭据。发布代码不能代替对特定 Portal 上游、Access Policy 和 Clerk Resource 的逐项授权及 E2E 验收；生产变更仍须另行授权并按实际回读确认。
