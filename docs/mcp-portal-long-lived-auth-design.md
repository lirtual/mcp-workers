# Spec #853 — MCP 独立插件长期 OAuth 续期设计（2026-11-11 技术核实修订）

状态：**技术设计已收敛；Clerk 官方协议契约可行，实际 Hobby Production / ChatGPT 静默刷新 / Cloudflare 无特权扩张接入仍待门禁。不得实施生产切换。** 本文替代本分支较早版本的“自建 OAuth 兜底”表述；以 [Spec #853](https://github.com/lirtual/mcp-workers/issues/853) 最新决策为准。仅技术核实、文档；没有创建 Clerk 实例、修改 Portal/Access/Worker/Secret、重连 ChatGPT 或部署。

## 一、最终约束（已决策，不再重复提问）

- Q1：首次授权后**正常使用无计划性人工重新授权**，不是 30/90/365 天硬到期；撤销、账号风险、权限调整、客户端凭据丢失或产品政策变更是明确例外。
- Q2：个人正式生产 $0，**无需绑定信用卡或付款方式**；不得以试用期或隐藏升级作为达标。
- Q3：保留每个 ChatGPT MCP 插件的独立安装、独立关闭、独立资源受众与工具权限。现有 Portal 有 **11 个上游**，但上游数不证明客户端有 11 个独立 OAuth Client/Grant。
- Q4：Cloudflare 既有接入优先；若严格 Q1 无法成立，可**有条件设计最多一个极薄、尽可能无状态的 Cloudflare Worker**。无 VPS/Docker/常驻自托管 OAuth 服务器。额外 Worker 不等于已获授权实施。
- 生产修改（含 Clerk Production 实例、DNS、Access Policy、Client、ChatGPT 插件连接、凭据、Worker 发布）必须另行精准授权。非生产代码与概念设计不得冒称生产 E2E。

## 二、证据与现状（Verified / Unknown / Not Met）

| 命题 | 来源与证据 | 裁定 |
| --- | --- | --- |
| Clerk Hobby 为 $0、免信用卡、包含正式应用 | 官方 [Pricing](https://clerk.com/pricing) 显示 Free、No credit card、每应用 50,000 MRU 限额、Custom domain 和固定 **7 天浏览器 Session**；[Production deployment](https://clerk.com/docs/guides/development/deployment/production) 要求自己的可配置 DNS 域名和生产实例 | **Verified：产品标价及生产流程**；**Unknown：本用户实际创建生产实例和 OAuth 开关的账号级限制/账单状态**，没有创建生产实例验证 |
| Clerk OAuth Token 与会话时钟 | 官方 [OAuth 实现](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth) 声明 Access Token **1 天**、Refresh Token **never expire**、Authorization Code 10 分钟；内置 `offline_access`，Discovery 可声明 `scopes_supported` | **Verified：公开产品契约**；7 天网页登录会话不等于 OAuth RT 硬过期，但仍需验证浏览器 Session 结束、退出登录和账号撤销分别对已签发 RT 的影响 |
| OAuth 客户端协议 | Clerk 支持 CIMD、S256 PKCE、可配置 Client admission；[CIMD GA](https://clerk.com/changelog/2026-09-17-client-id-metadata-documents-ga) 称所有 Clerk 应用可用。OpenAI [Plugins Authentication](https://developers.openai.com/plugins/build/auth) 与 [Custom MCP Server](https://developers.openai.com/api/docs/guides/custom-mcp-server) 明确 ChatGPT 支持 CIMD（`none`）、DCR、S256 和 `resource`；优先 CIMD | **Verified：双方协议支持**；**Unknown：具体 Clerk Hobby Production + 现有 ChatGPT 插件回调/Discovery 是否实际联通** |
| ChatGPT Refresh Token 续期 | OpenAI [连接说明](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt) 要求真实签发 RT，并通过元数据声明 `offline_access` 或等价刷新能力；Clerk 文档提醒 ChatGPT/Claude 可能**省略 `scope`**，此时需最小默认 Scope | **Verified：协议条件**；**Unknown：具体 ChatGPT 是否领到并成功持久保存/使用 RT、是否发生静默续期及轮换，尚无日志或 E2E** |
| Cloudflare 原生 Grant 的严格 Q1 | [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) 明确 Grant/RT 到期需要重新认证；不能由 Access App 的 24h 会话值推断真实 Grant 期限 | **Not Met：存在固定 Grant 到期且无合法自动续 Grant 证据时，不能满足“无计划性重连”**；现有实际 Grant 值仍 Unknown |
| Portal 现状只读回读 | 2026-11-11 再次只读 GET：1 个 `mcp` Portal 含 11 上游，全部 `on_behalf=false`；1 个 `mcp_portal` + 11 个 `mcp` Access App 均 `session_duration=24h`；Portal App 两条既有 Policy；App GET 没有 `oauth_configuration`。见 [T0 审计](./mcp-portal-auth-t0-20261111.md) | **Verified：以上配置字段**；**Unknown：实际 Grant、11 个独立 ChatGPT 安装的 OAuth 映射及刷新** |
| Portal 直接接受 Clerk OAuth JWT | 现有 Portal 面向 ChatGPT 使用 Cloudflare Managed OAuth，关联 Cloudflare Access Grant；`packages/portal-auth` 校验的是上游静态 `MCP_ACCESS_TOKEN`，不信任任意第三方 JWT | **Not Met：不能只把 Clerk 设为 Cloudflare 登录 IdP 或替换 Issuer 即获得长效 RT** |

**证据层级：** Clerk 文档中的“never expire”代表**没有预设自然到期**，不代表不可撤销、绝无失效或用户永不需要重新登录。正式 Hobby 账户功能、真实授权/刷新与持续可用性须另行验收，文档与一次工具调用都不能替代。

## 三、最小安全架构：先限制权限扩张，再谈免重连

### A. 先保持 Cloudflare Portal（当前生产基线）

保留当前 Portal、11 个上游、Owner Email Access Allow、Browser 专属 QQ-only 例外、`WORKFLOWS` Service Auth、上游 `MCP_ACCESS_TOKEN`、现有 Access 应用/Policy/Endpoint；**不触碰现有生产**。Cloudflare Managed OAuth 可作为回退基线，但若存在硬到期则只能改善周期，不能满足严格 Q1。

### B. Clerk 作为授权服务器 + 条件性一个轻量 Worker（仅候选）

只有证实无法复用既有边界且满足全部以下门禁，才允许进入非生产 PoC：

1. **OAuth 发现：** 每个独立插件一个明确且稳定的 HTTPS MCP resource URL（可以同一 Worker 不同固定路径），公开对应 `/.well-known/oauth-protected-resource/...`；`401 WWW-Authenticate` 指向正确 PRM；Authorization Server 指向 Clerk **Production Issuer**；`resource` 参数传递一致，`aud` 与请求目标精确匹配；CIMD + S256 PKCE，优先使用 Clerk 已批准的 ChatGPT CIMD Client，**关闭匿名开放 DCR**。Stable/Callback-specific CIMD Client ID 与实际回调以 ChatGPT 显示值为准，不猜。
2. **身份与工具：** 每个请求校验 Clerk issuer、签名/有效性（或在线 introspection）、`exp`、`aud`、`scope`、精确已审批 Owner `sub`；email 仅作账号关联辅助，不能用未验证的邮箱字符串代替 `sub`。每个资源**固定允许工具和单一后端**，不可通过请求参数、Header、工具名或任意 URL 指向别的插件。独立插件相同 ChatGPT CIMD `client_id` **不是**权限隔离凭据，必须以 audience + scope + 后端 allowlist 构成实际隔离。
3. **撤销与失败行为：** Clerk 默认 **1 天 JWT 不能即时撤销**；[revokeToken](https://clerk.com/docs/reference/backend/oauth-applications/revoke-token) 与 [Token formats](https://clerk.com/docs/guides/development/machine-auth/token-formats) 明确 JWT 撤销受限制。Spec #853 若要求及时撤销，需要优先验证 **Opaque Access Token + Clerk 在线验证**能否在 Hobby Production 使用、能否在 Cloudflare Worker 安全高效调用；网络失败要 fail-closed。不允许把纯离线 JWT 验证直接宣称撤销即时生效；若 Opaque 不可行，单独裁定剩余 24h 风险，不静默降低验收标准。
4. **后端权限：** **禁止把 Portal 管理 OAuth/Service Token、上游静态 Bearer 下发给 ChatGPT**。现有 11 上游 `on_behalf=false` 会在服务端使用管理凭据。用单个高权限 Service Token 调用整个 Portal 会放大误用影响，且 Portal 侧用户工具选择未被证实为强隔离：**这条捷径暂记 Blocked**。需要证明每条固定路由实际上只有该业务服务的最小能力；如不能通过具备独立限制的 Service Binding/受限上游令牌实现，则不得构建这个代理。
5. **Cloudflare Access 不能弱化：** 不新增 Everyone/Bypass，不改变 `docs/ingress-policy.md` 的既有 Owner、Browser 专属例外与 Service Auth 规则；要证明新信任路径**等价或更严格**，包括 Worker 直接经 Service Binding 访问上游时是否绕过现有 Access 人类权限门。任何无法解释的跨插件调用均 fail-closed。
6. **最少状态和运维：** 仅验证/转发/最小审计，不自发签发 Refresh Token，不存 Token，不新增 KV/D1/DO、Cron、轮换器、长期会话数据库或第二层 OAuth。Clerk 负责 RT；ChatGPT 负责持有与刷新；Worker 不应承担 Token Vault 工作。Clerk 生产所需的独立 Frontend API DNS 是供应商硬要求，不能把这误写成“无需任何 DNS”。
7. **受限日志：** 只保存必要请求结果/拒绝原因/固定目标标识和相关性 ID，不记录 Token、Authorization Code、敏感身份或管理凭据。Opaque 在线校验的速率限制、延迟、异常策略与 $0 配额是准入门而非默认忽略。

最小概念数据流：

```text
独立 ChatGPT 插件（各自 MCP URL / resource / scopes）
    -> Clerk OAuth 2.1 / CIMD / PKCE / offline_access
    -> ChatGPT 保存 OAuth Refresh Token；到期由 ChatGPT 主动 Refresh
    -> [条件候选] 单个 Cloudflare Worker：Token 校验、Owner、受众、Scope、
       每插件固定 allowlist 与最小后端路由
    -> 仅被许可的 MCP Worker 工具（保留原业务权限）
```

**不推荐：** Clerk 仅作为 Cloudflare Access 的上游 IdP；把 Client 直接指向 Portal 管理员 Service Token；11 个插件共享一个无服务级授权约束的聚合代理；为方便登录而取消 Policy；自行编写长期 Refresh Token 服务器。

## 四、最短验证路径及硬停止条件

| 门 | 必须得到的真实证据 | 未通过时 |
| --- | --- | --- |
| T0：官方/配置 | Hobby $0 免卡、Production 注册要求、CIMD/PKCE/offline_access、1 天 Access Token 与无固定 RT 到期；当前 Portal 11 上游及 Access Policy | 已完成官方层及 Portal 配置只读层；账号级限制、Token 实例行为保持 Unknown |
| T1：非生产协议/Worker | 不使用真实生产 Token/数据，使用模拟 Clerk 风格 JWT/响应验证 issuer/exp/aud/scope/Owner、跨插件阻断、发现路由、Token/管理 Header 不泄漏、Workers Runtime 兼容与 fail-closed | **Unknown / 待 PoC**；本轮没有写代码、创建 Worker 或运行真实授权 |
| T2：权限等价性 | 不走 Portal 管理身份聚合捷径；每条后端路由、Service Auth、上游 MCP Token 独立约束且跨服务调用不可达；Opaque/在线撤销机制与计费可行 | **Blocked**，保持现有生产。不得为完成验证而允许聚合管理员权限 |
| T3：另行授权的一个真实 Sentry 插件 | 在当前 Endpoint 与可回退身份核对后，真实 ChatGPT 首次登录、`offline_access`、成功签发 RT 的**非敏感证据**、Access Token 到期后**真实刷新事件**、7 天浏览器 Session 到期仍可静默刷新；错误 Owner/aud/scope/工具拒绝、撤销后拒绝及残余窗口 | **Unknown**；单次工具成功或“等了 24h 仍能调”不等于刷新日志验收 |
| T4：长期目标 | 官方没有计划性 RT 硬到期 + 真实 ChatGPT 续期证据，未隐含付费升级/客户端注册门槛 | 达不到标 `Not Met`，不能用 90 天代替 |
| T5：逐插件迁移（另行授权） | 保留安装/开关独立；独有业务工具的授权边界、启动与只读调用逐项检查；等价共享机制的重复 E2E 标为 `Waived` 并标证据 | 任何异常停止该插件迁移，保留 Cloudflare 回退；其它插件不动 |

不为证明“几个月有效”虚构等待；但**默认 1 天 Access Token**不能在半小时演示里证明真实 Refresh，除非 Provider 有真实受支持的短 TTL/刷新事件及可核实日志。不得记录 Token 本体。

## 五、深度安全/复杂度复核

- **主要安全风险 1：** 无限制 Portal Service Token 会将单插件边界升级成 11 服务管理员权限。此路径当前 **Blocked**，不是实施建议；必须先证明后端权限被真实技术边界限制。
- **主要安全风险 2：** 长效 RT 被盗的风险更大；不使用无限期静态 Bearer 替代人类身份，Clerk 负责撤销，Cloudflare Worker 不保存 RT；按 per-resource 最小授权限制影响面。
- **主要安全风险 3：** JWT 默认存续 1 天导致撤销残余窗口；优先核实 Opaque 在线校验在 Hobby 与 Workers 的能力/成本，**不允许把失败路径放行**。
- **主要安全风险 4：** ChatGPT 可能不发送 Scope；必须核实 `offline_access` 的最小默认授权、独立工具 Scope 的实际强制检查，并避免通过默认 Scope 一次授予所有服务。
- **复杂度结论：** 不宜构建自有 OAuth 服务器、数据库或刷新服务；Clerk 授权 + 最多一个验证/路由 Worker 是可研究的复杂度上限，不是当下已验证的最佳实现。如果隔离需要 11 组高权限秘钥或多个代理，应停止并重新审查价值，不可仅为 Q1 堆架构。
- **运营限制：** Hobby 的 7 天浏览器 Session、1 天日志保留、50k MRU、DNS/回调、在线校验配额和厂商变更风险都要在实际账户下确认。单个用户 MRU 低不代表任何 API 调用永久免费无限次。

## 六、当前裁定及下一步（不涉及用户新决策）

- **Verified：** Clerk 官方 $0/免卡及生产流程、无预设 RT 到期、offline_access + CIMD/PKCE；ChatGPT 端明确支持 CIMD/PKCE/resource；Cloudflare Portal 当前 11 上游/Access Policy 事实。
- **Unknown：** Clerk Hobby 实际生产 Instance 是否无额外付费限制、是否接受 ChatGPT 所用 Client Metadata、真实 RT 是否签发/自动续期、浏览器 Session 过期后的续期、Opaque 在线校验套餐/速率、固定业务路由能否做到与既有 Access 等价。
- **Blocked：** 以 Portal 管理员机器身份聚合代理作为捷径，以及任何未获得具体生产授权的实际迁移、真实 OAuth 应用创建或 ChatGPT 重连。
- **Not Met：** Cloudflare Managed OAuth 固定 Grant 到期路径**尚不能证明**严格 Q1；Clerk 离线验证 1 天 JWT **不满足即时撤销**。
- **下一工程动作：** 先完成非生产合同测试/模拟 Worker 验证及最小权限可达性证明；只有协议、权限、$0、撤销机制门禁全部通过后，才能提出**单个 Sentry 插件**的具体生产授权请求。其他插件暂不动。**无新增必要的用户设计决策。**

所有交付维度分别标记：**Docs=本文修订；Code=未改；CI=未执行；Clerk Production=未创建/未验收；ChatGPT Refresh=Unknown；Cloudflare Production=未改；Sentry 新 E2E=未执行。**
