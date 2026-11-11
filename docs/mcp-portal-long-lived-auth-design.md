# MCP Portal 长期免重连设计（Grill With Docs）

状态：历史 Q1–Q4 已确认；2026-11-11 新一轮 Q1=A（90 天）、Q2=A（免费免绑卡）、Q3=A（分批迁移）、Q4=A（条件性研究一个无状态 Workers 接入层）均已确认；本文件为设计阶段，技术可行性与客户端 E2E 待验证；T0 现场证据见 [只读预检](./mcp-portal-auth-t0-20261111.md)；不构成生产变更或发布授权。日期：2026-11-11。

## 目标与已决策项

- Q1=A：追求正常使用期间无需计划性人工重连；短期访问令牌自动刷新。主动撤销、权限变化、异常安全事件或平台不可避免的限制可中断。
- Q2=A：保留 ChatGPT 中各 MCP 插件的独立形态和访问边界，不改为单个聚合插件。
- Q3=A：Cloudflare Managed OAuth 原生优先；若证实固定 Grant 到期无法达到 Q1，再单独设计、审查最小自托管 OAuth 兜底；该选择**不授权**开发、引入持久凭据或部署新服务。
- Q4=A：选一个低风险独立插件作为真实 ChatGPT 刷新代表性验收，再分批迁移其他插件；允许必要的一次性重新授权/重建，不接受周期性手工重连成为常态。
- 不能仅以延长登录 Cookie、关闭 Access 或提供永久静态 Bearer Token 作为达标证明。
- 成功标准针对最终用户：长期使用已安装的独立 ChatGPT MCP 插件，不应因为固定日历期限而逐个重新授权。

## 已查证的事实与证据层级

### 现有生产只读配置（2026-11-11）

1. Cloudflare Access 应用列表：唯一 MCP Portal 应用 MCP 指向 mcp.lirtual.dpdns.org，其 Access application.session_duration=24h；另有 11 个 type=mcp 应用，其 application.session_duration 均为 24h。
2. MCP Portal /mcp 当前挂载 11 个上游；逐项 on_behalf=false，表示 Portal 使用预置的上游认证而不是对每个上游要求用户 OAuth。列表 ready 不等于终端用户认证 E2E 成功。
3. Access GET 响应没有返回 oauth_configuration 字段，故不能根据缺席推断 Managed OAuth 未启用、Grant 期限或实际 Access Token 期限。24h application.session_duration **不能直接等同**于 OAuth grant.session_duration。
4. 先前从 Portal 公开的 OAuth 授权服务发现信息成功读到 grant_types_supported 包含 authorization_code 和 refresh_token，scopes_supported 未返回；2026-11-11 T0 重新请求发现端点返回 200、明确支持 refresh_token，但仍缺少 scopes_supported；先前不同执行环境的 403 尚未归因，因此应将发现元数据的稳定可访问性、离线 Scope、实际发放 Token 类型视为待验证，不得将静态字段支持误认成已成功续期。
5. 仓库共享 packages/portal-auth/src/index.ts 使用 MCP_ACCESS_TOKEN 固定 Bearer 入口鉴权，不提供 ChatGPT 侧 OAuth Server 或 Refresh Token 管理功能。不能通过改动该包来推断修复 ChatGPT 客户端续期。
6. docs/ingress-policy.md 已约束各 MCP 应用 Access Policy（包括 Browser 专属例外），任何后续调整不能弱化这些现有安全边界。

### 官方产品契约（截至 2026-11-11）

- Cloudflare Managed OAuth：Access Token 建议 5–15 分钟；Grant session duration 是 Refresh Token 保持有效的期限，官方推荐非浏览器客户端使用 1–2 周。Access Token 到期可刷新并重评 Access Policy，**Grant 到期则必须重新认证**；示例周期不是本项目实际 Grant 配置，也不是已核实的最大值。公开 API schema 的 grant.session_duration 是时长字符串，未在已查字段中声明可以无期限滚动续期。文档：https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
- Cloudflare MCP Portals：新的 Portal 默认支持 Managed OAuth，2026-07-28 无状态 MCP 请求关联到用户授权 Grant；旧版客户端还存在 24 小时无活动过期的会话机制，不能混淆。文档：https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/
- OpenAI 自定义 MCP：连接需要实际取得可持续续期的 Refresh Token；官方要求 OIDC/OAuth 的 discovery 能声明 offline_access 或等价刷新能力，并在必要时重新创建已发现旧元数据的应用。不提供“任意 OAuth 服务必然永久自动刷新”的保证。文档：https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- 以上是官方机制支持边界，不是针对这 11 个 ChatGPT 插件已经完成的成功刷新 E2E 证据。

