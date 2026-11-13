# MCP 独立插件长期 OAuth 与统一接入设计（Grill With Docs）

状态：**Grill With Docs 两轮决策已达成共识（2026-11-14）**；后续架构取舍仍以只读事实与安全验证为前提。此文档更新已验证的生产现状与设计边界，**不授权实施、发布、迁移插件、修改 OAuth/Access/Portal/Secrets 或生产数据**。问题及验收记录见 [Spec #853](https://github.com/lirtual/mcp-workers/issues/853)。

## 目标与既定约束

最终用户目标不是“所有请求必须经过 Clerk”，而是：ChatGPT 中多个 **独立 MCP 插件** 在首次连接后尽可能持续自动续期，不因固定期限而计划性逐个重登；仅在撤销、权限变化、风险、客户端令牌丢失或真实故障时重新登录。不能承诺永不重新登录，也不能把浏览器 Session、OAuth Access Token、Refresh Token/Grant 和 MCP Session 当成同一个期限。

新增上游 MCP 应尽量只登记地址、认证类型、凭据及最小权限，**不因自建或第三方而区别处理，也不修改第三方源码**。现有 Cloudflare MCP Portal、已有 Worker、Clerk Production 及项目 CI/发布流程应优先复用。保持个人可承受的免费、免绑信用卡与 Serverless 约束；没有必要不新增项目、数据库、Token Vault、Cron、长期进程或管理界面。

### 2026-11-14 第一轮已确认决定

- **Q1=A，权限隔离**：每个 ChatGPT 插件独立 Resource/Audience、授权和业务工具边界。某个插件认证成功不代表可以访问其它上游或获得跨服务的管理员权限；不能仅依赖界面显示隐藏工具来假设安全隔离。
- **Q2=A，第三方首次授权**：可接受第三方 MCP 在首次连接时按需完成一次自己的 OAuth 授权；Clerk 管理客户端到入口的 OAuth，不能替第三方签发上游授权。后续自动刷新取决于各自协议和真实能力，不能保证第三方永久免重登。
- **Q3=A，分批迁移**：保留现有连接与回退路径；先用 Raindrop、Sentry、Git Guardian 等代表性服务验证通用机制，再逐个迁移。共享实现、版本、配置和安全边界等价时可复用验收，独有的权限及工具调用必须单独验证。

### 2026-11-14 第二轮已确认决定

- **Q4=A，按需扩展上游认证**：首批只针对已有真实样本的 Bearer MCP 建立最小通用接入；Custom Headers 与 None 可优先使用 Portal 原生配置，遇到实际接入对象时进行必要的权限和协议验证。产品能力覆盖不等于本项目实现或验收全部认证方式。
- **Q4 补充：上游 OAuth 仅低成本复用时支持**：不为了“形式上支持全部认证”开发新 OAuth 授权服务器、Token Vault、刷新服务或周期任务。Portal 已支持 OAuth DCR 与手动客户端配置；但若 Clerk Gateway 到 Portal 只能走机器 Service Token，则 Portal 的用户级上游 OAuth（`on_behalf=true`）无法直接复用。必须有安全的实际路径，并评估首次同意、Refresh Token 的归属/撤销和凭据范围；否则明确标记 **Deferred / Unsupported in first phase**，保留原生直连或原 Portal 方案，不把管理员 OAuth 授权静默替换成用户 OAuth。
- **Q5=A，不增加管理 UI**：优先沿用 Cloudflare Portal 的 MCP 注册和凭据管理，以及既有仓库配置、CI 和发布流程。新界面、单独仓库、身份系统、数据库等均需先证明真实缺口和明显的维护收益。
- **决策顺序**：先验证“单个 Clerk Resource → 单个被允许的 Portal 上游”的执行权限与凭据边界，再决定是否有必要在同仓库新增一个薄 Worker；不能以单个拥有所有上游权限的 Service Token 作为默认方案。

与此前 Spec #853 的长期目标保持一致：CIMD 仅允许已预注册 ChatGPT 客户端、PKCE、明确 Owner、拒绝无效/过期/跨资源 Token、Refresh Token 不进入日志或聊天、不开放匿名 DCR 或 Everyone/Bypass，不向 ChatGPT 下发 Portal 或上游机器凭据。

## 已核实的实现与生产状态

1. Cloudflare 账号现有 **1 个 Portal（mcp.lirtual.dpdns.org）、11 个上游 MCP**；2026-11-14 只读回读全部 Ready、认证类型为 **Bearer** 且挂载均为 **on_behalf=false**。上游包括 Raindrop、Sentry、Git Guardian 等。这是 Portal 的上游配置数量，**不代表 ChatGPT 安装插件数、OAuth Grants 或独立 Client 的数量**。
2. 当前 Portal 已承担上游 MCP 注册、工具枚举/选择、转发及预置上游凭据管理。Cloudflare 的产品层支持多种上游认证模式（例如 OAuth、Bearer、Custom Headers、None），但上述 **11 个实际生产上游仅有 Bearer 配置证据**；不能把产品支持等同于这些模式已在本项目验收。Portal 是否能够直接验证外部 Clerk OAuth、按每个独立 Resource 安全转发并保持长期客户端 Refresh，**尚未证实**。
3. 现有 Raindrop Worker 将 Portal Bearer 入口 /mcp 与独立 Clerk 入口 /clerk/mcp 分开。前者仍提供原有 24 个工具；Clerk 入口只提供 collection_list，并强制核验 OAuth token type、Issuer、精确 Owner、Resource Audience、raindrop:read Scope。当前源码的 Clerk 逻辑与 Release Variables **仅为 Raindrop 定制**，不是通用 Gateway。
4. **Clerk Production 已上线并经过真实业务 E2E**。Issuer 为 https://clerk.lirtual.dpdns.org，唯一预注册的 ChatGPT CIMD Client 经过检查；Raindrop 生产 Worker Version 88c0f704-c889-4808-920e-2142aeefc0e9 已发布 100%。受保护资源元数据、未认证 401 Bearer Challenge、Scope 指引和 HTTPS/PKCE Discovery 通过公网检查。ChatGPT 新插件 Raindrop Clerk 实际调用 collection_list 返回 4 个收藏夹，见 [T25](https://github.com/lirtual/mcp-workers/issues/853#issuecomment-6858294406) 和 [T26](https://github.com/lirtual/mcp-workers/issues/853#issuecomment-6858433695)。
5. 非生产 Clerk Lab 已捕获真实 ChatGPT Refresh Grant 并验证超过 24 小时的已授权调用；**生产环境短期 Token 到期后的实际自动刷新、真实撤销与非 Owner 拒绝仍 Unknown**。不能因成功登录、Discovery 或单次业务 E2E 将这些项标为 Pass。没有必要人为设置七天等待门禁。
6. 旧 Portal /mcp、上游 Bearer 凭据、既有 Access Policy 和 ChatGPT 连接目前没有因 Raindrop Clerk 试点迁移或撤销。原版 Worker 保留为受控回退基线。

## 2026-11-14 Portal Service Token / Access Policy 只读可行性审查

**当前状态：控制面机制已有官方支持，现有生产配置不满足新 Gateway 的最小权限目标；实际数据面工具拒绝验收仍 Unknown。**

### 实际资源与策略回读

- Cloudflare Access 应用 API 返回 15 个应用，其中 Portal `MCP` 1 个、类型 `mcp` 的应用 11 个；MCP Portal 挂载 11 个上游，当前均为 `auth_type=bearer`、`on_behalf=false`，全部 Ready。
- Access Service Token 列表仅有 1 条现存记录（名称 `workflow-mcp-worker`，只读返回标识符和到期元数据；不读取凭据值）。`WORKFLOWS` Reusable Policy（决策 `non_identity`）的唯一 Include 是该 Service Token。
- **Portal 及 11 个 MCP Access 应用全部引用同一个 `WORKFLOWS` Policy**；从 Portal、Raindrop、Sentry、Git Guardian 四个应用的 **实际 Application Policies API** 分别回读已独立确认。Owner Allow Policy 与上述机器 Policy 同时存在。由此现有 Service Token 已被配置成可通过所有上游的 Service Auth 边界，**绝不可直接作为通用 Clerk Gateway 的共享机器身份**。
- 当前 Portal 的每个上游映射 `default_disabled=false`；Cloudflare 文档支持 `default_disabled=true` 配合显式 `updated_tools` 列表缩小暴露面，但本项目尚无**实际排除工具后仍尝试通过构造 `tools/call` 的拒绝**证据。列表隐藏与服务端调用拒绝必须分开验证。

### 机制成立与尚未证明的部分

- Cloudflare [MCP Portals 官方契约](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/) 要求机器调用同时在 Portal Access 应用及对应上游 MCP Access 应用获得 Service Auth；当上游不匹配该 Token Policy 时，文档说明该上游工具从客户端列表隐藏；`on_behalf=true` 上游不能用于 Service Token 会话。
- 因而 **每个独立 Clerk Resource 使用一个仅被 Portal 和目标上游 MCP 应用允许的机器 Token** 是可检验的候选机制。该 Token 必须无法凭它自身访问其它 MCP Access 应用；原 `WORKFLOWS` Token 仍可能服务现有工作流，不能无授权就删除或重配。可以在验证时只对试点上游和 Portal **附加**最小策略，避免影响旧 Owner/Workflow 使用路径；但任何新 Token/Policy 或 Access App 变更均属需另行授权的生产配置写操作。
- **控制面官方文档通过（Pass，产品能力级）**；**现有配置符合新 Gateway 最小权限（Fail）**；**按上游 Token 真正拒绝其它上游工具及隐藏工具的 MCP `tools/call`（Unknown）**；**Clerk Gateway 直接消费外部 JWT 的 Portal 原生能力（Unknown）**。不能声称门禁已全部通过。
- 即便按上游建立独立 Token，单个 Gateway Worker 若同时持有多个凭据，Worker 代码/运行时被攻破时仍存在共同泄露边界。因此 **Token 粒度提供请求级最小权限，不等于部署级故障隔离**；应核实实际维护与安全收益后才决定是否要求更强的进程/部署隔离，默认不为抽象威胁新造一套系统。

### 仅在获批范围内的最小验证路径

1. 先只读记录 Portal 与目标上游的有效 Policy、旧 Token 依赖以及回滚基线，确保现有 `WORKFLOWS` 机器路径、Owner 访问不受影响。
2. **经生产权限/Secret 写操作另行授权后**，仅对一个低风险上游试点创建限定 Portal + 单上游的凭据与 Service Auth Policy，保留现有 Policy，不修改其它上游；设置短、明确的实验停止与回滚条件。
3. 用该试点凭据实际验证目标上游的只读 `tools/list` / `tools/call` 为 Pass，非目标上游不可见**且直接构造非目标工具的 `tools/call` 被拒绝**，明确测试被禁用工具的拒绝、错误 Resource/Audience/Owner/Scope 与凭据缺失的 fail-closed；不得只看管理 UI 或工具列表便宣布安全。
4. 只在前述服务端拒绝实际通过后，进一步确认 Clerk 能否直接与 Portal 结合；若不能，才评估同仓库最薄认证适配 Worker。未通过时暂停受影响路径，保持现有 Portal 与 Raindrop Clerk 连接，不提升机器令牌权限，也不添加 Token Vault/刷新服务。

## 术语与责任边界

- **ChatGPT 插件 / MCP Resource**：用户独立安装的连接及其唯一资源受众。共享域名或 Worker 不能意味着共享工具授权。
- **客户端授权（Clerk）**：ChatGPT 到受保护 MCP 入口的 OAuth；校验用户、客户端、Issuer、Audience、Scope、状态及必要的撤销结果。
- **上游 MCP / 上游认证**：入口到具体业务服务的另一条信任关系。Bearer、Headers、None 或 OAuth 由上游约定决定；用户级 OAuth 的 Token 和刷新属于此边界，不能拿 Clerk Token 直接冒充。
- **路由与工具边界**：入口把一个 Resource 映射到一个明确的上游身份及受许可的工具集。路由表不是权限证明；必须在真正可调用的执行边界禁止越界请求。
- **凭据作用域**：即使某个机器 Service Token 技术上能调用整个 Portal，也不代表它可安全地给多个资源充当共同的上游管理身份。

## 候选方案与实施前证据门

**优先方案：复用现有 Portal，仅补足 Clerk 客户端 OAuth 与独立资源的安全适配。** 首先只读确认 Cloudflare Portal/Access 的公开契约与当前策略能否接受外部 Clerk 授权、是否能够为每个 MCP 独立约束 Portal 内实际可执行的工具、上游凭据和刷新，不把 Access 登录 IdP 的更换误认为替代 Cloudflare Managed OAuth 的 Grant 生命周期。没有证据前不能称原生 Portal 已支持此方案。

**条件性备选：同仓库的最薄无状态入口 Worker。** 只有现有 Portal 无法满足客户端授权或资源隔离、且确有可验证的安全上游路径时，才考虑一个最小共享适配入口；不重写完整 MCP Portal，也不默认每个 MCP 添加业务代码或独立 Worker。它可以统一验证 Clerk 与分发请求，但**不能**因单一 Portal Service Token 拥有全部上游能力便宣称隔离。若 Portal 无法在上游执行边界限制权限，应寻找按资源隔离的上游凭据/执行边界，或将该上游标记 Blocked；不通过扩大机器权限绕过。

上游认证逻辑上按 OAuth、Bearer、Custom Headers、None 分类，但 Cloudflare Portal API 的实际 `auth_type` 为 `oauth`、`bearer` 和 `unauthenticated`；Custom Headers 属于 `bearer` 类型的 `auth_credentials` 配置，而非额外独立 `auth_type`。该差异不需要另起抽象或重复代码。优先复用 Portal 已可靠运行的能力。

Cloudflare 官方文档确认：对服务令牌，Portal 及各上游 MCP Access 应用必须分别有匹配的 Service Auth Policy；只有 `on_behalf=false` 的上游可用，并使用其管理员凭据。令牌能看见哪些工具受上游 Access Policy 约束，但**不能**由“客户端看不见某工具”推断后端无法越权调用。每个独立 Clerk Resource 的机器凭据须最小作用域，并以服务端真实工具调用/拒绝验收验证；单个全上游管理 Token 不可取。共享 Worker 若持有多组 Secret，仍存在共同运行时的泄露影响面，需按实际威胁边界评估，不能声称物理隔离。

真正的上游用户级 OAuth 需要首次 Consent、Refresh Token 归属、安全存储、撤销、受众与跨用户隔离。Portal 原生 OAuth 接入虽可配置，但 **Service Token 路径不能代表用户授权（`on_behalf=true`）**，因此不能将原生 OAuth 的配置简便误认为与 Clerk Gateway 组合也简便。若只为此能力而必须另建 Token Vault / Refresh 服务，则按 Q4 暂缓；若未来有已验证的原生低成本路径，单独开启并验收。Portal 已知的手动 OAuth 工具同步限制、上游管理员 Token 静默过期风险及仅远程 HTTP 支持，应在具体接入服务时按风险核对。

高风险 Secret、可写工具、跨上游转发和授权失败后的副作用需要独立验收。

## 最小验收与迁移顺序（设计，未授权执行）

1. **只读事实门**：确认 Portal 的 MCP 服务器/挂载关系、Access Policy、客户端 Grant 行为、是否支持外部 Clerk 入口、服务令牌实际权限、上游工具执行边界；不要读取任何真实 Token 明文。
2. **非生产证明**：用已存在的 Bearer 上游及独立 MCP Resource 验证未授权访问、跨 Audience/Scope、非 Owner、错误/撤销 Token、跨上游工具调用均 fail-closed；不能由单纯显示工具列表或 Mock 证明真实隔离。对重定向、凭据外传、超时及未知写入结果使用现有 Worker 安全契约。
3. **生产分批（另行授权）**：完成明确的对象、影响、停止条件与回退预检后，先低风险只读代表性工具，确认真实 ChatGPT 首次授权、工具访问和续期；随后每个上游独立验收专有工具与权限。保留未迁移插件和原 Portal，任何迁移失败先核实副作用再恢复。
4. **状态分层**：Docs、Code、CI、Clerk、Cloudflare、ChatGPT、业务工具和长期刷新分别标 Pass、Fail、Waived 或 Unknown；真实令牌刷新无证据时不得把“已连接”作为其替代。

## 决策树收敛与事实门

- 两轮用户决策 **Q1=A、Q2=A、Q3=A、Q4=A（OAuth 条件支持）、Q5=A** 已确定。暂无需要用户猜测的 OAuth 产品细节或重复的方案选择；下一步由工程侧以证据判定可行性，不因当前某项能力 Unknown 而默认设计新组件。
- **Gate 1 — Portal 安全复用**：已确认 Portal 与 11 个上游共用唯一 `WORKFLOWS` Service Token，因此**现状 Fail**（不满足新 Gateway 所需的最小权限）。官方支持分别匹配 Portal 与指定上游的 Token Policy，属于**候选控制面 Pass**。新增最小权限身份与真实跨上游工具调用拒绝尚未执行，**数据面 Unknown**；未经授权不得更改既有生产 Access Policy/Secret。
- **Gate 2 — 最小适配必要性**：先确认现有 Portal 是否可以直接接受并验证 Clerk OAuth；若不能，且 Gate 1 的单资源通道可安全成立，再考虑同仓库一个最薄、无状态的 Clerk 入口 Worker，复用 Portal 的上游凭据与协议能力。若连 Gate 1 也不成立，则保留现有连接，停止受影响路径，不能为了交付“统一”扩展全部机器身份权限。
- **Gate 3 — 认证模式范围**：首批验证现有 Bearer，按需验证 Custom Headers/None；上游 OAuth 仅在实际支持安全、低成本原生复用时启用。Service Token + `on_behalf=true` 不成立是已知产品限制，不重复作为尝试路径。若要支持必须自建凭据代理，保持 Deferred，日后有实际需求再单独评估。
- **Gate 4 — 可回退和业务 E2E**：现有 Portal、Raindrop Clerk、各插件连接及原有生产 Worker 不动。未来首次上线需单独核实生产授权范围、停止条件与回滚，真实 ChatGPT 插件授权与业务调用只能在被授权部署后认定 Pass；长期刷新单独记录。
- 单个新 Worker、持久状态、独立 OAuth 管理或额外部署单元，**均不是当前的已决架构结论**。如证据表明不加新组件就能安全满足目标，直接复用即可。

**设计阶段完成用户层面的必要选择；技术可行性与生产验收仍未完成。本次文档更新没有授权任何生产改动。**

## 相关证据

- [Spec #853 及 T17–T26 验收记录](https://github.com/lirtual/mcp-workers/issues/853)
- [Raindrop Worker 的当前实现](../apps/raindrop-mcp-worker/src/clerk-pilot-auth.ts)
- [Cloudflare MCP Portals 官方文档（含 Service Token / OAuth 的明确限制）](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)
- [Cloudflare Managed OAuth 文档](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- [ChatGPT 自定义 MCP 连接文档](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
