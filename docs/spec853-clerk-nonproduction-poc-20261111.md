# Spec #853 — Clerk 非生产协议与最小权限 PoC 验收

日期：2026-11-11。基线：`docs/mcp-portal-auth-grill-20261111` 的 `b91ff3d`（Portal-first P0 审查）。仅为**非生产、模拟证据**，没有接入真实 Clerk/ChatGPT/Cloudflare 生产服务。

## 验证对象、环境、证据

- 非生产工作分支：`docs/spec853-clerk-nonprod-validation-20261111`，来源为最新设计分支；主仓库及各生产 Worker 的运行代码**未修改**。
- 合同探针：`scripts/spec853-clerk-poc/probe.mjs`。纯 Web API 实现、**仅供测试，禁止复用为生产鉴权**。所有 Issuer/Resource 使用 `.invalid`，所有 RSA 密钥只在测试进程内随机创建，没有 Clerk 密钥、用户数据、上游凭据、Service Token 或网络访问。
- 单元合同：`node --test scripts/spec853-clerk-poc/probe.test.mjs`（Node.js 22.21.0，本次 25/25 Pass）。
- **真实 Cloudflare workerd 本地隔离运行时**：Miniflare `5.20261012.0-beta` / workerd `1.20261012.1`，Node.js `v24.22.2`，compatibilityDate `2026-10-19`（该 workerd 二进制支持的最新日期），`workerd.test.mjs` 1/1 Pass，包含十余次本地请求断言。不启动公开监听、不部署，不调用 Clerk API。
- 本次仅有模拟的 `tools/call` JSON-RPC；**没有完整 MCP initialize/tools/list 协商，也没有对真实上游的调用**。真实 Clerk 令牌格式、Client ID、Audience/Scope **仍需独立实例验收**；官方 SDK 的离线合成令牌路径已在本轮另行测试，不将合成令牌冒充实际发行。

## 可重放的测试与安全边界

| 合同 | 结果 | 说明 |
| --- | --- | --- |
| RFC 9728 风格的每插件 PRM / 401 Challenge | **模拟 Pass** | 独立 Sentry、Workflow HTTPS Resource，正确发布 `authorization_servers`、精确资源和 Scope |
| RS256 签名验证 | **模拟 Pass** | 仅信任预设 JWKS/kid/alg；伪造签名、`alg=none`、未知 kid 和错误 Issuer 拒绝 |
| Owner / Audience / Scope | **模拟 Pass** | Owner 只接受受控 `sub`；错误受众、含多个资源的 Audience、跨插件 Token、缺失 Scope、有效签名但工具未授权均拒绝 |
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

**优先复用现有自有 MCP Worker + 一个共享 OAuth 验证模块，不增加每插件 OAuth 服务；旧 Portal 暂不变。** 该共享模块正式实现时必须使用 Clerk SDK `authenticateRequest({ acceptsToken: "oauth_token", audience: MCP_RESOURCE_URL })`，拒绝会话/M2M/API Key token 类型，且在入口把 Clerk OAuth Token 与旧管理员 `MCP_ACCESS_TOKEN` 的信任路径清晰隔离，不能因验证通过就跨插件调用 Portal 11 个 `on_behalf=false` 上游。原有 Access Owner Policy 与 Service Auth 不能静默弱化。无法修改的第三方 Sentry **不具备本次验证过的受限后端接线**：必须单独证明使用固定独立后端、限权上游凭据且不汇聚 Portal 管理权限，才允许一个轻适配 Worker。

| 验收层 | 状态 |
| --- | --- |
| 设计、现状只读、官方协议核实 | **Verified**（仅对应已引用契约） |
| 非生产 JWT / Opaque / Scope / Owner 等合成合同 | **Pass（模拟）**：25 项 |
| Cloudflare workerd 本地运行时合同 | **Pass（本地）**：1 个集成测试，十余断言 |
| Clerk 官方 Backend SDK 3.27.0 / SDK bundle 真实 workerd | **Pass（非生产模拟）**：2 个测试；Issuer 等安全边界在 SDK 之后额外约束；详见下节 |
| 真实 Clerk Hobby Production OAuth / 费用 / Opaque 配置 | **Unknown / 未执行** |
| 真实 Clerk OAuth RT 签发、浏览器 Session 7 天后静默刷新 | **Unknown / 未执行** |
| ChatGPT 真实 Refresh E2E / Tool call | **Unknown / 未执行** |
| Sentry 最小权限适配与 Cloudflare Access 等价边界 | **Blocked（尚缺真实上游接线证明）** |
| Cloudflare/Clerk/ChatGPT 生产配置或插件变更 | **Not performed** |
| GitHub CI（分支 PR 才触发） | **待独立读取** |

**硬停止：** 在真正符合 $0、Scope/Owner、撤销与无跨插件提权条件前不得申请生产切换。真实 Clerk/Sentry/ChatGPT 授权、生产 API Secret、部署、DNS、Cloudflare Policy 和插件重连必须重新按对象获得明确授权。也不得将“Refresh Token 不自动过期”宣称为“永远不会重新登录”。

