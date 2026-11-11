# Spec #853 — Clerk 非生产协议与最小权限 PoC 验收

日期：2026-11-11。基线：`docs/mcp-portal-auth-grill-20261111` 的 `b91ff3d`（Portal-first P0 审查）。仅为**非生产、模拟证据**，没有接入真实 Clerk/ChatGPT/Cloudflare 生产服务。

## 验证对象、环境、证据

- 非生产工作分支：`docs/spec853-clerk-nonprod-validation-20261111`，来源为最新设计分支；主仓库及各生产 Worker 的运行代码**未修改**。
- 合同探针：`scripts/spec853-clerk-poc/probe.mjs`。纯 Web API 实现、**仅供测试，禁止复用为生产鉴权**。所有 Issuer/Resource 使用 `.invalid`，所有 RSA 密钥只在测试进程内随机创建，没有 Clerk 密钥、用户数据、上游凭据、Service Token 或网络访问。
- 单元合同：`node --test scripts/spec853-clerk-poc/probe.test.mjs`（Node.js 22.21.0，本次 22/22 Pass）。
- **真实 Cloudflare workerd 本地隔离运行时**：Miniflare `5.20261012.0-beta` / workerd `1.20261012.1`，Node.js `v24.22.2`，compatibilityDate `2026-10-19`（该 workerd 二进制支持的最新日期），`workerd.test.mjs` 1/1 Pass，包含十余次本地请求断言。不启动公开监听、不部署，不调用 Clerk API。
- 本次仅有模拟的 `tools/call` JSON-RPC；**没有完整 MCP initialize/tools/list 协商，也没有对真实上游的调用**。真实 Clerk 令牌格式、Client ID、Audience/Scope 和 SDK 需要独立实例验收，不以模拟数据冒充实际契约。

## 可重放的测试与安全边界

| 合同 | 结果 | 说明 |
| --- | --- | --- |
| RFC 9728 风格的每插件 PRM / 401 Challenge | **模拟 Pass** | 独立 Sentry、Workflow HTTPS Resource，正确发布 `authorization_servers`、精确资源和 Scope |
| RS256 签名验证 | **模拟 Pass** | 仅信任预设 JWKS/kid/alg；伪造签名、`alg=none`、未知 kid 和错误 Issuer 拒绝 |
| Owner / Audience / Scope | **模拟 Pass** | Owner 只接受受控 `sub`；错误受众、跨插件 Token、缺失 Scope、有效签名但工具未授权均拒绝 |
| 过期和时钟 | **模拟 Pass** | `exp`、`nbf`、`iat` 异常拒绝 |
| Legacy Bearer/管理员权限 | **模拟 Pass** | 旧 `MCP_ACCESS_TOKEN` 不是 Clerk OAuth Token，不能冒充；业务假工具只接收已核验 principal、resourceId 和工具名，原始 Bearer 不向下传 |
| Opaque Token 安全行为 | **模拟 Pass** | 模拟 provider 拒绝/撤销、网络中断均 fail-closed；不证明 Clerk Hobby 真实 Opaque 接口、额度、即时撤销回执或真实令牌生命周期 |
| Cloudflare workerd WebCrypto/Request/Response | **本地实际运行时 Pass** | Worker 隔离环境中签名校验、OAuth 元数据、401/403/200、跨服务拒绝均通过。不是 Cloudflare 生产构建、部署、Access Policy E2E |

最简本地复跑：

```bash
node --test scripts/spec853-clerk-poc/probe.test.mjs
# 可选：安装/复用 Miniflare v5 并设置其 ESM 入口绝对 file: URL
SPEC853_MINIFLARE_ENTRY=file:///absolute/path/to/miniflare/dist/src/index.js \
  node --test scripts/spec853-clerk-poc/workerd.test.mjs
```

如果未设置 `SPEC853_MINIFLARE_ENTRY`，第二个测试报告为 **Skip**，不能写作 Pass。本地实际运行时来自同设备已经存在的工具依赖，未下载新依赖。

## 关键技术核实（官方契约，不是实测）

