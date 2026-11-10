# Spec #853 — MCP Portal OAuth T0 只读预检

日期：2026-11-11。范围：现有 `mcp.lirtual.dpdns.org/mcp` 与 Cloudflare Access / Portal 的非敏感元数据。**仅 T0；未实施生产配置、Token、插件连接或 Worker 变更。** 配套设计：[长期免重连设计](./mcp-portal-long-lived-auth-design.md)。

## 核查方法与边界

- 使用 Cloudflare Access 应用列表、单应用 GET、Portal 详情、应用 Policy 列表、Access Organization GET；所有 Cloudflare API 请求均为 `GET`，输出仅保留非敏感字段。
- 使用未经认证的 `GET` 检查 MCP 入口、受保护资源发现元数据和 OAuth 授权服务器发现元数据；仅以明显无效的合成 Bearer 字符串检查拒绝行为，不涉及真实 Token。
- 参考 Cloudflare [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)、[MCP Portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/) 和 OpenAI [自定义 MCP 连接](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt) 官方文档。官方协议说明不能代替本项目的客户端 E2E。
- 使用状态 `Verified`（本轮实际读到）、`Unknown`（缺少可判断证据）、`Blocked`（当前授权/接口无法继续）和 `Not Met`（明确不满足）区分事实；不以一个状态代替另一个。

## 四层生命周期证据矩阵

| 层 | T0 状态 | 可回读证据 | 无法据此推出的结论 |
| --- | --- | --- | --- |
| Access 应用会话 | **Verified** | Portal 的 `mcp_portal` 应用 `session_duration=24h`；其他 11 个 `mcp` Access 应用也均为 `24h`。Portal 有两条既有 Policy（Service Auth、精确邮箱 Allow），未改动。 | 24h 不是 OAuth Access Token lifetime，也不是 Grant lifetime；Policy 单独覆盖与全局会话实际有效期未证实。 |
| OAuth Access Token | **Unknown** | `GET /access/apps/{app_id}` 成功，但返回体没有 `oauth_configuration`；无真实客户端 Token 的非敏感生存期证据。 | 不推断默认 15m 已应用、是否签发、何时过期或续期是否成功。 |
| OAuth Refresh Token / Grant | **Unknown** | 授权服务器发现元数据 `200` 且 `grant_types_supported` 包含 `authorization_code`、`refresh_token`；但未返回 `scopes_supported`，未证实 ChatGPT 收到 Refresh Token。`GET` 未提供 `oauth_configuration.grant`。 | `refresh_token` 出现在元数据中不代表客户端已收到；Access 应用 24h 不能冒充 Grant 配置；不推断 1–2 周为实际值或产品上限。 |
| MCP 协议会话 | **Unknown** | 无当前 ChatGPT OAuth Client 的 MCP 协议版本或 Session ID 非敏感回执；公开匿名 `/mcp` 返回 `401`。 | 不能将协议会话重建、无状态请求和 OAuth 重新授权混为一谈。 |

## 当前入口与 OAuth 发现结果（2026-11-11）

| 只读请求 | 结果 | 判定 |
| --- | --- | --- |
| `GET /mcp`，无身份 | `401`；`WWW-Authenticate: Bearer` 提供 `resource_metadata` 指向 `/.well-known/oauth-protected-resource/mcp` | **Verified**：匿名请求被拒绝并提供标准发现线索 |
| `GET /.well-known/oauth-protected-resource/mcp` | `200`，resource 为 `https://mcp.lirtual.dpdns.org/mcp`，authorization_servers 指向 Portal 根域名 | **Verified**：受保护资源元数据可发现 |
| `GET /.well-known/oauth-authorization-server` | `200`；提供 authorization、token、registration、revocation 端点；`grant_types_supported` 含 refresh_token；**无** `scopes_supported` | **Verified**：声明有刷新能力；**Unknown**：ChatGPT 能否发现所需 offline_access/等价机制并取得 Refresh Token |
| `GET /.well-known/oauth-protected-resource` | `200`，根 resource 可发现 | **Verified**；不能代替 MCP 路径的 resource metadata |
| `GET /.well-known/openid-configuration` | `404` | **Verified**；服务走 OAuth Authorization Server Metadata，不把这个 404 单独当根因 |
| `GET /mcp`，使用不可能有效的合成 Bearer | `401` | **Verified**：合成错误令牌被拒绝；不代表完整 Owner/Policy/撤销 E2E |

上次其他执行环境对发现端点曾观察到 `403`，但本次同一公网入口连续返回 `200`；仅凭不同时间/客户端的状态无法归因或认定 ChatGPT 侧持续可用。没有读写真实授权码、Access/Refresh Token，也没有发起 Client Registration、Token Exchange、Refresh、Revoke。

## Portal 与 ChatGPT 连接拓扑

- **Verified**：Cloudflare Portal `mcp` 当前挂载 11 个上游（KDocs、IMA、Git Guardian、Workflow、Github Actions、Browser、Sentry、Database、SSH、Remote Control、Raindrop），均 `on_behalf=false`；此为 Portal → 上游的管理员连接方式，不等于 11 个 ChatGPT OAuth Grant。
- **Unknown**：ChatGPT 实际安装插件数量、各插件 Endpoint、OAuth Client/Grant 身份映射、签发 Refresh Token 的事实、客户端最近一次断线的 401/403/授权错误、MCP 协议版本。ChatGPT 连接状态与令牌存储没有通过本次工具读出，不能凭服务列表编造映射。
- **Blocked（读取授权边界）**：Cloudflare Account OAuth Clients 列表返回 `403`，原因是当前连接没有 `OAuth Client Read`；此 API 不一定代表 Portal 动态注册的 Grant 记录，故不能据此推断 Portal OAuth 配置，也不因该错误提升权限或绕过拒绝。
- **Unknown**：Organization GET 未展示可核实的全局会话时长；单应用 GET 未展示 `oauth_configuration`。两者均不能解释为使用某个默认值。

