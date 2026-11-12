# Spec #853 — MCP 独立插件长期 OAuth 续期设计（2026-11-12 验证更新）

状态：**Cloudflare 托管 Portal 的固定 Grant 到期机制不满足严格无计划重登；Clerk Hobby 仍为候选，已完成隔离开发实例的真实 ChatGPT 首次连接、24 小时后免手动重连、Owner 校验及无副作用工具 E2E。Clerk Production、真实 Grant 事件、正式生产权限隔离和业务迁移均未验收。** 本文为当前设计事实源；不授权修改生产 Portal、Access、Secrets、DNS 或 ChatGPT 正式插件。

## 一、最终约束（已决策，不再重复提问）

- Q1：首次授权后**正常使用无计划性人工重新授权**，不是 30/90/365 天硬到期；撤销、账号风险、权限调整、客户端凭据丢失或产品政策变更是明确例外。
- Q2：个人正式生产 $0，**无需绑定信用卡或付款方式**；不得以试用期或隐藏升级作为达标。
- Q3：保留每个 ChatGPT MCP 插件的独立安装、独立关闭、独立资源受众与工具权限。现有 Portal 有 **11 个上游**，但上游数不证明客户端有 11 个独立 OAuth Client/Grant。
- Q4：**先核实是否只改现有 Cloudflare MCP Portal 即可满足 Q1**，成功则不引入 Clerk/新 Worker。若 Cloudflare Managed OAuth 存在不可消除的固定 Grant 到期，才采用候选新链路：ChatGPT 独立插件 ↔ Clerk OAuth、ChatGPT 直接调用各自 MCP Resource/Worker（不经 Portal）。优先复用业务 Worker 的共享校验模块；仅无法直接改造的上游，条件性设计**最多一个薄、尽可能无状态的 Cloudflare 适配 Worker**。旧 Portal 保留过渡与回退。无 VPS/Docker/常驻自托管 OAuth 服务器。
- 生产修改（含 Clerk Production 实例、DNS、Access Policy、Client、ChatGPT 插件连接、凭据、Worker 发布）必须另行精准授权。非生产代码与概念设计不得冒称生产 E2E。

## 二、证据与现状（Verified / Unknown / Not Met）

