# Spec #853 — T4 开发 Secret、Clerk SDK 与最小只读 MCP 工具

2026-11-11。对象仅为 Cloudflare 测试 Worker `spec853-clerk-oauth-lab` + Clerk 开发实例 `mcp-workers-spec853-oauth-lab`，**不包括**现有 Portal 或生产业务 Worker。

## 输入现状

- 用户自行在 Clerk 开发应用创建名为 `test` 的独立 Secret Key，并在该测试 Worker 的 Cloudflare 设置中保存到 **`CLERK_SECRET_KEY` Secret**。
- 通过官方 Cloudflare API **只读回读** `settings.bindings=[{name:"CLERK_SECRET_KEY",type:"secret_text"}]`，确认 2026-11-11T08:56:02Z 新部署 `00531268-1d2c-490b-9bbf-f46ec1c187e5`，原部署 `f1274dee-17b1-49b1-8538-24cca0c1f795`。
- Clerk Secret 只存在 Cloudflare 运行时绑定中。没有读取、传输或记录原值、哈希或值的长度。源码、GitHub 和本地缓存中均不保存真实凭据。

## 非生产实现

- `scripts/spec853-clerk-poc/auth-lab-worker.mjs`：固定开发 Issuer、精确 HTTPS Audience、公开 RFC 9728 元数据、`profile` Scope 指引、拒绝所有未授权 MCP 请求；使用 `@clerk/backend` `createClerkClient({secretKey:env.CLERK_SECRET_KEY,publishableKey:<公开的开发 key>})` 和 `authenticateRequest({acceptsToken:"oauth_token",audience:RESOURCE})`。Clerk SDK 支持 JWT 和 Opaque OAuth Token；当前实例 `oauth_jwt_access_tokens=false`，不能更改此实例格式来掩盖差异。
- 仅 SDK 已验证 OAuth token 及所需 `profile` scope 可进入 stateless JSON-RPC `initialize`、`tools/list`、`tools/call:lab_status`，最后一项只返回不含用户资料或环境变量的固定文本。没有生产工具、upstream URL、D1/KV/DO、用户查找、外部 API、持久化或 Token 回传。无调试日志。
- JWT 额外核对 `iss`（SDK 部分 machine-token 路径不会自动检查指定 `issuer`）；Opaque 令牌由特定 Clerk 开发实例 Secret 的 SDK 在线校验绑定实例来源。网络或校验失败即 401，不做离线兜底。
- **重要未满足项：** 首次测试仅提供公开静态 no-op；尚**未限制 Clerk user ID 到 Owner 白名单**，因此不能将其作为 Owner Access 已验收的生产方案，不能附加任何真实能力。真实 Scope、Audience、Issuer、Client admission、撤销须继续独立验证。
- `scripts/spec853-clerk-poc/build-auth-lab.mjs` 在用户 WSL 隔离缓存中通过固定 `@clerk/backend@3.27.0` 与 `esbuild@0.25.12` 编译，产物不含 Secret，仅由 Cloudflare Secret 绑定注入。部署前校验本地哈希；GitHub PR 只提交源码、测试和文档，不提交大体积产物。
- `auth-lab-worker.test.mjs` 为模拟 SDK 授权状态的协议单元合同（**不能视为真实 Token 验证**）；`auth-lab-worker.workerd.test.mjs` 将 **真实 Clerk SDK bundle** 放入实际本地 workerd，验证无 Token 时拒绝和公开元数据。之前的 `sdk-official.test.mjs` 用合成已签名 JWT 验证真 SDK 的鉴权边界。

## 验收及停机