## 设计约束与不应采用的捷径

- 保持 Cloudflare Portal 及当前每个上游的 Access Policy、精确 Owner 访问范围、服务令牌绑定和操作权限。不能为了免登录改为 Everyone、Bypass 或向 ChatGPT 暴露 Cloudflare 服务令牌。
- 不将上游的固定 MCP_ACCESS_TOKEN 放入 ChatGPT 插件，也不把持久有效的明文静态 Token 当成人类身份认证。
- 明确区分四个时钟：Access 应用登录会话、OAuth Access Token、OAuth Refresh Token/Grant、MCP 协议会话。问题归因须有实际重连错误或令牌刷新验证。
- 独立插件意味着独立客户端 OAuth 授权状态，不承诺同一 Portal 浏览器登录就能在 ChatGPT 自动修复所有插件；如需重新创建插件，应按受影响插件逐个确认，但尽可能避免重复迁移。
- 后备 OAuth 代理如果使用 Portal service-token 凭据，本质上扩大了高权限机器身份，必须先论证完整用户身份验证、作用域、撤销、审计与托管泄露风险，不能把它当成默认轻量方案。

## 已确定的最小方案与实施前调查

1. 仅只读确认实际 Portal 的 OAuth 授权服务元数据可发现性、Grant 配置读取途径、OAuth Token 的签发与刷新能力，区分配置已知、推断和未知；不采集或打印令牌。
2. 先评估是否只需 Cloudflare 原生 OAuth 的配置调整和 ChatGPT 一次性重新发现，即可在既定安全边界内显著改善使用体验；“两周免登录”不能冒称“长期免计划性重连”。
3. 对一款低风险独立插件执行代表性 ChatGPT Refresh Token E2E（未来需另行生产授权）。至少覆盖短期 Access Token 过期后的静默刷新、插件仍可用、错误授权与撤销后拒绝；Grant 硬过期应分别模拟/按实际观察，不伪造覆盖证据。
4. 如果原生方案存在不可消除的定期 Grant 到期，严格目标 Q1=A 需要单独评估自托管长效授权/刷新边界是否值得其维护与安全成本；在完成这种取舍前不实施、不引入新服务。
5. 验证代表性机制后按独立客户端分批迁移；无证据时不得把 11 个插件的认证状态统一称为 Pass。

## 设计决策树与后置条件

- 本轮已确定 Q1=A、Q2=A、Q3=A、Q4=A；**目前没有必要的新增用户设计决策**。后续事实判断由工程核查完成，不要求用户猜测 OAuth 运行方式。
- 前置事实门：获取 Cloudflare Access 当前 OAuth Grant 的真实配置/默认值、确认端点对 ChatGPT 可发现、是否签发 Refresh Token、ChatGPT 是否能持续刷新、是否有固定无法延长的到期边界。公开 GET 缺少 oauth_configuration 时不得假定默认值；不得用正常 24h Access session 代替 Grant 证据。
- 如果原生能够达到 Q1，优先只做最小配置与必要的一次性插件重新发现；不引入独立 OAuth 服务。
- 如果原生只能将人工重新登录延长到某个固定期限，应明确归类为**体验改善但目标未达成**；再对最小自托管兜底进行单独的安全、复杂度、滥用和维护成本评估。自托管也必须可撤销、最小权限、密钥隔离，不能以永久不失效的静态 Token 代替人类授权，更不能把单个 Portal 管理员 Service Token 直接发给 ChatGPT。
- 如确需自托管兜底且涉及新增长期身份授权边界，需先提交新的具体风险和折中供用户确认；Q3=A 不意味着不经授权即可部署该方案。
- 未来实施前决定低风险的代表性插件，先读取/工具列表/安全拒绝验收，不对生产数据或外部服务产生副作用；代表性刷新机制成功后逐插件验收独有连接范围，重复共享机制标记 Waived 而不是 Pass。