## 裁定与下阶段准入

| 验收对象 | 结果 | 原因 |
| --- | --- | --- |
| T0 当前可读配置、元数据和未授权拒绝 | **Verified** | 已按四层拆分并留存上述可回读事实 |
| T0 根因完整归属 | **Unknown** | 真实 ChatGPT Refresh Token 签发、实际 Grant、客户端失败回执及协议版本未取得 |
| T1 ChatGPT Access Token 过期后的静默刷新 | **Blocked** | 需要独立生产/客户端操作授权；本轮未改动认证设置和插件，也未触发真实刷新 |
| T2 精确 Owner、策略拒绝和撤销残余窗口 | **Unknown** | 仅已验证匿名和合成错误 Token 返回 401；不能宣称即时撤销或完整安全 E2E |
| T3 长期无计划性重连（Q1） | **Unknown** | Cloudflare 官方规定 Grant 到期须重新认证；除非能证明持续合法续 Grant，短期自动刷新仍不能实现严格目标 |
| T4 11 个独立插件迁移 | **Blocked** | 既未证实数量/Client 映射，也未通过代表性真实刷新和生产授权；禁止批量变更 |

**最小后续步骤：** 在真实客户端的非敏感连接配置/失败回执中确认插件 → Endpoint → OAuth Client/Grant 映射，取得平台支持的 Grant 期限读回方式；评估是否存在可兼容 ChatGPT 的 `offline_access` 或等价声明与实际签发。之后经明确授权，仅对一个低风险独立插件做真实短 Token 过期后静默刷新、Scope/Owner 拒绝与残余撤销窗口的代表性 E2E。若固定 Grant 到期必须人工登录，记录原生方案“短期体验可改善、严格 Q1 不满足”，暂停大规模迁移；自托管身份兜底另行安全设计和授权。

不新增代码、Token 管理器、OAuth 代理、定时任务或状态数据库；此问题位于 ChatGPT ↔ Cloudflare Managed OAuth 边界，改变 `packages/portal-auth` 的静态上游 Bearer 鉴权不能修复客户端刷新。

## T1 前置真实客户端只读验收（2026-11-11，后续回读）

- **代表插件：Sentry**。通过当前已连接的 ChatGPT Sentry MCP 插件调用 `portal_list_servers`，返回 11 个可选上游且仅 `sentry` 为 enabled。证明该插件当前隔离选择 Sentry，不证明 11 个独立 OAuth Client/Grant 的数量或身份。
- 通过同一已连接插件执行 `sentry_find_organizations`（只读、无修改参数），返回 `organization_count=1`、`hasMore=false`；仅记录成功和数量，不记录组织信息。**真实 ChatGPT → Portal → Sentry 只读工具调用 Pass**。
- Cloudflare 两项新的生产 `GET` 回读：Portal 仍挂载 11 个上游；Sentry 上游 `ready`、`on_behalf=false`、上游 `auth_type=bearer`；Portal Access 应用仍为 `session_duration=24h`、两条现有 Policy；GET 仍不返回 `oauth_configuration`。这些是**上游与 Access 配置**，不代表 ChatGPT Token 签发或续期。
- **T1 子验收**：现有连接非破坏性调用 **Pass**；独立插件选择范围 **Pass**；Access Token 实际过期后的静默刷新 **Unknown / 未证明**；ChatGPT 是否持有 Refresh Token、Grant 期限及固定到期行为 **Unknown**。单次工具成功不得冒充 OAuth 刷新 E2E。
- **Cloudflare 原生方案严格目标风险**：官方 [Managed OAuth 文档](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)明确描述 Grant/Refresh Token 到期后必须重新认证；因此即便后续短期刷新成功，若没有可验证的合法自动延长 Grant 机制，严格 Q1（无计划性人工重连）仍 **Not Met**。不能将推荐的 1–2 周配置冒充无期限有效。
- **停止边界**：未读取、记录、交换、刷新或撤销真实 Token；未操作 ChatGPT 插件重连、Client Registration、Access/Portal 配置、Worker 或生产数据。浏览器管理页观察未获得可靠可用回执，不以页面错误反推系统状态；Cloudflare Account OAuth Clients API 的既有 403 不绕过。

**进入真实刷新 E2E 的最小授权条件：** 限定 `Sentry` 这一个现有 ChatGPT 插件；先只读回读其实际 Endpoint/连接身份及可恢复方式，再确认与留存不含密钥的现状；如果必须重新授权或重建客户端，需先明确告知该插件可能暂时不可用及如何用原 Endpoint 重连，获得该具体客户端变更授权；不触碰其余插件、生产 Access Policy、Grant 配置或凭据。使用真实客户端在已确认的 Access Token 生存期过去后进行无人工登录的安全只读调用；若无法独立取得 Token 生存期或刷新行为回执，结论继续标记 Unknown，不把等待 15 分钟后的一次成功调用认定为自动刷新。