- 本地共 **40/40 Pass**：T1 安全合同、SDK JWT 合成、真实 workerd、T3 发现、T4 协议以及真实 SDK bundle 的本地 fail-closed 场景。未经真实 Clerk 授权签发的 Token 均不能称为生产 E2E。
- 实际公网部署后必须再次只读回读脚本名、版本、`CLERK_SECRET_KEY` **仅名称/secret_text 类型**、公开 `/mcp` 无 Bearer 与伪造 Bearer 401、PRM 200，且 Clerk Discovery Checker 无新的 MUST 问题。
- 每次上传测试 Worker 时必须保留现有 Secret 绑定；不允许重复生成、读出或替换 Secret 原值。若绑定被丢弃、未知部署或出现高权限绑定，应立即停止测试，优先保留上一版恢复途径。
- **下一真实交互门：** 用户在 ChatGPT 连接此独立实验 URL，完成 OAuth 授权；测试仅 `lab_status`，随后再确认真实 token 的用户/Scope/撤销、自动 Refresh、7 天 Session、长期自动连接。不可把 Clerk 管理 MCP 的已连接状态冒充本自建 Resource E2E。

最后所有测试通过也不授权把该 SDK 实验直接接入现有 Portal。


## T4 公网实施结果（2026-11-11）

- 固定源码 Commit `52a4bc9505e565ec3e51789504dddd40336dd753`，本地 isolating SDK bundle `148350` bytes，SHA-256 `0d2e8a75a100485570e121638e189705e7b5a83e1d1ae01a980db5d12743935c`。40/40 本地测试 Pass（包括官方 SDK、模拟验证逻辑、实际本地 workerd）；该版本 GitHub Required / Application / GitGuardian 门禁 Pass，跳过无关 DB / 五平台候选。
- Wrangler `--strict` 第一次明确**安全终止**：默认 `preview_urls=true` 与测试 Worker 的远端 `preview_urls=false` 冲突，**没有上传**。保留 strict 并为隔离测试 Worker 的本地缓存专属 `wrangler.toml` 显式设置 `preview_urls=false`、`workers_dev=true`、`keep_vars=true`，然后通过同一门禁发布。没有修改全局 Cloudflare 或生产业务发布流水线。
- **唯一更新范围：** 同一个测试 Worker `spec853-clerk-oauth-lab`，最终 Cloudflare Version `c7f2d3dc-fd9a-458a-9d3a-656ed06c94f3` 已在最新 Deployment `1cfdf6e3-f6a6-4661-bdfe-76861cc79cfc` 中承接 **100%** 测试流量。
- **Secret 续存真实回读 Pass：** `settings.bindings` 恰好一个 `{name:"CLERK_SECRET_KEY",type:"secret_text"}`，没有其他绑定。秘密由用户手动配置，助手没有获取原值；`compatibility_date=2026-10-19`，`workers.dev enabled=true`，`preview_urls=false`。
- **公网负面 E2E Pass：** GET `/.well-known/oauth-protected-resource/mcp` 返回所登记资源、Issuer 和 `scopes_supported=["profile"]`，HTTP 200；无 Bearer / 伪造 Bearer POST `/mcp` HTTP 401 且包含 OAuth Challenge；未知 `/health` HTTP 404，均从真实 HTTPS 验收，不是本地模拟。未用真实合法令牌成功调用。
- **Clerk 开发实例正式静态检查：** 对已经注册的实际 MCP Resource 发起 `force_recheck=true` 后读到最终 `state=passed`，包括端点 Challenge、资源描述、Scope、Issuer Discovery、HTTPS、S256 PKCE 公告、CIMD、Audience **全部静态检测 Pass**。DCR 可选且关闭；`runtime-token` / `runtime-flow` 仍为 `Not Checked`，官方 `end_to_end_verified=false`。
- **尚未验收：** ChatGPT 自定义 MCP 真实首次授权、OAuth token 格式/验证成功、Owner ID 限制、已授予 Scope、Refresh/撤销行为和 7 天会话后免重连。**本测试 Worker 的成功工具调用目前未证明**；不要把本次“接入 Secret + 假令牌拒绝”误写为全部 OAuth 验收成功。
- **下一操作只需要用户的 ChatGPT 交互：** 在 ChatGPT 的 MCP/自定义连接器管理界面添加 `https://spec853-clerk-oauth-lab.aiyaya.workers.dev/mcp` 并按 Clerk OAuth 登录/同意；完成后再观察 SDK 真令牌的 `lab_status` 和刷新状态。不得将该测试资源接到真实业务工具。