## 非目标和剩余不确定性

- 本文并不证明 ChatGPT 对 Cloudflare OAuth 长期续期已经可用，也不保证第三方 OAuth 客户端提供无期限 Refresh Token；最终能力依赖客户端、授权服务器与产品政策共同支持。
- 暂不为该设计增加 D1/KV/DO/后台定时器、Token 轮换服务、独立网络入口、额外 Access 策略或其他运维组件。
- 设计阶段不进行改变实际 OAuth Grant 的写操作，也不触碰任何真实 Refresh Token 或登录凭据。

## 验收与变更边界

- 设计与源代码：此轮仅文档；不修改 Worker、Cloudflare、ChatGPT 插件或任何 OAuth Client/Secret。
- 任何未来生产改动：须另行明确授权对象、范围、凭据安全性和回退条件。
- 强制检查：已安装插件不丢失、不越权，Access Policy 无变化，错误令牌拒绝、撤销后拒绝及既有 Access Token 残余窗口须实测，Token 刷新不需要用户操作；只有真实 ChatGPT 调用能证明客户端侧连接是否保留。
- 无法证实无限期续期时，结论必须明确标记为受 Grant 生命周期限制，而不是宣称永久可用。

## 相关仓库契约

- packages/portal-auth/src/index.ts
- docs/ingress-policy.md
- CONTEXT-MAP.md

## 2026-11-11：新的 Grill With Docs 第一轮（最新决定优先）

本节优先于上文历史 Q1–Q4；仍处于**只读设计**，不得变更生产、OAuth 配置或 ChatGPT 连接。

### 新的约束与验收边界

- 新 Q1=A：正常使用时**至少 90 天不需要计划性人工重新认证**；安全撤销、授权失效、账号风险和平台故障可例外。90 天目标尚非事实，不得以一次登录成功或短期调用替代生命周期验证。
- 新 Q2=A：个人生产使用必须优先 **$0，且无需信用卡/付款方式**；免费 Staging 不等于生产免费可用。
- 新 Q3=A：允许一次性可恢复的分批授权迁移；**保留 11 个独立 ChatGPT MCP 插件**，不合并。
- 不维护 VPS、Docker 或其他常驻托管服务器。仅在证明必要且不损害安全时评估复用现有 Cloudflare Workers 能力。
- 保留精确 Owner 身份、原 Access/上游权限、Audience/Scope 隔离与 fail-closed；不允许 Bypass/Everyone，不向 ChatGPT 共享管理员 Service Token、Worker MCP_ACCESS_TOKEN。

### 托管供应商事实核实：截至 2026-11-11

| 方案 | 正式生产 $0 / 无绑卡 | 客户端 OAuth | Refresh Token 生命周期 | 结论 |
| --- | --- | --- | --- | --- |
| WorkOS AuthKit + Connect | **不符合**：Staging 免费且免付款方式，但 Production 明确要求添加 Billing/Payment Method，即使低于 100 万 MAU 免费额度 | 支持 DCR/CIMD、offline_access | Connect 当前无自动最长有效期或闲置期限 | 因新 Q2=A 排除正式生产候选，不以 Staging 冒充正式方案 |
| Auth0 Free / Auth for MCP | 官方 Free $0、无需信用卡注册、25,000 MAU，Auth for MCP Included；免费 Custom Domain 仍需要信用卡验证，不使用自定义认证域名 | 支持 PKCE、第三方 CIMD/DCR、Resource Parameter Compatibility Profile、refresh_token，需显式 Client Grant 与授权 Scope | **严格第三方应用的 Refresh Token 必须设置到期时间，不能设无限绝对/无限闲置**；免费租户能否配置至少 90 天及其上限未核实 | 当前最值得核实，但**尚未证明 90 天达标** |
| Cloudflare 原生 Managed OAuth | 现有 $0、维护最少 | 原连接可用，Sentry 只读通过 | 官方规定 Grant 到期后需要新授权；当前详情为跟随 24h 会话，安全编辑路径阻断 | 保留生产现状，不继续盲写 Grant |

