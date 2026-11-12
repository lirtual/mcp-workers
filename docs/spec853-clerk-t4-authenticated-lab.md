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


## T6 Access Token 一天到期后的真实重访（2026-11-12 北京时间约 18:00）

**唯一实际操作：** 在沿用 T5 已连接的 ChatGPT 自定义插件、未断开/重新授权、未修改开发 Clerk OAuth 参数或测试 Worker 的前提下，直接调用 `mcp__Spec853_Clerk_OAuth_Lab__lab_status({})`。返回 **`Spec853 lab: authenticated no-op`**，Pass。T5 首次开发用户创建时间为 2026-11-11 17:47:26 北京时间、首次受保护工具调用也发生在约 17:50；本轮调用已间隔**超过一天**。Clerk 官方 OAuth 文档明确 access token **expire after 1 day**、refresh token **never expire**；参见 https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth 。

**相互独立的只读回读：** Clerk 实验开发实例用户数仍为 1，`oauth_jwt_access_tokens=false`、`aud_claim_enabled=true`、`pkce_required=true`、CIMD 广告开启；Cloudflare 专属测试 Worker 仍使用 `c7f2d3dc-fd9a-458a-9d3a-656ed06c94f3`（100%），唯一 Binding 仍是 `CLERK_SECRET_KEY:secret_text`、Preview 关闭，没有新发布或密钥轮换。开发应用的 `session_settings.maximum_lifetime=604800` 秒（7 天）是**登录会话配置**，不是 OAuth Refresh Token 已验证的生存期。

**严格验收判定：**
- `Pass` — **当前真实 ChatGPT 插件在首次授权超过 24 小时后，未经用户重新登录仍能访问受保护的测试 MCP 工具**。这是当前用户目标的一个重要功能性端到端证明，不只是“Connected”状态或模拟请求。
- `Unknown` — **这一次是否实际发生了 `grant_type=refresh_token` 请求、是否换发/轮换 Refresh Token，以及该行为的精确时间**。当前 Clerk MCP API 不暴露 OAuth Grant 明细；尝试只读浏览 Clerk Dashboard 日志时，官方 agent session 返回 `agent_session_forbidden`。遵守限制，停止尝试，不读取 Token、不绕过权限，也不制造伪造日志。官方静态 Checker 的 `end_to_end_verified=false` 并不能替代本次实调用凭证，但也不提供 Refresh Grant 证明。
- `Unknown` — 多周/长期空闲、7 天会话边界、Refresh Token 撤销、登录身份与客户端白名单、生产业务 Owner ID 限制。特别是本测试 Worker 尚未设置 Owner ID 白名单，只允许固定无副作用 `lab_status`，不能据此迁移生产权限。

**结论：** 当前 Spec #853 的**24 小时后免手动重连功能门** Pass；Refresh 协议具体事件链路、长期授权稳定性仍需独立证据，**不需要重复等待一天进行同质验收**。保持已有测试插件与 Worker 不变。Draft PR #859 仍为 Draft、不合并 main；本次仅更新文档/Issue，不修改 Clerk、Cloudflare 运行时或 ChatGPT 插件设置。

## T7 Owner 严格校验与 Cloudflare 独立测试 Worker 验收（2026-11-12）