## T5 ChatGPT 首次 OAuth 真实调用（2026-11-11）

- **用户侧证据：** 使用 ChatGPT 自定义插件 `Spec853 Clerk OAuth Lab` 完成独立 Clerk 开发应用首次注册与授权，连接器已出现在当前会话的可调用工具清单。前期登录界面遇到 `protect.sign_up.challenged`，后续用户成功连接。此后不再据旧错误截图宣称当前仍无法授权。
- **实测：** ChatGPT 在本次对话内真实调用 `mcp__Spec853_Clerk_OAuth_Lab__lab_status({})`，响应原文精确为 `Spec853 lab: authenticated no-op`。不是本地 curl、合成签名 JWT、Clerk 官方管理 MCP，也不依赖旧 Portal 的认证。
- **运行时来源：** 目前仍然是隔离 Cloudflare Worker Version `c7f2d3dc-fd9a-458a-9d3a-656ed06c94f3`、100% 测试流量。Cloudflare API 只读回读 `CLERK_SECRET_KEY:secret_text` 为唯一绑定、Preview URLs 关闭；Clerk 开发应用回读用户总数由此前 0 变为 **1**，资源保持 registered、`aud_claim_enabled=true`、`oauth_jwt_access_tokens=false`。
- **通过项：** 对这一个无副作用工具，用户首次 Clerk OAuth 连接、ChatGPT 直接调用、Clerk SDK 受保护路由的成功返回 **Pass**。这证明当前实际授权客户端所获令牌可以通过现有实例的 SDK 验证、具备工具要求的 Audience / `profile` Scope；不能仅靠前端“Connected”状态得到同等证据。
- **不能推断的事项：** Cloudflare Worker 仅返回固定文本，不暴露 Token 原值、时效或用户信息。故没有证据证明 Access Token 类型一定是 Opaque（只能说实例配置报告 JWT OAuth access tokens 为 false）；无法证明 Refresh Token 已签发、被 ChatGPT 安全保存、已自动刷新、更换或撤销；也无法证明 7 天/90 天/永久免重连。该次工具调用和短时间的再次调用只能证明既有登录态可用，不能算自动 Refresh E2E。
- **安全限定：** 此独立测试 Worker 的单一 `lab_status` 仍没有 Owner user ID 白名单。虽然 Clerk 开发应用回读当前只有一位注册用户，但如果以后新增用户，当前路由存在多用户访问固定测试文本的可能。**不得接入任何真实 MCP 上游、凭据管理、User/Org 数据或生产工作流**。Owner user ID 及 client ID 的具体核对应在使用真实能力前实现并单独验收，避免把用户标识写入公开源码。现阶段保持运行版本不变，以免打断新建的真实 OAuth 会话，便于跨令牌生命周期测试。
- **剩余真正关键门：** 在不主动重新登录、不断开测试插件、不改短生命周期为假阳性的前提下，于 Access Token 到期以后再直接调用同一 `lab_status`；配合 Clerk 管理端合法可见的 Grant/RT 元数据或事件，在不记录 Token/Secret 的前提下核实是否发生真正 Refresh。随后验证撤销与长期空闲会话边界。刷新失效或主动手工重新认证应标记 Fail，而非当作自动续期成功。
- **部署状态：** T5 只读核对并记录验收证据；**没有新发布、Secret 读取/轮换、用户修改、Clerk 安全策略修改、ChatGPT 插件重连、主业务 Worker 修改或生产发布**。Spec 保持 Open，Draft PR #859 不合并到 main。
