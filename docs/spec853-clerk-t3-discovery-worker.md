# Spec #853 — T3 独立公开 OAuth 发现测试 Worker

状态：**T3 公网发布与 Clerk 开发资源注册已完成；仅公开发现协议已通过，真实 Token/Refresh E2E 尚未执行**。

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

## T3 实际发布、只读回读与验收（2026-11-11）

- **部署前身份与范围：** Cloudflare Account `8bb496011403552e785ea1b834daffdf`，workers.dev 子域 `aiyaya`；Worker 列表 14 个且目标名称零碰撞。已有 `release.yml` 为手工发布流程且未包含此实验 Worker；独立代码已经在 GitHub Draft PR #859 的 `7c6b2828a8795fbae5ef993bbb596866056121ba` 经过 5/5 本地合同及真实 workerd 测试。该 SHA 的 GitHub Application、GitGuardian、Required gate **Pass**，数据库/五平台候选 **Skipped**。
- **唯一写入范围：** 仅创建 `spec853-clerk-oauth-lab` Worker（Cloudflare API PUT 的源码经 GitHub 回读，blob SHA `541561f08ad0b1187685079b8ff101da1e04a8fa`），以 `2026-10-19` compatibility date、0 bindings 上传。随后仅对该脚本启用 `workers.dev`，同时关闭 Preview URLs；未绑定真实域名、DNS、Access 或生产服务。发布后只读回读最新版本 ID `5ae89ebf-5b25-46e4-8497-842ab4a900cb`、Deployment ID `f1274dee-17b1-49b1-8538-24cca0c1f795`、`enabled=true`、`previews_enabled=false`、0 bindings。
- **公网真实网络验证 Pass：** `GET https://spec853-clerk-oauth-lab.aiyaya.workers.dev/.well-known/oauth-protected-resource/mcp` 得 HTTP 200，JSON `resource` 与 `authorization_servers` 精确匹配；POST `/mcp` 无授权得 HTTP 401 和精确 `WWW-Authenticate: Bearer resource_metadata=...`；POST 携带伪造 Bearer 仍 HTTP 401，均无执行工具、无数据写入。HTTPS/响应结果在 WSL Agent 上独立 curl 校验，不等于 ChatGPT 首次授权 E2E。
- **Clerk 配置预检：** 隔离开发应用 `app_3Lx1IDoBxGgYY0veK8Qskm58E7c`，实例 `ins_3Lx1I9V00eUZEIvYFV9TI7PHL0O`，对**真实**资源 URL 执行 `configure_mcp_server(dry_run=true)`，无 blockers；随后 `dry_run=false` 仅新增这一开发资源 `oares_3LxAxtPMW3vTxZDV9xOwQ2XoEaJ`，自动启用 `aud_claim_enabled=true` 和 `client_id_metadata_documents_advertised=true`，保持 `pkce_required=true`、`dynamic_oauth_client_registration=false`。未影响 `LobeChat` 或生产实例。
- **Clerk 独立检查：** `check_mcp_server` 只读回读注册状态 `configured`，公开 Checker `chk_9086db6bf4c679ebf02c98c879d41c85538eecb8abb343c469e60df763debf0b_b1a9632f47824d9f93e20a8232ca1fe3` 的最终 `state=warning`：端点 401 挑战、精确 PRM 资源/Issuer、Clerk OAuth 元数据、HTTPS、S256 PKCE 公告、CIMD 宣告与 Audience 设置均 **Passed（静态发现）**；`scope` 指引仅为 **SHOULD Warning**（无真实工具及已生效 Scope）；`runtime-token` 和 `runtime-flow` 明确 **Not Checked**。`end_to_end_verified=false`，不得写成全绿。
- **令牌格式事实门：** 当前开发实例报告 `oauth_jwt_access_tokens=false`，需要确认真实 OAuth Token 为 Opaque，才能确定是否可在无真实 Secret 的条件下验证。不能仅因 Clerk 公开文档称新应用默认 JWT 就忽略本实例的实际设置。任何真实验证都必须使用 Clerk 官方 SDK、固定 Owner/Audience/Issuer/Scope；测试专用 Worker 当前**有意拒绝所有令牌**。
- **回退边界：** 本轮不执行破坏性清理。若后续停止测试，先仅关闭这一 Worker 的 workers.dev 子域并回读；移除 Clerk 资源/销毁 Worker 需另行授权。公网测试资源可持续访问，但没有认证通过的工具或任何机密信息。

**T3 裁定：** Cloudflare 隔离 Worker 创建与公网响应 **Pass**；Clerk 开发资源注册 **Pass**；Clerk 静态发现 **Passed with SHOULD Warning**；实际 OAuth Token 签发/验证、ChatGPT 连接、Refresh、撤销、长期免重连 **Unknown / 尚未执行**。下一步应先确定开发实例 JWT/Opaque 真实格式和可安全获得的验证手段，然后加一个受控的、无副作用工具，再尝试首次 ChatGPT OAuth 与刷新 E2E。
