# MCP Portal 长期免重连设计（Grill With Docs）

状态：第二轮设计草案；仅设计，不构成实施、生产变更或发布授权。日期：2026-11-11。

## 目标与已决策项

- Q1=A：追求正常使用期间无需计划性人工重连；短期访问令牌自动刷新。主动撤销、权限变化、异常安全事件或平台不可避免的限制可中断。
- Q2=A：保留 ChatGPT 中各 MCP 插件的独立形态和访问边界，不改为单个聚合插件。
- 不能仅以延长登录 Cookie、关闭 Access 或提供永久静态 Bearer Token 作为达标证明。
- 成功标准针对最终用户：长期使用已安装的独立 ChatGPT MCP 插件，不应因为固定日历期限而逐个重新授权。

## 已查证的事实与证据层级

### 现有生产只读配置（2026-11-11）

1. Cloudflare Access 应用列表：唯一 MCP Portal 应用 MCP 指向 mcp.lirtual.dpdns.org，其 Access application.session_duration=24h；另有 11 个 type=mcp 应用，其 application.session_duration 均为 24h。
2. MCP Portal /mcp 当前挂载 11 个上游；逐项 on_behalf=false，表示 Portal 使用预置的上游认证而不是对每个上游要求用户 OAuth。列表 ready 不等于终端用户认证 E2E 成功。
3. Access GET 响应没有返回 oauth_configuration 字段，故不能根据缺席推断 Managed OAuth 未启用、Grant 期限或实际 Access Token 期限。24h application.session_duration **不能直接等同**于 OAuth grant.session_duration。
4. 先前从 Portal 公开的 OAuth 授权服务发现信息成功读到 grant_types_supported 包含 authorization_code 和 refresh_token，scopes_supported 未返回；本轮不同客户端再次请求发现端点收到 403，因此应将发现元数据的稳定可访问性、离线 Scope、实际发放 Token 类型视为待验证，不得将静态字段支持误认成已成功续期。
5. 仓库共享 packages/portal-auth/src/index.ts 使用 MCP_ACCESS_TOKEN 固定 Bearer 入口鉴权，不提供 ChatGPT 侧 OAuth Server 或 Refresh Token 管理功能。不能通过改动该包来推断修复 ChatGPT 客户端续期。
6. docs/ingress-policy.md 已约束各 MCP 应用 Access Policy（包括 Browser 专属例外），任何后续调整不能弱化这些现有安全边界。

### 官方产品契约（截至 2026-11-11）

- Cloudflare Managed OAuth：Access Token 建议 5–15 分钟；Grant session duration 是 Refresh Token 保持有效的期限，官方示例为 1–2 周。Access Token 到期可刷新并重评 Access Policy，**Grant 到期则必须重新认证**；这不等于无上限滚动续期。文档：https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
- Cloudflare MCP Portals：新的 Portal 默认支持 Managed OAuth，2026-07-28 无状态 MCP 请求关联到用户授权 Grant；旧版客户端还存在 24 小时无活动过期的会话机制，不能混淆。文档：https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/
- OpenAI 自定义 MCP：连接需要实际取得可持续续期的 Refresh Token；官方要求 OIDC/OAuth 的 discovery 能声明 offline_access 或等价刷新能力，并在必要时重新创建已发现旧元数据的应用。不提供“任意 OAuth 服务必然永久自动刷新”的保证。文档：https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- 以上是官方机制支持边界，不是针对这 11 个 ChatGPT 插件已经完成的成功刷新 E2E 证据。

## 设计约束与不应采用的捷径

- 保持 Cloudflare Portal 及当前每个上游的 Access Policy、精确 Owner 访问范围、服务令牌绑定和操作权限。不能为了免登录改为 Everyone、Bypass 或向 ChatGPT 暴露 Cloudflare 服务令牌。
- 不将上游的固定 MCP_ACCESS_TOKEN 放入 ChatGPT 插件，也不把持久有效的明文静态 Token 当成人类身份认证。
- 明确区分四个时钟：Access 应用登录会话、OAuth Access Token、OAuth Refresh Token/Grant、MCP 协议会话。问题归因须有实际重连错误或令牌刷新验证。
- 独立插件意味着独立客户端 OAuth 授权状态，不承诺同一 Portal 浏览器登录就能在 ChatGPT 自动修复所有插件；如需重新创建插件，应按受影响插件逐个确认，但尽可能避免重复迁移。
- 后备 OAuth 代理如果使用 Portal service-token 凭据，本质上扩大了高权限机器身份，必须先论证完整用户身份验证、作用域、撤销、审计与托管泄露风险，不能把它当成默认轻量方案。

## 最小方案序列（待第二轮决策后收敛）

1. 仅只读确认实际 Portal 的 OAuth 授权服务元数据可发现性、Grant 配置读取途径、OAuth Token 的签发与刷新能力，区分配置已知、推断和未知；不采集或打印令牌。
2. 先评估是否只需 Cloudflare 原生 OAuth 的配置调整和 ChatGPT 一次性重新发现，即可在既定安全边界内显著改善使用体验；“两周免登录”不能冒称“长期免计划性重连”。
3. 对一款低风险独立插件执行代表性 ChatGPT Refresh Token E2E（未来需另行生产授权）。至少覆盖短期 Access Token 过期后的静默刷新、插件仍可用、错误授权与撤销后拒绝；Grant 硬过期应分别模拟/按实际观察，不伪造覆盖证据。
4. 如果原生方案存在不可消除的定期 Grant 到期，严格目标 Q1=A 需要单独评估自托管长效授权/刷新边界是否值得其维护与安全成本；在完成这种取舍前不实施、不引入新服务。
5. 验证代表性机制后按独立客户端分批迁移；无证据时不得把 11 个插件的认证状态统一称为 Pass。

## 第二轮未决决策（等待用户选择）

- Q3 兜底授权边界：A（推荐）原生优先；如证实硬期限不可满足 Q1，再单独设计和审查最小自托管 OAuth 兜底（不自动批准新服务）。B 永久限制在 Cloudflare 原生方案内，即接受 Grant 硬过期时必须重新登录，与严格 Q1=A 存在差距。
- Q4 一次性迁移节奏：A（推荐）先一个低风险插件真实验证续期，然后分批处理剩余独立插件；允许必要的一次性重新授权/重新创建。B 同时切换所有插件，减少步骤但提高故障扩散和回退风险。

## 验收与变更边界

- 设计与源代码：此轮仅文档；不修改 Worker、Cloudflare、ChatGPT 插件或任何 OAuth Client/Secret。
- 任何未来生产改动：须另行明确授权对象、范围、凭据安全性和回退条件。
- 强制检查：已安装插件不丢失、不越权，Access Policy 无变化，错误令牌拒绝、撤销即时生效，Token 刷新不需要用户操作；只有真实 ChatGPT 调用能证明客户端侧连接是否保留。
- 无法证实无限期续期时，结论必须明确标记为受 Grant 生命周期限制，而不是宣称永久可用。

## 相关仓库契约

- packages/portal-auth/src/index.ts
- docs/ingress-policy.md
- CONTEXT-MAP.md