- **代码最小变更：** `auth-lab-worker.mjs` 要求 `env.CLERK_OWNER_USER_ID` 为合法单个 Clerk `user_...` ID，并与 Clerk SDK 成功校验的 `state.toAuth().userId` 完全相同；错误、空值或缺失均 401。原有固定 Audience、`profile` Scope、Issuer、`oauth_token` 类型、只允许 `lab_status` 单工具及无状态部署保持。开发用户数唯一只能作为核查，不能代替这个运行时限制。
- **本地 42/42 Pass：** 其中 T7 合同覆盖非 Owner、伪造 Header/RPC Owner、Scope 缺失、SDK 返回已撤销、校验服务异常及 Owner 变量未配置等；另复用 Clerk SDK 合成签名和真实本地 workerd 验证。上述坏 Owner/撤销输入是**模拟令牌**，不能标为真实 Clerk OAuth 后台 E2E。
- **唯一非生产改动：** PR #859 提交 `c886f2ac99c8051597c5288cdff1bd973a2518bc` CI Required/Application/GitGuardian 全 Pass 后，以 `--strict` 对独立 `spec853-clerk-oauth-lab` Worker 发布经过 hash 验证的 bundle（SHA-256 `d970325b4044a5466f67f2d15bd0f5af8a3d1703170dbcacad84ab1570b1b837`）。只新增 `CLERK_OWNER_USER_ID:plain_text`，保留已有 `CLERK_SECRET_KEY:secret_text`；不在 Git 中保存 Owner ID 值、Secret 或部署缓存。
- **真实公网回读 Pass：** Version `e5bbebb9-0e73-4529-a8b9-d21d3e13b705` 承接 100%，`preview_urls=false`，两个绑定名称与类型符合，Owner 绑定值与已核对的唯一开发 User ID 一致。公开 PRM=200；无 Bearer / 伪 Bearer 均 401；同一 ChatGPT 已连接测试插件调用 `lab_status({})` 返回 `Spec853 lab: authenticated no-op`，保持了此前的授权连接。
- **严格边界：** Owner 成功路径=Pass；无凭据与伪凭据公网拒绝=Pass；真实非 Owner Token、公网撤销即时生效与更换 Client admission=Unknown。无真实业务工具/后端、没有 Portal/Access/生产 Worker/DNS/ChatGPT 原连接修改。下一步生产迁移必须另行审查并授权。

## T8 公共 CIMD 元数据与 Sentry 准入核查（2026-11-12）

- **公共协议真实性：** 对实验 Clerk 开发 Issuer 的 `/.well-known/oauth-authorization-server` 和 OpenAI 稳定 CIMD `https://chatgpt.com/oauth/client.json` 均实际 GET 200，逐项读取了公开的 issuer、`authorization_response_iss_parameter_supported=true`、CIMD、Token Refresh、PKCE `S256`、`none` 与回调 URL。没有访问或缓存 Access/Refresh Token。ChatGPT 官方文档显示此 Clerk 元数据符合稳定 CIMD 的使用条件，但**实际已授权客户端记录的 Client ID 仍 Unknown**。
- **正式 Client 门：** Clerk 开发实例当前未限制预注册（`client_id_metadata_documents_only_allow_pre_registered_clients=false`），DCR 已关闭。想切成严格预注册，必须先通过官方授权方式读取该开发实例的已连接 Client 元数据、将实际 Client 明确允许且限定 Scope、再切 admission 并实测原插件仍可用。已尝试的 Clerk Dashboard 代理会话遭平台 `agent_session_forbidden`，不能更换身份绕过；现有 Clerk 管理 MCP 也没有对应操作。本轮没有改动 Clerk 配置或 Client 状态。
- **Sentry 只读能力：** 连接器返回组织 `nfwt` 与项目 `scrape-relay`；Cloudflare 生产 Portal 仅只读查询确认 Sentry 后端 `https://mcp.sentry.dev/mcp`，`auth_type=bearer`，管理端上游状态 connected/ready，已暴露的工具清单 73 个且含写操作。不能把连接器的只读查询成功或工具名当作该 Bearer 的 `org:read/project:read/event:read` Scope 证据。正式计划需专用只读认证，禁止复用 Portal 管理凭据或直接代理全部工具。
- **真实 User/撤销门：** 本轮未创建非 Owner 测试账号、未向任何客户端签发第二 Token、未撤销当前唯一 OAuth Grant，也未修改用户登录状态。这两项继续 `Unknown`；SDK/Workerd 的 42/42 静态/模拟 Pass 依然有效，不新增假验收。
- **交付范围：** 仅文档事实审计和现有只读连接器调用，Cloudflare Worker `e5bbebb9-0e73-4529-a8b9-d21d3e13b705`、原 Clerk/Sentry/Portal 配置、生产端点、OAuth 客户端均不变。