官方来源：
- https://workos.com/pricing
- https://workos.com/docs/authkit/environments
- https://workos.com/docs/dashboard/billing
- https://workos.com/docs/authkit/mcp
- https://auth0.com/pricing
- https://auth0.com/docs/get-started/applications/third-party-applications/security-controls
- https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0
- https://developers.openai.com/plugins/build/auth
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/

特别注意：Auth0 普通第一方应用关闭 Refresh Token 绝对到期的文档 **不适用于** ChatGPT 经 CIMD/DCR 注册的严格第三方客户端；Auth0 Free 不包含名为 Long Lived Sessions 的高级计划能力，但浏览器 Session 生命周期又不能直接等同 OAuth Refresh Token 生命周期。两个事实都不能被误读成 90 天肯定满足或肯定不满足。

### 现有项目架构与不能走的捷径

1. Cloudflare MCP Portal 当前由 Cloudflare Access Managed OAuth 保护；把 Auth0 配成 Cloudflare 的上游登录身份提供商只会改变交互式登录来源，**不改变 ChatGPT 侧 Cloudflare OAuth Grant 的到期机制**。
2. 仓库 packages/portal-auth/src/index.ts 通过 MCP_ACCESS_TOKEN 处理 **Portal 到上游 Worker** 的固定 Bearer 认证，并未实现 **ChatGPT 到 Portal** 的 OAuth。现有 Portal 11 个 upstream 的 on_behalf=false 不等于 11 个独立 ChatGPT OAuth Client。
3. 现有 Portal 无法直接接受并校验 Auth0 发行的用户 Bearer。真正替换发行者需要有我们控制的 MCP 资源入口，校验 issuer、JWKS 签名、audience/resource、exp、scope 与精确 Owner；同时保留每个独立插件的工具访问隔离。
4. 两个待验证的技术轮廓：**一个共享轻量 Cloudflare Workers JWT 接入/路由层**，或 **11 个入口复用共享 JWT 验证代码**。前者可能有管理员服务凭据放大、Portal 工具隔离与绕过 Access 的重大风险，后者有变更面和维护成本。均未确定为可实施方案；不能为了减少人工登录降低原权限边界。
5. 未来 PoC 必须先取 Sentry 真实插件的 Resource、OAuth Client、允许工具范围等非敏感映射；短 Access Token 真实自动刷新、错 Owner/Audience/Scope 拒绝、撤销后的残余访问窗口逐项验证；仅声明支持 Refresh Token 不等于 ChatGPT 已经收到和成功轮换。
6. 90 天指标需由产品契约与可核实的长期轮换规则支撑；无需假装已运行 90 天的 E2E。Auth0 第三方默认值、Free 上限仍 Unknown 时，不应锁定供应商或扩展到其余插件。

### 第二轮 Q4 决策（2026-11-11 已确认）

**Q4=A：允许条件性研究最多一个轻量、尽可能无状态的 Cloudflare Workers OAuth 接入层；不是实施许可或必须使用它。**

- A（推荐）：若不能安全直接复用当前入口，允许研究**最多一个共享、尽量无状态**的 Workers 适配入口，必须先证实独立资源/工具隔离和服务凭据边界；**只授权设计，不授权部署**，不默认引入 KV/D1/DO。
- B：不允许增加任何 Worker/入口/域名，只接受现有配置或共享代码的修改；如第三方 OAuth 不能安全接入，则停止迁移并保留现状，不采用 Bypass/永久静态 Token。

Q4 已选择 A，另一选项留作历史候选。Free 实际限制、90 天期限与独立插件权限边界仍是工程核实事项。技术路线未决，**不建立 ADR**；旧 T0 审计证据和 Unknown/Blocked 结论不变。


### Q4=A 后的官方核实与架构门禁（2026-11-11）

