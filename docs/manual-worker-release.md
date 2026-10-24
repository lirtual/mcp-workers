# MCP Worker 手动发布约束

本项目使用唯一的 `main` 分支和唯一一套 Cloudflare Worker，不维护 production/staging 环境切换。GitHub **Environments 只用于每个 Worker 的 Secrets / Variables 配置隔离**。

详细配置与迁移说明：[MANUAL-WORKER-BOOTSTRAP.md](./MANUAL-WORKER-BOOTSTRAP.md)。

## 发布准入

- 仅由 GitHub Actions → Release Worker → `workflow_dispatch` 在当前 `main` 触发；PR 和 push CI 只运行检查，不执行发布。
- 只能选择一个明确白名单 Worker。数据库必须通过真正的 PostgreSQL/MySQL 集成检查；其他 Worker 不得被数据库集成步骤错误阻挡。
- 每个 Worker 使用与脚本同名的 GitHub Environment，例如 `ima-mcp-worker`。Actions 自动选择该名称，无须维护 `WORKER_CONFIG_SCOPE`。GitHub 可能自动建立尚不存在的空 Environment，应事先配置 Worker 专属 Secrets、审批与分支保护；每次手动部署缺少必需密钥都必须在上传前失败。
- Repository Secrets 放 `CLOUDFLARE_API_TOKEN`、默认的 `MCP_ACCESS_TOKEN`；Repository Variable 放 `CLOUDFLARE_ACCOUNT_ID`。Worker 自己的 Environment 保存其余敏感字段。对应同名 Environment Secret 可覆盖全局 Portal Token。
- 用户需自行将旧 `production` Environment 的已保存密钥与保护规则迁移。**在迁移成功前不要运行新的手动发布，也不要删除旧 Environment**。所有敏感值不得出现在代码/日志/PR 中。
- 发布前检查当前 `main` SHA，校验 Cloudflare 状态及 Worker 是否存在；仅允许 Raindrop/IMA/Database/SSH 走首次部署。Remote Control 必须保持 existing-Worker-only。
- 首次部署及后续每次手动发布，均通过 `wrangler deploy --secrets-file` 同步被选 Worker 的全部必需 GitHub Secrets；缺失或空值则拒绝发布，不再静默沿用现网旧值。其他 Worker、`edgessh` 不受该次发布影响。
- 受管 Worker 使用 `keep_vars: false`；运行时普通 Variables 仅来自 Wrangler 配置默认值及被选 GitHub Environment 白名单覆盖，不再保留 Dashboard 临时配置。密钥永远使用 Secret，不以 Variable 传递。

## 手动入口

- `CI`：Push / PR 自动检查，不接受手动发布参数；`Release Worker`：选择 Worker 并明确勾选 `deploy_to_production`，在 `main` 上复用 CI 检查后发布。
- `Workflow Acceptance`：手动选择唯一的 `test_type`。`portal-readonly` 只读检查正式 Portal；`production-*` 会创建并清理随机测试记录，其中 GitHub 类型还会触发真实 GitHub Job；`github-action-result-cloud` 使用隔离 D1；`portal-register` **会修改正式 Portal 配置**，与 Worker 部署相互独立，需单独选择。
- `GitHub Workflow Check Executor`：仅接受 Workflow MCP 生成的任务标识，不是人工发布入口。

## 发布后核对

- Wrangler 返回的确切 Version ID 与 Cloudflare 100% 活跃 Version ID 必须一致；更新时还需验证是新部署。
- 验证该 Worker 必需的 Secret 名称、Durable Objects、限流、Service Binding、观测配置及源码兼容标识。不打印原始 Wrangler 失败日志或敏感内容。
- 对 IMA、Raindrop 等已有健康检查接口复核响应；未经授权请求必须被拒绝（HTTP 401/403），然后再由用户在原 MCP Portal 完成受认证的 `initialize`、`tools/list` 和安全只读操作。
- 发布失败不得自动重置 Durable Objects、重放不确定的远程操作、批量发布其他 Worker 或修改原 `edgessh`。
- SSH 使用 `EDGE_SSH_BROKER` 私有 Service Binding 和自己的 `SSH_OPERATIONS` Durable Object；不复制 `ENCRYPTION_KEY` 或生产 D1。默认范围受限，只有独立授权后才能扩大。
- Remote Control 严格维持独立 SQLite `DeviceCoordinator`（不能复用 Preview DO、不能使用 VPC 和 v1/v2 运行模式开关）；不将既有的配对、身份或回执验收默认为新环境测试。

正常版本回退需重新审核代码并人工发布，不要在不确定性操作发生后盲目重试或擦除状态。`MCP_ACCESS_TOKEN` 来自 Repository Secret（允许每个 Environment 同名覆盖），并在被选 Worker 每次手动发布时同步。修改 Repository Secret 不会自动部署全部 Worker；需要协调逐个手动发布与 Portal 客户端凭据切换，尤其共享 Token 和 SSH 的 `MCP_BROKER_TOKEN`（EdgeSSH 侧需独立同步）。发布前确认 GitHub 中的 IMA 等凭据已与现网有效值一致，否则会覆盖现有生效 Secret。IMA 的 `CLIENT_ID` 改由该 Worker 的必填 GitHub Environment Variable 提供，`API_KEY` 仍保密。Cloudflare 现网旧 `CLIENT_ID` Secret 不会仅因为 PR 合并而删除，首次手动发布必须通过 readback 验证其类型已切换为 `plain_text`，失败不能当作迁移完成；请参考部署指南的一次性迁移步骤。