## T9 BrowserMCP LIRTUAL 直接读取现有 Client（2026-11-12）

- **读到确切信息：** LIRTUAL Edge Profile 的 Clerk Dashboard `mcp-workers-spec853-oauth-lab / development → Configure → Developers → OAuth applications` 列出 `ChatGPT` / `CIMD` / `https://chatgpt.com/oauth/client.json` / 创建 2026-11-11；Scopes：`email`、`offline_access`、`openid`、`profile`。不再将本开发实例中已连接的 Client ID 记为 Unknown。
- **T9 只读时点仍缺权限门（T10 已显式允许）：** 客户端 `Actions` 菜单显示 `Explicitly allow`。这意味着尚未显式 allow，且开发实例设置仍允许非预注册兼容 Client。未触碰任何菜单写项；下一步若执行显式 allow，须随后回读权限，并用原 ChatGPT `lab_status` 验证无重连继续可用；严格模式启用同理需独立回读。
- **保持范围：** 未创建或调整 OAuth Client，未修改已建立的 ChatGPT/Clerk 会话，未触及真实 Sentry、Portal、Access Policy 或生产资源。

## T10 开发实例显式允许 Client（2026-11-12）

- 通过 BrowserMCP LIRTUAL Endpoint 对 Clerk Development 中现有且唯一的 `ChatGPT / CIMD / https://chatgpt.com/oauth/client.json` 点击 `Explicitly allow`；收据 completed，网站显示 `ChatGPT is explicitly allowed`，随后**重新导航页面**再次展开 Actions，菜单已无 `Explicitly allow`，此配置变化 **Pass**。
- 不重新安装插件、不退出登录，再次直接调用 `lab_status({})` 返回 `Spec853 lab: authenticated no-op`，现有 OAuth 客户端继续可用 **Pass**。
- 只读管理回读：`client_id_metadata_documents_only_allow_pre_registered_clients=false`，严格限制未知 Client **未执行**；DCR 仍关闭、PKCE 仍开启。不能因此宣称陌生 Client 已被真实拒绝。
- BrowserMCP 仅针对菜单关闭 `Escape` 收到 `failed/forbidden/blocked_forbidden_target`（operation `e6625833-64be-477c-a722-c5d1949d4c29`），遵守安全拒绝并停止该页面进一步控制。不能将该操作误报为全局准入修改失败。测试 Worker 没有发布或更改。
- 余项：Development 全局预注册限制、陌生 Client 拒绝、真实撤销、7 天后会话/刷新、Clerk Production 和 Sentry 最小权限迁移均尚未验收。保持 Draft PR。

## T11 严格 CIMD 预注册准入配置 + 原连接 E2E（2026-11-12）

- BrowserMCP LIRTUAL 在 Clerk **Development** 的 OAuth applications → Settings 选择 `Pre-registered clients only`，确认 `Block unregistered clients`，随后处理单独的 `Unsaved changes → Save`；Clerk UI 最终显示 `Saved!`。没有改变 Client Scopes 或登录状态。
- Clerk 管理端**独立实时回读**：`client_id_metadata_documents_only_allow_pre_registered_clients=true`、`client_id_metadata_documents_block_implicitly_allowed_clients=true`、DCR=false、PKCE=true、CIMD=true、Audience=true、Opaque OAuth Access Token=true。此前 T10 开关为 false 的描述仅记录当时历史，**当前以此值为准**。
- 原 ChatGPT Lab 插件未断开或重新授权，直接 `lab_status({})` → `Spec853 lab: authenticated no-op`。客户端预注册配置 Pass、现存正常连接 Pass；**未通过真实未知客户端做拒绝 E2E**，该负面项目仍 Unknown。Clerk Production、Portal 与 Sentry 生产均未改。