- **费用与生产资格**：Auth0 [Free 定价](https://auth0.com/pricing)为 $0、无需信用卡注册、25,000 MAU，比较表明确 Auth for MCP 已包含。Free 的自定义认证域名需要信用卡验证，初期只能使用默认 tenant 域。WorkOS [生产环境](https://workos.com/docs/authkit/environments)需要 Billing，Q2=A 排除其生产路线。
- **至少 90 天仍需真实验证**：Auth0 [Refresh Token Expiration](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-expiration)和 [Rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-rotation)说明一般应用的绝对/闲置期限可配置，当前文档给出约一年的最大值（31,557,600 秒），**轮换不会延长 Token family 的绝对有效期**；但 [strict 第三方应用](https://auth0.com/docs/get-started/applications/third-party-applications/security-controls)不允许永不过期或无限闲置期。必须核实 Free + strict third-party + ChatGPT 的实际配置上限、默认值和是否支持 >=90 天；不能仅凭普通应用文档宣称通过。
- **ChatGPT / MCP 接入**：[OpenAI 官方要求](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)实际发放可用 Refresh Token、通过 discovery 宣告 offline_access 或等价能力。[Auth0 strict 第三方规则](https://auth0.com/docs/get-started/applications/third-party-applications/security-controls)要求 PKCE 和明确 API client grant；[官方支持说明](https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0)要求启用 Resource Parameter Compatibility Profile，避免 RFC 8707 resource 参数导致错误 audience。
- **注册安全优先 CIMD**：Auth0 [Auth for MCP GA](https://auth0.com/blog/auth0-auth-for-mcp-servers-generally-available/)支持 CIMD 与 DCR，优先设计受控导入 ChatGPT 的 CIMD，而不是允许任何未认证客户端在 Auth0 Tenant 创建应用的 [Open DCR](https://support.auth0.com/center/s/article/Dynamic-Client-Registration)。2026-10 至 11 月的 [社区 ChatGPT CIMD 兼容反馈](https://community.auth0.com/t/auth0-cimd-registration-appears-incompatible-with-the-current-chatgpt-client-id-metadata-document/203817)显示曾经失败、月底有成功修复反馈、11 月仍出现失败案例；属于实测必要门禁，不能为绕过注册故障默认开启 Open Registration。
- **项目拓扑安全门禁**：Cloudflare MCP Portal 当前的 Managed OAuth 不会因为上游 IdP 改成 Auth0 而失去固定 Grant 限制。若采用边缘接入层，必须在向 Portal/上游请求之前验证 JWT issuer、signature/JWKS、audience/resource、exp、scope、精确 Owner、每独立插件工具范围；不得把单个覆盖 11 个上游的管理员机器身份转发能力无条件授予任一已登录的用户。特别需要核实 Portal 作为下游时能否安全保留每插件的工具隔离与原 Access 策略；无法证明等价则停止该选项，不通过 Bypass 或永久静态 Token 改道。
- **验收分层**：访问令牌短期静默刷新要有 ChatGPT 真实 E2E；90 天目标基于可核实的发行规则、Free 配置和到期条件判断，不把数分钟 PoC 说成 90 天已实测。优先满足 >=90 天的最小合理风险期限，不因为官方通用上限约一年就默认直接设置一年。
- **事实优先，暂无新用户决策**：在 Free strict third-party 有效期和安全接入 Portal 的可行性核实前，不继续追问用户选择 OAuth 字段、储存服务或新增 Worker 配置。任何高权限代理/放宽 Access 策略均属于重大安全风险，不以 Q4=A 默认授权。

**当前阶段**：Q1–Q4 已写入文档；免费生产可用的长期 Refresh Token、独立插件隔离及 ChatGPT 静默刷新未通过实测。未经授权不得新增身份系统或生产资源。

### 变更边界

本轮只允许 Docs 分支，不能修改 main、发布生产、变更 Cloudflare/Access/Portal、Secrets、Auth0/WorkOS 生产设置或 ChatGPT 插件。实施前需单独授权 Sentry 代表性 PoC 的目标 Endpoint、范围、风险和回退。