本 PoC 文件放在独立实验目录，未导出至生产包、未修改 Wrangler 或业务 Worker。官方 SDK 仍仅针对**离线合成令牌**验证；真实开发实例尚未连接，测试框架可在真实验收后收敛或删除。

## T1b：官方 Clerk SDK 离线验证与真实本地 workerd（2026-11-11）

- **依赖隔离：** 通过 npm 仅在本地 `~/.cache/spec853-clerk-sdk` 安装 `@clerk/backend@3.27.0`、`@clerk/mcp-tools@0.9.0`、`esbuild@0.25.12`。不向正式 monorepo 增加依赖、Secrets、Wrangler 配置。实际 SDK 验证使用 `@clerk/backend`，不需要 `@clerk/mcp-tools` 的可选 MCP 桥接函数。
- **源码：** `scripts/spec853-clerk-poc/sdk-official.test.mjs` 和 `sdk-worker-entry.mjs`。所有 JWT、RSA 密钥、虚构 Clerk 域名和 `pk_test_` 均为测试进程内合成数据，资源 URL 位于 `.invalid` 域；`sk_test_synthetic_fixture_only` 不是真实凭据。**测试专用 Worker 含合成密钥插槽，不得部署到生产。**
- **Node.js 24.22.2 官方 SDK：** 使用 `createClerkClient().authenticateRequest({ acceptsToken: "oauth_token", audience: resource, jwtKey })` 对合成 OAuth JWT 做真实 SDK 验证；正确 OAuth Token 通过，错误 Audience、过期令牌及错误 Token Header 类型均拒绝，Scope、Subject 可回读。
- **真实 Cloudflare workerd：** 用 esbuild 的 `conditions=worker,browser` 将真实 `@clerk/backend` 打包成独立隔离 Worker，再用 Miniflare 5.20261012.0-beta / workerd 1.20261012.1 / compatibilityDate 2026-10-19 验证。有效 Token 返回 200，错误 Audience、Scope、Owner、Issuer、过期令牌和非 OAuth 类型均为 401。**SDK 在本地 workerd 可运行；不代表生产部署与真实 SDK 在线 Opaque 校验成功。**
- **重要安全发现：** `@clerk/backend@3.27.0` 的 `VerifyJwtOptions.issuer` 类型说明**机器令牌验证忽略该选项**；合成签名正确但 `iss` 错误的 JWT，在仅配置受信任 `jwtKey`、`audience` 和 `acceptsToken` 时仍可能被 `isAuthenticated=true` 接受。这不是签名绕过：SDK 已验证该测试公钥。测试专用 Worker 因此增加“**SDK 验签通过后，再核对经验证 JWT 的 `iss` 是否等于固定 Issuer**”并回归验证错误 Issuer 拒绝。正式实现须保留此门禁；Opaque Token 的签发实例归属、在线检验和撤销应由真实 Clerk SDK/实例 E2E 单独验收，不能按 JWT 字段处理。
- **汇总：** 25 个先前合成合同 + 1 个先前本地 workerd 集成 + 2 个官方 SDK/真实本地 workerd 测试，共 **28/28 Pass（全部非生产）**。其中官方 SDK Workerd 合同并不覆盖实际客户端 Refresh Token 交换、轮换或 Hobby 计费。

仅需在**独立本地缓存**安装依赖，复跑如下（Miniflare 入口需使用真实已安装路径）：

```bash
mkdir -p "$HOME/.cache/spec853-clerk-sdk"
npm --prefix "$HOME/.cache/spec853-clerk-sdk" install --no-save --no-package-lock --ignore-scripts --no-audit --no-fund @clerk/backend@3.27.0 @clerk/mcp-tools@0.9.0 esbuild@0.25.12
export SPEC853_SDK_CACHE="$HOME/.cache/spec853-clerk-sdk"
export SPEC853_MINIFLARE_ENTRY="file:///absolute/path/to/miniflare/dist/src/index.js"
node --test scripts/spec853-clerk-poc/probe.test.mjs scripts/spec853-clerk-poc/workerd.test.mjs scripts/spec853-clerk-poc/sdk-official.test.mjs
```

