# Spec #853 — MCP 独立插件长期 OAuth 续期设计（2026-11-11 技术核实修订）

状态：**采用最小变更优先的事实门：先核实既有 Cloudflare MCP Portal 是否能实现无固定人工重新认证；仅在无法满足时启动 Clerk 备选。Clerk 的 Hobby Production / ChatGPT 静默刷新及安全接入仍待门禁。不得实施生产切换。** 本文替代本分支较早版本的“自建 OAuth 兜底”表述；以 [Spec #853](https://github.com/lirtual/mcp-workers/issues/853) 最新决策为准。仅技术核实、文档；没有创建 Clerk 实例、修改 Portal/Access/Worker/Secret、重连 ChatGPT 或部署。

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
| OAuth 客户端协议 | Clerk 支持 CIMD、S256 PKCE、可配置 Client admission；[CIMD GA](https://clerk.com/changelog/2026-09-17-client-id-metadata-documents-ga) 称所有 Clerk 应用可用。OpenAI [Plugins Authentication](https://developers.openai.com/plugins/build/auth) 与 [Custom MCP Server](https://developers.openai.com/api/docs/guides/custom-mcp-server) 明确 ChatGPT 支持 CIMD（`none`）、DCR、S256 和 `resource`；优先 CIMD | **Verified：双方协议支持**；**Unknown：具体 Clerk Hobby Production + 现有 ChatGPT 插件回调/Discovery 是否实际联通** |
| ChatGPT Refresh Token 续期 | OpenAI [连接说明](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt) 要求真实签发 RT，并通过元数据声明 `offline_access` 或等价刷新能力；Clerk 文档提醒 ChatGPT/Claude 可能**省略 `scope`**，此时需最小默认 Scope | **Verified：协议条件**；**Unknown：具体 ChatGPT 是否领到并成功持久保存/使用 RT、是否发生静默续期及轮换，尚无日志或 E2E** |
| Cloudflare 原生 Grant 的严格 Q1 | [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) 明确 Grant/RT 到期需要重新认证；不能由 Access App 的 24h 会话值推断真实 Grant 期限 | **Not Met：存在固定 Grant 到期且无合法自动续 Grant 证据时，不能满足“无计划性重连”**；现有实际 Grant 值仍 Unknown |
| Portal 现状只读回读 | 2026-11-11 再次只读 GET：1 个 `mcp` Portal 含 11 上游，全部 `on_behalf=false`；1 个 `mcp_portal` + 11 个 `mcp` Access App 均 `session_duration=24h`；Portal App 两条既有 Policy；App GET 没有 `oauth_configuration`。见 [T0 审计](./mcp-portal-auth-t0-20261111.md) | **Verified：以上配置字段**；**Unknown：实际 Grant、11 个独立 ChatGPT 安装的 OAuth 映射及刷新** |
| Portal 直接接受 Clerk OAuth JWT | 现有 Portal 面向 ChatGPT 使用 Cloudflare Managed OAuth，关联 Cloudflare Access Grant；`packages/portal-auth` 校验的是上游静态 `MCP_ACCESS_TOKEN`，不信任任意第三方 JWT | **Not Met：不能只把 Clerk 设为 Cloudflare 登录 IdP 或替换 Issuer 即获得长效 RT** |

**证据层级：** Clerk 文档中的“never expire”代表**没有预设自然到期**，不代表不可撤销、绝无失效或用户永不需要重新登录。正式 Hobby 账户功能、真实授权/刷新与持续可用性须另行验收，文档与一次工具调用都不能替代。

## 三、最小安全架构：先限制权限扩张，再谈免重连

### P0. 现有 Cloudflare MCP Portal 的最小变更可行性（第一优先）

- **优先仅做只读事实验证。** 按官方 Managed OAuth 文档，ChatGPT 可使用 Refresh Token 静默刷新短效 Access Token；但 Grant/Refresh Token 到期时用户须重新认证。**仅验证短期刷新，不足以满足严格 Q1**。需要 Cloudflare 官方 API/正式支持确认是否存在安全的无计划性硬到期或合法滚动 Grant 续期；不能从推荐的 1–2 周推导真实上限，也不能从 24h Access 应用会话推断 Grant 配置。
- **当前生产前置阻断。** 本账户 Access App GET 不回显 `oauth_configuration`，而官方配置接口为整对象 `PUT`；不能证明保留现有配置、读回旧 Grant、确定写入最小差异与恢复原值。**因此不允许对生产试写所谓 Grant-only 调整**。也不得临时重连插件来猜测 Grant 是否延长。
- **可执行的最小验证顺序：** (1) 只读 Cloudflare 官方 Managed OAuth/API schema、限制与是否存在滚动 Grant 机制；(2) 只读确定本账户实际配置及可回滚原值的可支持途径，平台返回缺失时记录 Unknown；(3) 获取真实 ChatGPT 刷新事件非敏感证据（触及客户端重连或生产配置时另行授权）；(4) 只有能证明 Grant 具有可持续合法续期、所有原配置可独立回读和安全恢复时，才考虑单插件生产变更授权。
- **停止条件：** Cloudflare 明确仅支持固定 Grant 且到期重新授权，则原生路线标 `Not Met（严格 Q1）`，不做生产长时长调参试验；如果官方机制仍 Unknown，保持 Portal 现状并继续非生产资料核查；若存在符合 Q1 的官方配置，优先只调整 Portal，不建 Clerk 或额外 Worker。

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
| P0：Portal 优先门 | 官方是否支持合法滚动/无固定硬到期 Grant；实际 Grant 的可靠回读、整对象 PUT 的安全恢复能力；ChatGPT 真实刷新回执是否可核实 | **当前协议资料倾向 Not Met（严格 Q1）**；实际 Grant 和安全修改仍 Unknown/Blocked。绝不以调长固定到期冒充完成 | 
| T0：Clerk 备选事实门 | Hobby $0 免卡、Production 注册要求、CIMD/PKCE/offline_access、1 天 Access Token 与无固定 RT 到期；当前 Portal 11 上游及 Access Policy | 仅当 P0 不满足时再推进 Clerk；账号级限制、Token 实例行为保持 Unknown |
| T1：非生产协议/Worker | 不使用真实生产 Token/数据，使用模拟 Clerk 风格 JWT/响应验证 issuer/exp/aud/scope/Owner、跨插件阻断、发现路由、Token/管理 Header 不泄漏、Workers Runtime 兼容与 fail-closed | **Unknown / 待 PoC**；本轮没有写代码、创建 Worker 或运行真实授权 |
| T2：权限等价性 | 不走 Portal 管理身份聚合捷径；每条后端路由、Service Auth、上游 MCP Token 独立约束且跨服务调用不可达；Opaque/在线撤销机制与计费可行 | **Blocked**，保持现有生产。不得为完成验证而允许聚合管理员权限 |
| T3：另行授权的一个真实 Sentry 插件 | 在当前 Endpoint 与可回退身份核对后，真实 ChatGPT 首次登录、`offline_access`、成功签发 RT 的**非敏感证据**、Access Token 到期后**真实刷新事件**、7 天浏览器 Session 到期仍可静默刷新；错误 Owner/aud/scope/工具拒绝、撤销后拒绝及残余窗口 | **Unknown**；单次工具成功或“等了 24h 仍能调”不等于刷新日志验收 |
| T4：长期目标 | 官方没有计划性 RT 硬到期 + 真实 ChatGPT 续期证据，未隐含付费升级/客户端注册门槛 | 达不到标 `Not Met`，不能用 90 天代替 |
| T5：逐插件迁移（另行授权） | 保留安装/开关独立；独有业务工具的授权边界、启动与只读调用逐项检查；等价共享机制的重复 E2E 标为 `Waived` 并标证据 | 任何异常停止该插件迁移，保留 Cloudflare 回退；其它插件不动 |

不为证明“几个月有效”虚构等待；但**默认 1 天 Access Token**不能在半小时演示里证明真实 Refresh，除非 Provider 有真实受支持的短 TTL/刷新事件及可核实日志。不得记录 Token 本体。

## 五、深度安全/复杂度复核

- **主要安全风险 1：** 把 Clerk 接入现有 Portal 管理机器身份会将单插件边界升级成 11 服务管理员权限。此路径当前 **Blocked**。**新链路首选直接对接原生 MCP Worker**；第三方适配必须证明后端权限被真实技术边界限制。
- **主要安全风险 2：** 长效 RT 被盗的风险更大；不使用无限期静态 Bearer 替代人类身份，Clerk 负责撤销，Cloudflare Worker 不保存 RT；按 per-resource 最小授权限制影响面。
- **主要安全风险 3：** JWT 默认存续 1 天导致撤销残余窗口；优先核实 Opaque 在线校验在 Hobby 与 Workers 的能力/成本，**不允许把失败路径放行**。
- **主要安全风险 4：** ChatGPT 可能不发送 Scope；必须核实 `offline_access` 的最小默认授权、独立工具 Scope 的实际强制检查，并避免通过默认 Scope 一次授予所有服务。
- **复杂度结论：** 不宜构建自有 OAuth 服务器、数据库或刷新服务；**Clerk + 现有 MCP Worker 共享校验模块**优先，可能无须新增 Worker。只有第三方 MCP 无法直接集成时才考虑最多一个薄适配 Worker；如果隔离需要高权限跨服务秘钥或多个代理，应停止并重新审查价值，不可仅为 Q1 堆架构。
- **运营限制：** Hobby 的 7 天浏览器 Session、1 天日志保留、50k MRU、DNS/回调、在线校验配额和厂商变更风险都要在实际账户下确认。单个用户 MRU 低不代表任何 API 调用永久免费无限次。

## 六、当前裁定及下一步（不涉及用户新决策）

- **Verified：** Clerk 官方 $0/免卡及生产流程、无预设 RT 到期、offline_access + CIMD/PKCE；ChatGPT 端明确支持 CIMD/PKCE/resource；Cloudflare Portal 当前 11 上游/Access Policy 事实。
- **Unknown：** Clerk Hobby 实际生产 Instance 是否无额外付费限制、是否接受 ChatGPT 所用 Client Metadata、真实 RT 是否签发/自动续期、浏览器 Session 过期后的续期、Opaque 在线校验套餐/速率、固定业务路由能否做到与既有 Access 等价。
- **Blocked：** 以 Portal 管理员机器身份聚合代理作为捷径，以及任何未获得具体生产授权的实际迁移、真实 OAuth 应用创建或 ChatGPT 重连。
- **Not Met：** Cloudflare Managed OAuth 固定 Grant 到期路径**尚不能证明**严格 Q1；Clerk 离线验证 1 天 JWT **不满足即时撤销**。
- **下一工程动作：** **先完成 Portal 的官方无固定 Grant 期限/合法滚动续 Grant 与安全回读能力裁定；不能证明达标不试写生产。** 仅当 P0 不满足时，再推进非生产 Clerk 资源服务器/最小权限适配验证；协议、权限、$0 与撤销机制通过后，才能提出**单个 Sentry 插件**的具体生产授权请求。其它插件暂不动。**无新增必要的用户设计决策。**

所有交付维度分别标记：**Docs=本文修订；Code=未改；CI=未执行；Clerk Production=未创建/未验收；ChatGPT Refresh=Unknown；Cloudflare Production=未改；Sentry 新 E2E=未执行。**