1. Clerk [OAuth 文档](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth)：OAuth Access Token 默认一天、Refresh Token 不自动过期、公开 CIMD / PKCE / Discovery；JWT 默认不可即时撤销，Opaque 可在线验证/撤销。
2. Clerk [MCP Server 接入教程](https://clerk.com/docs/expressjs/guides/ai/mcp/build-mcp-server)：可在 Clerk 注册**精确 MCP Resource URL**启用 `aud`，服务端用 SDK 的 `authenticateRequest()` 校验 OAuth Token 及 Audience。单个 Clerk App 可管理多个 MCP Resource；但需真实配置及确认每个独立插件的 Scope。
3. Clerk [CIMD Client 管理](https://clerk.com/docs/guides/configure/auth-strategies/oauth/client-id-metadata-documents)：仅允许预注册的 ChatGPT CIMD Client、S256 PKCE、精确回调及最小默认 Scope，`offline_access` 可自动包含；不要默认开放匿名 DCR。
4. [OpenAI 插件 OAuth 契约](https://developers.openai.com/plugins/build/auth)：ChatGPT 需受保护资源发现、Issuer、`resource` 透传、CIMD 客户端及 S256；真实客户端是否签发、保存、滚动刷新 RT 仍需 E2E。
5. [Clerk Pricing](https://clerk.com/pricing)：Hobby 标价 $0、不用信用卡、50,000 MRU/应用、浏览器 Session 固定 7 天、日志保留一天；Hobby 还**不包含 MFA**（与既有 Access 的身份保证须比较）。账号级正式生产能力/用量限制、7 天浏览器 Session 对 RT 的独立性尚未在真实实例验证。
6. Clerk [OAuth Token verification](https://clerk.com/docs/guides/configure/auth-strategies/oauth/verify-oauth-tokens) 与 [Backend-only SDK](https://clerk.com/docs/guides/development/sdk-development/backend-only)：官方 `@clerk/backend` 可运行于 Cloudflare Workers/V8 isolate，支持 JWT 与 Opaque 校验；**优先真实 SDK，而不是将此 PoC 手写 verifier 上生产**。

## 设计结论与阻断

**优先复用现有自有 MCP Worker + 一个共享 OAuth 验证模块，不增加每插件 OAuth 服务；旧 Portal 暂不变。** 该共享模块必须在入口把 Clerk OAuth Token 与旧管理员 `MCP_ACCESS_TOKEN` 的信任路径清晰隔离，不能因验证通过就跨插件调用 Portal 11 个 `on_behalf=false` 上游。原有 Access Owner Policy 与 Service Auth 不能静默弱化。无法修改的第三方 Sentry **不具备本次验证过的受限后端接线**：必须单独证明使用固定独立后端、限权上游凭据且不汇聚 Portal 管理权限，才允许一个轻适配 Worker。

| 验收层 | 状态 |
| --- | --- |
| 设计、现状只读、官方协议核实 | **Verified**（仅对应已引用契约） |
| 非生产 JWT / Opaque / Scope / Owner 等合成合同 | **Pass（模拟）**：22 项 |
| Cloudflare workerd 本地运行时合同 | **Pass（本地）**：1 个集成测试，十余断言 |
| 真实 Clerk Hobby Production OAuth / 费用 / Opaque 配置 | **Unknown / 未执行** |
| 真实 Clerk OAuth RT 签发、浏览器 Session 7 天后静默刷新 | **Unknown / 未执行** |
| ChatGPT 真实 Refresh E2E / Tool call | **Unknown / 未执行** |
| Sentry 最小权限适配与 Cloudflare Access 等价边界 | **Blocked（尚缺真实上游接线证明）** |
| Cloudflare/Clerk/ChatGPT 生产配置或插件变更 | **Not performed** |
| GitHub CI（分支 PR 才触发） | **待独立读取** |

**硬停止：** 在真正符合 $0、Scope/Owner、撤销与无跨插件提权条件前不得申请生产切换。真实 Clerk/Sentry/ChatGPT 授权、生产 API Secret、部署、DNS、Cloudflare Policy 和插件重连必须重新按对象获得明确授权。也不得将“Refresh Token 不自动过期”宣称为“永远不会重新登录”。

本 PoC 文件放在独立实验目录，未导出至生产包、未修改 Wrangler 或业务 Worker，便于真实 SDK 验证后决定保留为回归、收敛或直接删除，避免永久维护模拟验证框架。