**待办的真实证据（全部未执行）：** Clerk 开发实例与 OAuth Resource 注册/Discovery、ChatGPT CIMD 首次授权、真实 `offline_access` RT 签发与多次交换、RT 撤销和 Opaque Token 的真实在线验证、浏览器 Session 7 天到期后自动续期、Hobby 免费/配额及现有 Access Owner 强度等价审查。没有已连接的 Clerk 账户授权、`CLERK_*` 运行时变量或浏览器 Clerk 会话。官方 [Clerk MCP 管理服务](https://clerk.com/docs/guides/ai/mcp/clerk-mcp-server) 可通过 OAuth 登录授权后仅查看开发实例，但**本轮没有连接、注册、修改任何 Clerk Application**。

**交付状态：** Source/Tests/Docs 非生产分支更新；production Code / Config / Secrets / DNS / Clerk Instance / ChatGPT 插件均未变。真实 OAuth E2E = Unknown / Blocked by account connection；CI 另行读取。禁止将 SDK 离线成功冒充 Clerk 真实 Refresh 验收。


## T2：真实 Clerk 工作区连接及隔离开发应用只读/预检（2026-11-11）

- **连接已经验证：** Clerk 官方 MCP `whoami` 可读取当前已授权工作区，OAuth Client 使用 ChatGPT CIMD，范围包含应用读取/管理和 `offline_access`。这只证明**ChatGPT 与 Clerk 官方管理 MCP 的 OAuth 连接成功**，**不证明** ChatGPT 已能使用 Spec #853 自建资源服务器的 Refresh Token。
- **现有应用隔离：** 在已授权非生产范围内创建独立应用 `mcp-workers-spec853-oauth-lab`，应用 ID `app_3Lx1IDoBxGgYY0veK8Qskm58E7c`、开发实例 ID `ins_3Lx1I9V00eUZEIvYFV9TI7PHL0O`，仅 Development，`pk_test_`；保留现有 `LobeChat` 开发实例原样。没有创建 Production 实例或收费订阅。
- **真实开发实例默认配置（read-only）：** `session_settings.maximum_lifetime` 为 604800 秒（7 天）；`pkce_required=true`，`aud_claim_enabled=false`，`client_id_metadata_documents_advertised=false`，`dynamic_oauth_client_registration=false`，`oauth_jwt_access_tokens=false`。因此初始实例 **不能直接用作 MCP OAuth 资源签发**；还需要真实 Resource URL 注册和独立验证令牌格式/在线验证。不要将前述合成 JWT 的成功误写为此实例真实 Access Token 已验证。
- **不写入的模拟预览：** 对 `https://spec853-oauth-lab.example.invalid/mcp` 调用官方 `configure_mcp_server(dry_run=true)` 返回 `preview`，提示注册真实 MCP Resource 时将启用 `aud_claim_enabled` 和 `client_id_metadata_documents_advertised`，保留 PKCE；没有其他配置 blocker。但该 URL 以 `.invalid` 结尾，**不是可连接服务、不得正式注册**。返回的开发 Issuer 为 `https://warm-tadpole-1093.clerk.accounts.dev`，资源 Audience 为 URL 全路径。
- **防止过度授权：** 预览中 `client_id_metadata_documents_only_allow_pre_registered_clients=false` 且 `client_id_metadata_documents_block_implicitly_allowed_clients=false`，**不能默认声称只允许 ChatGPT CIMD**。需要真实实例预检 Client admission 行为，最小范围约束以实际签发与工具端强制校验共同证明。
- **回读确认：** `check_mcp_server` 仍返回 `not_configured`、`mcp_servers=[]`、`aud_claim_enabled=false`、`client_id_metadata_documents_advertised=false`；两个应用都只有 Development 环境。故本次没有正式注册虚构资源、没有改动现有应用或业务 Endpoint。
- **下一阶段真实 OAuth 阻断：** 尚缺可供 ChatGPT 与 Clerk Discovery 访问的独立 **HTTPS 非生产 MCP Resource**。若发布此资源需要创建 Cloudflare Worker/公开路由、DNS、Secret、绑定、访问策略或实际成本，应先按具体对象获得授权；本轮不通过覆盖 `mcp.lirtual.dpdns.org` 或接入 Portal 11 个高权限上游来代替。拿到真实资源后才可在此隔离 Clerk 开发实例注册 MCP Resource、验证 CIMD/PKCE 和 Scope、获取真实 RT 并测试刷新/撤销。浏览器 Session 7 天后行为仍未验收。

**T2 验收结论：** Clerk 管理 MCP 连接 **Pass**；独立开发应用创建 **Pass**；现有 LobeChat 隔离 **Pass（只读回读）**；Resource 注册 **Not performed（dry run only）**；真实 JWT/Opaque Token/Refresh/ChatGPT 自定义 MCP E2E **Unknown**；生产资源和正式插件 **未修改**。


## T3：公网 OAuth 发现及 Clerk 开发 Resource 注册

T3 已实现**隔离公网测试资源**：`https://spec853-clerk-oauth-lab.aiyaya.workers.dev/mcp`。Cloudflare Worker 公开发现协议 200、未认证与伪造 Token 的 401 均真实公网验证通过；Clerk 开发实例已注册该 URL、开启 CIMD 和 Audience，Checker 静态项目通过，Scope 提示为 **SHOULD Warning**，真实 Token/Refresh 项 **Not Checked**。完整版本 ID、部署 ID、源代码与运行回执参见 [T3 独立报告](./spec853-clerk-t3-discovery-worker.md)。**此 Worker 目前只做发现、始终拒绝认证，不提供真实工具；不要将 T3 当作 OAuth 登录或 Refresh E2E。**
