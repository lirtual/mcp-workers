# Spec #853 — T3 独立公开 OAuth 发现测试 Worker

状态：**非生产代码及本地运行时验收通过；公网部署与真实 Clerk Resource 注册以独立回读为准**。

## 范围

- 专属 Cloudflare Worker：`spec853-clerk-oauth-lab`，公开 `https://spec853-clerk-oauth-lab.aiyaya.workers.dev/mcp`。Clerk 仅使用已有 **`mcp-workers-spec853-oauth-lab` 开发实例**，不使用 Production 实例。
- Worker 只有无凭据的静态 RFC 9728 元数据以及拒绝所有 MCP 请求的 `401 WWW-Authenticate`。未实现 Token 校验、MCP initialize/tools/list、真实上游转发，不是完整可用 MCP Server；不得声称 ChatGPT E2E Pass。
- 独立账户 `workers.dev` URL，不新增 DNS、Cloudflare Route/Access App、D1、KV、DO、日志服务、API Secrets、任意付费资源；不修改现有 Portal 及任何业务 Worker。
- 源码：`scripts/spec853-clerk-poc/discovery-worker.mjs`，单个 ES module、零绑定，Cloudflare compatibility date `2026-10-19`，独立部署。请求路径只允许 `GET /.well-known/oauth-protected-resource/mcp` 和根路径别名返回公开资源描述；`/mcp` 一律 401；其它 404。
- 固定 Issuer `https://warm-tadpole-1093.clerk.accounts.dev`、固定 Audience `https://spec853-clerk-oauth-lab.aiyaya.workers.dev/mcp`，匹配已核实的 Clerk 开发实例。
- 本地 Node.js 和真实本地 Miniflare/workerd 测试见 `discovery-worker.test.mjs`、`discovery-worker.workerd.test.mjs`。不能用 Node-only Pass 冒充 workerd Pass。

## 发布门

1. 只读核实 Cloudflare 账户 workers.dev 子域是 `aiyaya`，且脚本名 `spec853-clerk-oauth-lab` 不存在。核对 `release.yml` 为手工发布且现有八个 Worker 不包含本独立试验 Worker。
2. 本地测试和 GitHub CI 门禁完成；固定 GitHub 分支文件内容，保证实际上传的代码可复现，公开 401 拒绝不带任何可配置权限。
3. 仅在此前获授权的隔离范围内创建、上传并公布该唯一 Worker 的 `workers.dev` URL。**这是测试资源公网发布，必须明确区分于测试与生产业务发布**。绝不修改主仓库 Worker、DNS 或现有 Secret。API 写操作状态 Unknown 时只读回查，不重复盲写。
4. 公网 GET 受保护资源元数据须返回 Resource、Issuer 的确切值；未认证 POST /mcp 必须返回 401 和 `WWW-Authenticate`；携带随机 Bearer 仍必须 401。Worker 当前没有任何工具执行能力。
5. 仅在公网发现确认后，对独立 Clerk 开发应用调用 `configure_mcp_server(dry_run=true)` 预检，然后正式注册这一**真实 URL**。回读 `check_mcp_server`；Checker 若返回成功只代表公开发现，不代表完成 OAuth 授权或 Token E2E。

## 停止条件与恢复

- 若已存在同名 Worker 或已绑定生产 Route/Secret、未知部署版本、返回与预期不符，停止覆盖、调查差异。
- 当前 Worker 即便拥有公开访问也只能返回公开元数据 / 401，不暴露用户数据。如果发现异常，优先关闭**该脚本独有** `workers.dev` 子域（只针对 `spec853-clerk-oauth-lab`），不修改其它 Worker；永久删除和 Clerk Resource 解绑需另获破坏性操作授权。
- 未来要让 ChatGPT 完整连接并执行工具，须在此独立 Worker 中通过 Clerk SDK 验证真实 Access Token（类型 / 受众 / Issuer / Owner / Scope）并实施一个无副作用假工具；若 Clerk Token 是 Opaque，必须评估安全的验证凭据取得路径、撤销及授权边界，不能盲目信任 Bearer。
- 即使授权成功、短期 RT Refresh 成功，7 天会话与长期开关的行为仍是独立验收门，不能写作“永不需要重连”。
