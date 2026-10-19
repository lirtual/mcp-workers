# MCP Worker 手动发布约束

本项目使用唯一的 `main` 分支和唯一一套 Cloudflare Worker，不维护 production/staging 环境切换。GitHub **Environments 只用于每个 Worker 的 Secrets / Variables 配置隔离**。

详细配置与迁移说明：[MANUAL-WORKER-BOOTSTRAP.md](./MANUAL-WORKER-BOOTSTRAP.md)。

## 发布准入

- 仅由 GitHub Actions → CI → `workflow_dispatch` 在当前 `main` 触发；PR 和 push CI 只运行检查，不执行发布。
- 只能选择一个明确白名单 Worker。数据库必须通过真正的 PostgreSQL/MySQL 集成检查；其他 Worker 不得被数据库集成步骤错误阻挡。
- 每个 Worker 使用与脚本同名的 GitHub Environment，例如 `ima-mcp-worker`。必须存在同名 `WORKER_CONFIG_SCOPE` Environment Variable；缺失即停止，防止 GitHub 静默建立空环境后执行发布。
- Repository Secrets 放 `CLOUDFLARE_API_TOKEN`、默认的 `MCP_ACCESS_TOKEN`；Repository Variable 放 `CLOUDFLARE_ACCOUNT_ID`。Worker 自己的 Environment 保存其余敏感字段。对应同名 Environment Secret 可覆盖全局 Portal Token。
- 用户需自行将旧 `production` Environment 的已保存密钥与保护规则迁移。**在迁移成功前不要运行新的手动发布，也不要删除旧 Environment**。所有敏感值不得出现在代码/日志/PR 中。
- 发布前检查当前 `main` SHA，校验 Cloudflare 状态及 Worker 是否存在；仅允许 Raindrop/IMA/Database/SSH 走首次部署。Remote Control 必须保持 existing-Worker-only。
- 首次部署时只注入该 Worker 需要的指定 Secret；正常发布不重传或轮换已有 Worker Secret。可选 GitHub Variables 通过严格白名单校验，并仅影响被选 Worker。

## 发布后核对

- Wrangler 返回的确切 Version ID 与 Cloudflare 100% 活跃 Version ID 必须一致；更新时还需验证是新部署。
- 验证该 Worker 必需的 Secret 名称、Durable Objects、限流、Service Binding、观测配置及源码兼容标识。不打印原始 Wrangler 失败日志或敏感内容。
- 对 IMA、Raindrop 等已有健康检查接口复核响应；未经授权请求必须被拒绝（HTTP 401/403），然后再由用户在原 MCP Portal 完成受认证的 `initialize`、`tools/list` 和安全只读操作。
- 发布失败不得自动重置 Durable Objects、重放不确定的远程操作、批量发布其他 Worker 或修改原 `edgessh`。
- SSH 使用 `EDGE_SSH_BROKER` 私有 Service Binding 和自己的 `SSH_OPERATIONS` Durable Object；不复制 `ENCRYPTION_KEY` 或生产 D1。默认范围受限，只有独立授权后才能扩大。
- Remote Control 严格维持独立 SQLite `DeviceCoordinator`（不能复用 Preview DO、不能使用 VPC 和 v1/v2 运行模式开关）；不将既有的配对、身份或回执验收默认为新环境测试。

正常版本回退需重新审核代码并人工发布，不要在不确定性操作发生后盲目重试或擦除状态。全局 `MCP_ACCESS_TOKEN` 是首次部署时使用的默认值；已经部署的 Worker 不会因为 GitHub 中修改全局 Secret 而自动轮换运行时 Token。若多个 Worker 共用同一 Token，泄露影响面相应扩大，需要独立的轮换流程。