## T12 陌生 CIMD 负面尝试与 Sentry 凭据边界（2026-11-12）

- 测试了 Claude Code 和 OpenCode 两个真实有效的公开 CIMD metadata。未登录 CLI 授权请求先 302 Clerk sign-in；已有 LIRTUAL BrowserMCP 访问两条陌生 Client OAuth authorization URL，均显示 invalid_client / The Client ID Metadata Document could not be resolved。无新 Grant、无授权同意、无改 Client 策略。**陌生客户端未能完成授权=实际观察；错误究竟由严格准入还是元数据抓取导致=Unknown，不能伪标因果 Pass。**
- Clerk 官方回读 strict-only=true、block-implicit=true、DCR=false、PKCE=true；原 ChatGPT lab_status 在上述测试后依然返回 Spec853 lab: authenticated no-op。
- Sentry nfwt 的 Organization Tokens=0、Custom Internal Integrations=0（LIRTUAL 浏览器只读）；Sentry 官方 scoped inspect 路由在未提供凭据时 tools/list 返回 401 Bearer。只读工具权限/跨组织实际防护仍未进行有凭据 E2E。
- 不读取或创建 Token、不撤销当前用户、不新建 Worker 或数据库、不修改 Sentry/Cloudflare 生产、Clerk Production 或正式 ChatGPT 插件。下一步是独立只读 Sentry 凭据及生产操作的明确授权，和可恢复的独立 Clerk 撤销测试。

## T13 Org Token 类型不符与 Internal Integration 只读预检（2026-11-12）

- Sentry 官方 Org Auth Token API 仅允许 `org:ci`，**无法**签发 `org:read, project:read, team:read, event:read`。已避免创建无效凭据。
- Sentry `nfwt` 的 Internal Integration 创建表单已通过 LIRTUAL BrowserMCP 只读打开：项目、团队、问题/事件、组织权限均可设置 Read，其他资源默认 No Access；Webhook/Alert 功能可保持未启用。未填写并提交创建表单、未签发 Token；原有 Org Tokens/Internal Integrations 仍无新增记录。
- 官方远程 MCP direct auth 需 `Sentry-Bearer`，与 MCP OAuth `Bearer` 不同。是否能对单项目 `inspect` 实际列工具、是否存在跨资源拒绝，继续 Unknown，等待用户确认用 Internal Integration 创建专用只读凭据的新增生产配置对象。

## T16 Sentry 只读测试与已暴露 Token 撤销（2026-11-12）

- Sentry nfwt Internal Integration `spec853-sentry-readonly` 已真实保存；唯一 API Token 只读四 scopes，UI 后四位为 1640。用户将原 Token 贴入聊天，按暴露处理，并授权一次只读测试后立即撤销。
- Sentry REST 获取 nfwt 项目列表返回 200，且目标 `scrape-relay` 是唯一可见项目；Sentry remote MCP `/mcp/nfwt/scrape-relay?skills=inspect` 携 `Sentry-Bearer` 返回 HTTP 200，但解析为 0 个工具，未执行真实只读工具调用，**MCP inspect E2E 不能标 Pass**。尝试 Token 管理 API 返回 403。
- 用户在 Sentry 界面 Revoke 后，BrowserMCP LIRTUAL 回读 Integration Token 表格显示 `You haven't created any authentication tokens yet.`，不存在末尾 1640 的列表项。**Token 撤销 UI Pass、集成保留、当前 Token 0**；未对已撤销原值再次发起请求。
- 本轮没有将 Token 原文提交至代码仓库、文档、Issue、CI 或正式配置；不得再使用该 Token，也不得将 Token 值作为复测材料。后续实际 MCP 工具调用需要安全渠道提供的独立测试 Token 与单独撤销，且仍不能视为 Clerk refresh 验收。