| 命题 | 来源与证据 | 裁定 |
| --- | --- | --- |
| Clerk Hobby 为 $0、免信用卡、包含正式应用 | 官方 [Pricing](https://clerk.com/pricing) 显示 Free、No credit card、每应用 50,000 MRU 限额、Custom domain 和固定 **7 天浏览器 Session**；[Production deployment](https://clerk.com/docs/guides/development/deployment/production) 要求自己的可配置 DNS 域名和生产实例 | **Verified：产品标价及生产流程**；**Unknown：本用户实际创建生产实例和 OAuth 开关的账号级限制/账单状态**，没有创建生产实例验证 |
| Clerk OAuth Token 与会话时钟 | 官方 [OAuth 实现](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth) 声明 Access Token **1 天**、Refresh Token **never expire**、Authorization Code 10 分钟；内置 `offline_access`，Discovery 可声明 `scopes_supported` | **Verified：公开产品契约**；7 天网页登录会话不等于 OAuth RT 硬过期，但仍需验证浏览器 Session 结束、退出登录和账号撤销分别对已签发 RT 的影响 |
| OAuth 客户端协议 | Clerk 支持 CIMD、S256 PKCE、可配置 Client admission；[CIMD GA](https://clerk.com/changelog/2026-09-17-client-id-metadata-documents-ga) 称所有 Clerk 应用可用。OpenAI [Plugins Authentication](https://developers.openai.com/plugins/build/auth) 与 [Custom MCP Server](https://developers.openai.com/api/docs/guides/custom-mcp-server) 明确 ChatGPT 支持 CIMD（`none`）、DCR、S256 和 `resource`；优先 CIMD | **Verified：双方协议支持**；**Verified：独立 Clerk Development + ChatGPT CIMD 完成真实授权及工具调用；Unknown：Hobby Production 的实际生产应用、Client 预注册及正式回调/Discovery** |
| ChatGPT Refresh Token 续期 | 本项目同一 ChatGPT 插件在 2026-11-11 首次授权后、2026-11-12 逾 24h 未手工重连仍成功调用受保护 MCP；[T5/T6 证据](./spec853-clerk-t4-authenticated-lab.md)；Clerk 官方文档声明 OAuth Access Token 1 天、Refresh Token 无固定到期日 | **Pass：超过 24h 免手动重连的实际用户体验；Unknown：实际 refresh_token grant/轮换、7 天浏览器 Session 到期后的行为及长期空闲稳定性** |
| Cloudflare 原生 Grant 的严格 Q1 | [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) 明确 Grant/RT 到期需要重新认证；不能由 Access App 的 24h 会话值推断真实 Grant 期限 | **Not Met：存在固定 Grant 到期且无合法自动续 Grant 证据时，不能满足“无计划性重连”**；现有实际 Grant 值仍 Unknown |
| Portal 现状只读回读 | 2026-11-11 再次只读 GET：1 个 `mcp` Portal 含 11 上游，全部 `on_behalf=false`；1 个 `mcp_portal` + 11 个 `mcp` Access App 均 `session_duration=24h`；Portal App 两条既有 Policy；App GET 没有 `oauth_configuration`。见 [T0 审计](./mcp-portal-auth-t0-20261111.md) | **Verified：以上配置字段**；**Unknown：实际 Grant、11 个独立 ChatGPT 安装的 OAuth 映射及刷新** |
| Portal 直接接受 Clerk OAuth JWT | 现有 Portal 面向 ChatGPT 使用 Cloudflare Managed OAuth，关联 Cloudflare Access Grant；`packages/portal-auth` 校验的是上游静态 `MCP_ACCESS_TOKEN`，不信任任意第三方 JWT | **Not Met：不能只把 Clerk 设为 Cloudflare 登录 IdP 或替换 Issuer 即获得长效 RT** |

**证据层级：** Clerk 文档中的“never expire”代表**没有预设自然到期**，不代表不可撤销、绝无失效或用户永不需要重新登录。正式 Hobby 账户功能、真实授权/刷新与持续可用性须另行验收，文档与一次工具调用都不能替代。

## 三、最小安全架构：先限制权限扩张，再谈免重连

### P0. 现有 Cloudflare MCP Portal 的最小变更可行性（第一优先）

- **P0 官方机制核实（Verified）：** [Cloudflare Managed OAuth，最后更新 2026-11-03](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) 明确称短效 Access Token 可使用 Refresh Token 静默刷新，并于每次刷新重评 Access Policy；但 `Grant session duration` 是 RT 的有效期限，**Grant/RT 到期则必须重新向身份提供方认证**。官方推荐 5–15 分钟 Access Token 与 1–2 周 Grant 只是示例，不是本账户已启用配置或产品最大值。**在官方已描述的固定到期模型下，严格 Q1=Not Met；不靠增加 90/365 天冒充达成。**
- **滚动续 Grant 证据边界：** 当前 [Managed OAuth 配置文档](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) 仅列 `grant.session_duration`、`grant.access_token_lifetime` 等选项；未发现官方声明托管 Portal 可以滚动延长 Grant 或将其设置为无预设到期。**不能将“未发现”硬说成平台永远不存在**；若有新的公开功能、正式厂商答复或安全可读回接口，再重新打开 P0。Cloudflare **独立开源包** [workers-oauth-provider 的 `refreshTokenIdleTTL`](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/advanced-configuration.md#sliding-expiry) 确有滑动续期，但不是受托管 Portal 的 `oauth_configuration`，采用它等于引入自己的 OAuth Worker（及包所需状态），**不能算只改 Portal**。
- **本账户生产只读回读（2026-11-11 Verified）：** Portal `mcp` 当前仍为 **11 个上游、全部 `on_behalf=false`**；其对应 Access App `mcp.lirtual.dpdns.org`（`mcp_portal`）的 `session_duration=24h`，共有两条现行关联 Policy：`WORKFLOWS` Service Auth（优先级 1）和 `MCP Portal and Browser Owners` Owner Allow（优先级 2；当前包括两条 email selector）。这是**当前实配**，不能把旧文档的 Browser-only Policy 说明冒充当前状态。本次 GET 不包含 `oauth_configuration`，实际 Grant/Access Token TTL **Unknown**；24h Access App 登录会话不是 OAuth Grant TTL。
- **当前安全改动门阻断（Blocked）：** Cloudflare Access App 的官方更新操作为 `PUT /accounts/{account_id}/access/apps/{app_id}`，本次 OpenAPI 读取没有该应用的 `PATCH`，而 GET 未提供完整 `oauth_configuration`；不可安全确定旧 Grant、变更前后差异和可恢复原值。**不得试写任何“grant-only”生产调整**，也不以重新连接 ChatGPT 来猜测效果。之前 Account OAuth Client Read 403 保留阻断回执，不提升权限或更换身份规避。
- **P0 裁定与停止条件：** **原生托管 Portal 可刷新短 Token（协议 Verified），但按照当前官方 Grant 到期契约，长期无计划性人工重连 Q1=Not Met。** ChatGPT 是否已实际领到/使用 Refresh Token 仍 **Unknown**，不应把两者合并判断。基于此无需进行高风险生产调长试验；允许仅把 Clerk 作为下一候选做非生产可行性验证。只有未来新的官方滑动 Grant 契约与安全可读回能力同时成立，才重新考虑“只改 Portal”作为首选。

### A. Clerk 备选新链路：Clerk → 原生 MCP Worker（仅在 P0 不满足时）

ChatGPT 各独立插件直接访问自己的 MCP URL；Clerk 只承担 OAuth 授权、签发及刷新；业务 MCP Worker（资源服务器）在每次工具请求验证 Clerk Access Token 的真实身份、受众、Scope，再执行该 Worker 的原生工具。优先在**已有受控 MCP Worker 与共享鉴权代码**中最小接入，不让所有业务请求先绕行 Cloudflare Portal，也不把 Clerk 当成 HTTP 反向代理。现有 `packages/portal-auth` 当前仍只支持预置 `MCP_ACCESS_TOKEN`，所以直接接入需要单独设计鉴权入口变更，不能宣称修改 Clerk 就会自动生效。对无法改造源码的第三方上游（例如 Sentry），只有经过最小权限证明，才考虑一个针对具体后端固定路由的适配 Worker。

### B. 旧链路：Cloudflare Portal 在 Clerk 备选启用时仅保留现状及回退

现有 Portal、11 个 `on_behalf=false` 上游、Owner Email Access Allow、Browser 专属 QQ-only 例外、`WORKFLOWS` Service Auth、`MCP_ACCESS_TOKEN` 与原 Endpoint 均**保持不变**，仅服务原有连接、分批迁移与回退；不构成新 Clerk 认证链路中的节点。原生 Cloudflare Managed OAuth 的固定 Grant 到期问题不因增加 Clerk IdP 消失。

### C. 仅在必要时增加一个非 Portal 的轻量适配 Worker（条件候选）

只有对不能直接修改认证入口的现有第三方 MCP 上游（或者多业务 Worker 无法复用鉴权模块）证明有必要，且满足全部以下门禁，才允许进入非生产 PoC：

1. **OAuth 发现：** 每个独立插件一个明确且稳定的 HTTPS MCP resource URL（默认其原生 MCP Worker URL；仅不能改造时才是同一个适配 Worker 的不同固定路径），公开对应 `/.well-known/oauth-protected-resource/...`；`401 WWW-Authenticate` 指向正确 PRM；Authorization Server 指向 Clerk **Production Issuer**；`resource` 参数传递一致，`aud` 与请求目标精确匹配；CIMD + S256 PKCE，优先使用 Clerk 已批准的 ChatGPT CIMD Client，**关闭匿名开放 DCR**。Stable/Callback-specific CIMD Client ID 与实际回调以 ChatGPT 显示值为准，不猜。
2. **身份与工具：** 每个请求校验 Clerk issuer、签名/有效性（或在线 introspection）、`exp`、`aud`、`scope`、精确已审批 Owner `sub`；email 仅作账号关联辅助，不能用未验证的邮箱字符串代替 `sub`。每个资源**固定允许工具和单一后端**，不可通过请求参数、Header、工具名或任意 URL 指向别的插件。独立插件相同 ChatGPT CIMD `client_id` **不是**权限隔离凭据，必须以 audience + scope + 后端 allowlist 构成实际隔离。
3. **撤销与失败行为：** Clerk 默认 **1 天 JWT 不能即时撤销**；[revokeToken](https://clerk.com/docs/reference/backend/oauth-applications/revoke-token) 与 [Token formats](https://clerk.com/docs/guides/development/machine-auth/token-formats) 明确 JWT 撤销受限制。Spec #853 若要求及时撤销，需要优先验证 **Opaque Access Token + Clerk 在线验证**能否在 Hobby Production 使用、能否在 Cloudflare Worker 安全高效调用；网络失败要 fail-closed。不允许把纯离线 JWT 验证直接宣称撤销即时生效；若 Opaque 不可行，单独裁定剩余 24h 风险，不静默降低验收标准。
4. **后端权限：** **首选原生 Worker 自己校验 Clerk Token、执行自己的工具，不经过 Portal**。禁止把 Portal 管理 OAuth/Service Token、上游静态 Bearer 下发给 ChatGPT。现有 11 上游 `on_behalf=false`，若用单个高权限 Service Token 调用整个 Portal，会放大误用影响：**该捷径 Blocked**。只有不能修改源码的外部 MCP 才允许条件性评估一个适配 Worker，其每个固定路由必须具备单后端、最小允许工具、独立受限的上游认证方式；如不能证明，则该上游不迁移，而不是退回 Portal 管理令牌汇聚。
5. **Cloudflare Access 与直接入口：** 不修改或放宽现有 Portal/业务 Worker 的 Owner、Browser 专属例外与 Service Auth 规则；不新增 Everyone/Bypass。Clerk 直接入口是一条**新增的人类身份信任路径**，不自动继承 Cloudflare Access 既有 Owner 判断，必须先证明 Clerk `sub`、Audience、Scope 和业务工具权限至少等价；若 Access 先拦截公开 OAuth Discovery，须查清具体冲突并**单独审查是否可安全配置独立入口**，不得静默绕过。Worker Service Binding 绕过公网 Access 时仍必须在入口严格验证并只调用已隔离后端。任何无法解释的跨插件调用均 fail-closed。
6. **最少状态和运维：** 仅验证/转发/最小审计，不自发签发 Refresh Token，不存 Token，不新增 KV/D1/DO、Cron、轮换器、长期会话数据库或第二层 OAuth。Clerk 负责 RT；ChatGPT 负责持有与刷新；Worker 不应承担 Token Vault 工作。Clerk 生产所需的独立 Frontend API DNS 是供应商硬要求，不能把这误写成“无需任何 DNS”。
7. **受限日志：** 只保存必要请求结果/拒绝原因/固定目标标识和相关性 ID，不记录 Token、Authorization Code、敏感身份或管理凭据。Opaque 在线校验的速率限制、延迟、异常策略与 $0 配额是准入门而非默认忽略。

最小概念数据流：

```text
ChatGPT 独立插件（各自 MCP URL / resource / scopes）
    ↔ Clerk OAuth / CIMD / PKCE / offline_access（登录 + Token 自动刷新）
    -> ChatGPT 持 Clerk Access Token 直接请求对应 MCP Worker
    -> 原生 MCP Worker 校验令牌、Owner、aud、scope 并执行本服务工具
       [仅不可直接改造的第三方 MCP 例外：一个可选受限适配 Worker]

旧 Cloudflare Portal /mcp：保持原有连接和回退；不在上面的新链路中
```

**不推荐：** Clerk 仅作为 Cloudflare Access 的上游 IdP；把 Client 直接指向 Portal 管理员 Service Token；11 个插件共享一个无服务级授权约束的聚合代理；为方便登录而取消 Policy；自行编写长期 Refresh Token 服务器。

## 四、最短验证路径及硬停止条件

| 门 | 必须得到的真实证据 | 未通过时 |
| --- | --- | --- |
| P0：Portal 优先门 | 官方 Managed OAuth Grant 固定到期、现有可读配置、可安全恢复配置能力及 ChatGPT RT 实际刷新 | **Verified：官方承诺短效 Token 静默刷新、Grant 到期重新认证**；**Not Met（严格 Q1）**；实际 Grant TTL 与 ChatGPT 实际刷新仍 Unknown；因缺 `oauth_configuration`，生产配置最小安全试改 Blocked |
| T0：Clerk 备选事实门 | Hobby $0 免卡、Production 注册要求、CIMD/PKCE/offline_access、1 天 Access Token 与无固定 RT 到期；当前 Portal 11 上游及 Access Policy | 仅当 P0 不满足时再推进 Clerk；账号级限制、Token 实例行为保持 Unknown |
| T1：非生产协议/Worker | 不使用真实生产 Token/数据，使用模拟 Clerk 风格 JWT/响应验证 issuer/exp/aud/scope/Owner、跨插件阻断、发现路由、Token/管理 Header 不泄漏、Workers Runtime 兼容与 fail-closed | **Pass（25 个合成合同 + 1 个本地 workerd 合同 + 2 个 Clerk 官方 SDK 与真实本地 workerd 测试；总计 28/28）**；证据见 [Clerk T1 PoC](./spec853-clerk-nonproduction-poc-20261111.md)；后续真实 Clerk SDK/ChatGPT Development 已额外 Pass，详见 T7；Production 仍 Unknown |
| T2：权限等价性 | 不走 Portal 管理身份聚合捷径；每条后端路由、Service Auth、上游 MCP Token 独立约束且跨服务调用不可达；Opaque/在线撤销机制与计费可行 | **Blocked**，保持现有生产。不得为完成验证而允许聚合管理员权限 |
| T3：另行授权的一个真实 Sentry 插件 | 在当前 Endpoint 与可回退身份核对后，真实 ChatGPT 首次登录、`offline_access`、成功签发 RT 的**非敏感证据**、Access Token 到期后**真实刷新事件**、7 天浏览器 Session 到期仍可静默刷新；错误 Owner/aud/scope/工具拒绝、撤销后拒绝及残余窗口 | **Unknown**；单次工具成功或“等了 24h 仍能调”不等于刷新日志验收 |
| T4：长期目标 | 官方没有计划性 RT 硬到期 + 真实 ChatGPT 续期证据，未隐含付费升级/客户端注册门槛 | 达不到标 `Not Met`，不能用 90 天代替 |
| T5：逐插件迁移（另行授权） | 保留安装/开关独立；独有业务工具的授权边界、启动与只读调用逐项检查；等价共享机制的重复 E2E 标为 `Waived` 并标证据 | 任何异常停止该插件迁移，保留 Cloudflare 回退；其它插件不动 |

不为证明“几个月有效”虚构等待；但**默认 1 天 Access Token**不能在半小时演示里证明真实 Refresh，除非 Provider 有真实受支持的短 TTL/刷新事件及可核实日志。不得记录 Token 本体。

## 五、深度安全/复杂度复核

- **主要安全风险 1：** 把 Clerk 接入现有 Portal 管理机器身份会将单插件边界升级成 11 服务管理员权限。此路径当前 **Blocked**。**新链路首选直接对接原生 MCP Worker**；第三方适配必须证明后端权限被真实技术边界限制。
- **主要安全风险 2：** 长效 RT 被盗的风险更大；不使用无限期静态 Bearer 替代人类身份，Clerk 负责撤销，Cloudflare Worker 不保存 RT；按 per-resource 最小授权限制影响面。
- **主要安全风险 3：** JWT 默认存续 1 天导致撤销残余窗口；优先核实 Opaque 在线校验在 Hobby 与 Workers 的能力/成本，**不允许把失败路径放行**。
- **主要安全风险 3a（2026-11-11 SDK 实测）：** `@clerk/backend@3.27.0` 的 `VerifyJwtOptions.issuer` 说明机器令牌忽略该设置。合成 JWT 在固定公钥验签和正确 Audience 后仍可能包含错误 `iss`；资源服务器在 SDK 验证成功后须进一步核对已验证 JWT 的 `iss`。已在实际本地 workerd 增加拒绝测试。Opaque Token 不包含 JWT Claims，须通过真实 Clerk SDK 与受信任实例的在线验证确定来源，不能套用 JWT 字段解析。此门禁不引入数据库、网关或新服务。
- **主要安全风险 4：** ChatGPT 可能不发送 Scope；必须核实 `offline_access` 的最小默认授权、独立工具 Scope 的实际强制检查，并避免通过默认 Scope 一次授予所有服务。
- **复杂度结论：** 不宜构建自有 OAuth 服务器、数据库或刷新服务；**Clerk + 现有 MCP Worker 共享校验模块**优先（正式接入采用 Clerk 官方 `@clerk/backend`，严格 `acceptsToken: "oauth_token"` 与 `audience`；JWT 还须在 SDK 验签后显式比对固定 `iss`，不能依赖 SDK 机器令牌的 `issuer` 参数。非生产测试代码不作为生产鉴权）。，可能无须新增 Worker。只有第三方 MCP 无法直接集成时才考虑最多一个薄适配 Worker；如果隔离需要高权限跨服务秘钥或多个代理，应停止并重新审查价值，不可仅为 Q1 堆架构。
- **运营限制：** Hobby 不含 MFA，必须核对既有 Cloudflare Access 身份保障是否等价；Hobby 的 7 天浏览器 Session、1 天日志保留、50k MRU、DNS/回调、在线校验配额和厂商变更风险都要在实际账户下确认。单个用户 MRU 低不代表任何 API 调用永久免费无限次。

## 六、当前裁定及下一步（不涉及用户新决策）

- **Verified：** Clerk 官方 $0/免卡及生产流程、无预设 RT 到期、offline_access + CIMD/PKCE；ChatGPT 端明确支持 CIMD/PKCE/resource；Cloudflare Portal 当前 11 上游/Access Policy 事实。
- **Verified（非生产本地 SDK）：** Clerk Backend SDK 3.27.0 的 `oauth_token` 类型限制、Audience/有效期拒绝，且用 esbuild Worker 条件打包后在真实本地 workerd 运行并验证 Scope、Owner、Issuer；共 28/28 测试 Pass。证据见 [T1b](./spec853-clerk-nonproduction-poc-20261111.md)。
- **Unknown：** Clerk Hobby 实际生产 Instance 是否无额外付费限制、是否接受 ChatGPT 所用 Client Metadata、真实 RT 是否签发/自动续期、浏览器 Session 过期后的续期、Opaque 在线校验套餐/速率、固定业务路由能否做到与既有 Access 等价。
- **Blocked：** 以 Portal 管理员机器身份聚合代理作为捷径，以及任何未获得具体生产授权的实际迁移、真实 OAuth 应用创建或 ChatGPT 重连。
- **Not Met：** 按 Cloudflare 托管 Managed OAuth 当前官方 Grant 到期契约，**纯 Portal 配置调整无法证明并实现严格 Q1**（无计划性人工重连）；Clerk 离线验证 1 天 JWT **不满足即时撤销**。
- **下一工程动作：** Clerk T1–T7 开发验证推进：42/42 本地测试与真实 ChatGPT MCP Owner 成功路径通过，隔离 Worker 当前已配置单一 Owner ID；无 Bearer/伪造 Bearer 公网 401。**真实错误 Owner 与撤销仍未执行线上负面 E2E**；Hobby Production 实际开通、正式 CIMD Client 准入、7 天浏览器 Session 对 RT 的影响、Sentry 独立工具权限和回退仍为下一阶段门禁。只有取得单独生产授权才迁移；不增加 Token 库、Cron 或高权限代理。

所有交付维度分别标记：**Docs/Nonprod Code=已更新；本地 42/42 与 GitHub CI=Pass；Clerk Development + ChatGPT >24h 实调用=Pass；独立测试 Worker Owner 成功路径=Pass；生产 Clerk 实例=未创建；Refresh Grant 明细/撤销及 7 天后连续性=Unknown；现有 Cloudflare Portal/业务生产=未改；Sentry 迁移=未执行。**

## 五、T7 只读现状及隔离 Owner 准入（2026-11-12）

- **Cloudflare 现状再回读：** 生产 Portal `mcp` 的 11 个上游 `on_behalf=false`，Cloudflare Access Portal + 多个独立 MCP App 的 `session_duration=24h` 是浏览器/Access 层配置，不等于实际 OAuth Grant TTL；现有 Portal 不直接接受 Clerk OAuth Token，不得用 Portal 级管理 Service Token 实现跨插件转发。官方 [MCP Portal 文档](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/mcp-portal/) 说明 `on_behalf=false` 使用管理员凭据，对独立插件替代方案会引入全局权限扩张。
- **Clerk 免费资格：** [Hobby 价格](https://clerk.com/pricing) 官方仍显示 $0、免信用卡、每应用 50K MRU，浏览器 Session 固定 7 天，Application Logs 保存 1 天；尚未创建 Production 实例，不将产品介绍冒充账户真实生产许可验证。OAuth Access Token 1 天，Refresh Token 无固定有效期的官方承诺与浏览器 Session 是独立概念；其在 Session 到期后能否继续刷新 **Unknown**。
- **Client admission：** 测试开发实例报告 CIMD 宣告开启、S256 PKCE 要求开启、DCR 关闭，但 `client_id_metadata_documents_only_allow_pre_registered_clients=false`，代表尚未限制未知兼容 Client。正式生产必须先明确真实 ChatGPT `client_id` metadata URL、精确回调及 Scope，**显式预注册并选择“Pre-registered clients only”**；先审查已有授权兼容性，不要在当前测试实例上贸然锁死而破坏已建立的续期会话。见 [Clerk CIMD 指南](https://clerk.com/docs/guides/configure/auth-strategies/oauth/client-id-metadata-documents)。
- **T7 单一 Owner 实现：** 只在 `spec853-clerk-oauth-lab` 无上游测试 Worker 中使用现有 Clerk SDK `authenticateRequest({acceptsToken:"oauth_token",audience:RESOURCE})`，随后对 `auth.userId` 与独立运行时 `CLERK_OWNER_USER_ID` **严格相等**，未配置、值无效、其他用户均 fail-closed。仍仅允许 `profile` 的 `lab_status` 常量工具。Owner userId 不从邮件、Header、RPC 参数或 Token 自称取得；配置项不写入仓库，Clerk Secret 仍独立注入，不打印敏感令牌。
- **实际验收：** 全部 42/42 合同+真实 Clerk SDK/本地 workerd Pass；GitHub PR #859 门禁 Pass。仅实验 Worker 的新版本 `e5bbebb9-0e73-4529-a8b9-d21d3e13b705` 承接 100%，只含 `CLERK_SECRET_KEY:secret_text` + `CLERK_OWNER_USER_ID:plain_text` 两个绑定，预览关闭。公网 PRM=200，无凭据/伪凭据=401；原 ChatGPT 插件在不重连情况下调用 `lab_status` Pass。**非 Owner/撤销真正线上 E2E 未测，不能伪记 Pass。**
- **撤销边界：** 当前 Clerk 开发实例用 Opaque OAuth Token（`oauth_jwt_access_tokens=false`），官方 [Token 格式文档](https://clerk.com/docs/guides/development/machine-auth/token-formats) 称在线验证支持即时撤销；真实撤销测试会破坏现有授权，需在另一个可恢复的独立凭据/测试连接中验证，不主动撤销当前 ChatGPT 连接。没有二级 Token 库或缓存兜底，Clerk 网络失败必须拒绝。
- **低维护迁移选择：** 能修改源码的业务 Worker 优先共用最小的 Clerk 鉴权层，并由每个 Worker 自己执行本服务工具及其后台权限；**不经过 Portal**。不能改源码的第三方 MCP（代表 Sentry）须先证明可获得**单资源、只读、最小范围**的上游认证，再条件性评估最多一个无状态适配 Worker。若只能共享 Portal 管理员身份则 Blocked，保留当前正式插件。直接访问 Worker 绝不自动继承 Cloudflare Access Policy，正式入口必须先证明 Owner、Client、Audience、Scope、工具权限与现有政策等价，未经生产授权不新开路由。
- **现有代码与 Access Policy 审核：** `packages/portal-auth/src/index.ts` 只对 `MCP_ACCESS_TOKEN` 做散列比较，并在验证成功后删除原始 `Authorization` Header；`workflow-mcp-worker`、`ssh-mcp-worker` 的 `/mcp` 入口仍依赖它，**不会识别 Clerk JWT/Opaque Token**。Access API 只读回读：Portal 有 `WORKFLOWS` Service Auth 和 Owner Email Allow；Sentry MCP App 同时有独立的 Service Auth 与 Email Allow。未来若更换直接调用链，不能简单在现有入口加入 `staticToken || ClerkToken` 的放行逻辑而暗中扩大权限，必须在明确的独立资源入口先完成所有检查并消除向上游转发原始 Clerk Bearer 的风险。其它管理、回调和定时任务入口均保持原有边界，不能被新 MCP 认证模式意外覆盖。
- **仍需单独生产授权：** Clerk Production 建立与域名/DNS、真实 ChatGPT CIMD Client 预注册和 Scope/Owner、正式业务 Endpoint、Secret 注入、Access Policy 及发布、Sentry 代表性真实业务 E2E 与回退。未完成这些，不升级 Draft PR #859 为正式生产交付。

## 六、T8 客户端预注册与 Sentry 只读准入（2026-11-12，只读与非生产）

| 必须解决的问题 | 当场核实的证据 | 准入结果 |
| --- | --- | --- |
| ChatGPT 客户端的稳定 CIMD | Clerk Development Authorization Server Metadata HTTPS 200，`authorization_response_iss_parameter_supported=true`、CIMD=true、`none`、`refresh_token`、PKCE `S256`；OpenAI 官方文档说明兼容 issuer-bound 回调可用 `https://chatgpt.com/oauth/client.json`，该公共文件 HTTPS 200、自报同名 `client_id`，回调为 `https://chatgpt.com/connector_platform_oauth_redirect`，支持 `none` 与 `private_key_jwt` | **Pass：候选客户端元数据与协议交集**；**Unknown：当前已连接 Lab 实际选用的是稳定 Client 还是特定 callback Client**。不可仅据公共元数据预判。 |
| Clerk 实例的 CIMD Client admission | 官方 Clerk API 回读开发实例 CIMD 公开、DCR=false、PKCE=true、OAuth Opaque 模式；`client_id_metadata_documents_only_allow_pre_registered_clients=false`、`client_id_metadata_documents_block_implicitly_allowed_clients=false` | **Not Met：尚未限制为预注册客户端**。Clerk 官方面板可以在 OAuth applications > Applications 列出具体 implicit Client，先对**真实已连接 Client**显式允许并限定 Scope，再将 Client admission 改为 Pre-registered clients only。此操作会改变正在使用的实验实例的权限边界；需确认真实 Client/回调及会话影响后独立执行，不先盲改。 |
| Sentry 现有服务的最小权限 | Cloudflare 只读 GET：Portal 内 `sentry` 映射 `on_behalf=false`；服务器 `https://mcp.sentry.dev/mcp`、`auth_type=bearer`、状态 `ready/connected`、**73** 个工具，包含 `create_monitor`、`delete_metric_monitor`、`update_alert_rule`、`update_issue`。现有 Sentry 连接的 read-only `find_organizations` / `find_projects` 在测试时成功返回组织和项目 | **Pass：上游及只读业务能力已辨认**；**Not Met：已有 Bearer 令牌范围不可从这些成功调用中证明只有只读 Scope**，不可复用 Portal 管理的 OAuth/Bearer 或转发全部 73 个工具。 |
| 适配层最小化 | Sentry 官方 [API Scopes](https://docs.sentry.io/api/permissions/) 可用 `org:read`、`project:read`、`event:read` 授予只读 API 请求；[认证文档](https://docs.sentry.io/api/auth/) 支持内部 Integration Token 与 OAuth。Sentry 官方完整 MCP [README](https://github.com/sentry-official/sentry-mcp) 的通用工具权限并非只读 | **设计结论：** 必须先取得单一 Sentry 组织范围内**专用只读令牌/受限 OAuth**的可验证权限与最小工具需求；若可直接替换原有安全接入则优先，只有确需第三方适配时才设计**最多一个**没有任意目标地址、仅固定 Sentry 后端与固定只读工具的 Worker。不新增 KV/D1/Token Vault 或代理全 Portal。 |
| OAuth 撤销与浏览器 Session | Clerk [OAuth 官方文档](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth) 声明 Opaque Token 可在线验证并即时撤销，Refresh Token 无固定到期，Clerk Hobby Browser Session 上限 7 天；当前 Lab SDK 合同覆盖模拟 revoked/provider-outage，实际 ChatGPT 超过 24 小时无需手动重连已 Pass | **Unknown：** 未执行真实 Clerk Grant 撤销、第二个真实非 Owner 用户授权和 7 天浏览器 Session 结束后的访问；现存 Lab OAuth 会话不可直接用破坏性撤销验证。没有这些证据不能声称长期授权/生产撤销门 Pass。 |

**当前最短前进路径：** (1) 通过 Clerk 自身合法受控界面核对当前 Lab 的确切 `client_id` 和允许回调，再对同一个 Client 显式预注册、核实已授权连接仍可调用，然后切到 Pre-registered clients only；Clerk 管理 MCP 当前不提供 Client 列表/预注册操作，先不重连也不绕过 Dashboard 的浏览器 agent-session 拒绝。(2) 明确 Sentry 首个代表性只读工具和只能访问该组织/项目的 API Token 授权路径，验证 Token 有效 Scope 与无额外写权限；目前尚无符合证据的专属令牌，**不改现有生产连接或借用 Portal 凭据**。(3) 再做非生产真实第二用户/撤销验证及 Sentry 只读最小 E2E；之后需单独生产授权才能创建 Clerk Production、配置域名、正式准入、Sentry 发布/回退。

当前以上结论均为**准备与安全审查**，不是完整生产可用性；无需再重复 T5/T6/T7 已验证的相同认证成功路径，不应为了测撤销而破坏用户唯一成功连接。

## 七、T9 LIRTUAL BrowserMCP 核实已连接的 ChatGPT CIMD Client（2026-11-12）

- **来源与环境：** 用户明确指定 BrowserMCP **LIRTUAL**（Edge、authorized/online/control-ready）；在用户已登录的 Clerk 开发实例 `mcp-workers-spec853-oauth-lab` 的 Dashboard，通过 `Configure → Developers → OAuth applications → Applications` 直接读取列表。此证据来自已存在的 Client 记录，而非仅凭公开的 `chatgpt.com/oauth/client.json` 推断。
- **Client 已确认：** 唯一可见客户端为 `ChatGPT`，类型 `CIMD`，Client ID URL 精确为 `https://chatgpt.com/oauth/client.json`，创建于 2026-11-11；客户端记录的 Scopes 为 `email`、`offline_access`、`openid`、`profile`。当前 Lab 已连接 ChatGPT 客户端使用稳定 CIMD URL 的身份核对 **Pass**，前述 T8 `actual Client ID Unknown` 为历史检查时点状态，已被本次证据取代。
- **Client admission 尚未收紧：** 在该客户端的 `Actions` 菜单可见 `Explicitly allow`，说明此客户端尚未被显式允许；与 Clerk 实例只读配置 `client_id_metadata_documents_only_allow_pre_registered_clients=false` 一致。**不能直接启用 Pre-registered clients only** 而不先为当前 Client 执行显式允许，否则可能导致现存 ChatGPT 连接失效。显式允许与全局严格模式是**两个独立状态和步骤**，各自需要回读与原插件无重连工具调用验收。
- **本轮变更边界：** 只读操作客户端列表和菜单，**未**点击 `Explicitly allow`、`Edit scopes`、`Refresh metadata` 或 `Delete`；没有修改 Clerk/ChatGPT 连接或生产业务配置、未获取或复制 Token/Secret。客户端允许与严格准入仍然 **Not Met**，需在已确认当前 Client 的基础上按非生产安全变更门执行，并另行决定是否要求生产实例显式注册。
