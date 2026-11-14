# MCP 独立插件长期 OAuth 与统一接入设计（Grill With Docs）

状态：**Grill With Docs 决策树已结束（2026-11-14）**；Q1–Q7 和唯一 Gateway Service Token 等用户级取舍均已确认。设计和事实验证不等于实施验收；此文档**不授权实施、发布、迁移插件、修改 OAuth/Access/Portal/Secrets 或生产数据**。已验证的单插件生产试点见 [Spec #853](https://github.com/lirtual/mcp-workers/issues/853)，后续通用接入规范见 [Spec #878](https://github.com/lirtual/mcp-workers/issues/878)。

## 目标与既定约束

最终用户目标不是“所有请求必须经过 Clerk”，而是：ChatGPT 中多个 **独立 MCP 插件** 在首次连接后尽可能持续自动续期，不因固定期限而计划性逐个重登；仅在撤销、权限变化、风险、客户端令牌丢失或真实故障时重新登录。不能承诺永不重新登录，也不能把浏览器 Session、OAuth Access Token、Refresh Token/Grant 和 MCP Session 当成同一个期限。

新增上游 MCP 应尽量只登记地址、认证类型、凭据及最小权限，**不因自建或第三方而区别处理，也不修改第三方源码**。现有 Cloudflare MCP Portal、已有 Worker、Clerk Production 及项目 CI/发布流程应优先复用。保持个人可承受的免费、免绑信用卡与 Serverless 约束；没有必要不新增项目、数据库、Token Vault、Cron、长期进程或管理界面。

### 2026-11-14 第一轮已确认决定

- **Q1=A，权限隔离**：每个 ChatGPT 插件独立 Resource/Audience、授权和实际工具调用边界。某个插件认证成功不代表可以访问其它上游；不能仅依赖工具列表隐藏来假设安全隔离。**Q1 约束的是客户端与请求权限，不强制每个 MCP 都持有独立机器 Token。**
- **Q2=A，第三方首次授权**：可接受第三方 MCP 在首次连接时按需完成一次自己的 OAuth 授权；Clerk 管理客户端到入口的 OAuth，不能替第三方签发上游授权。后续自动刷新取决于各自协议和真实能力，不能保证第三方永久免重登。
- **Q3=A，分批迁移**：保留现有连接与回退路径；先用 Raindrop、Sentry、Git Guardian 等代表性服务验证通用机制，再逐个迁移。共享实现、版本、配置和安全边界等价时可复用验收，独有的权限及工具调用必须单独验证。

### 2026-11-14 第二轮已确认决定

- **Q4=A，按需扩展上游认证**：首批只针对已有真实样本的 Bearer MCP 建立最小通用接入；Custom Headers 与 None 可优先使用 Portal 原生配置，遇到实际接入对象时进行必要的权限和协议验证。产品能力覆盖不等于本项目实现或验收全部认证方式。
- **Q4 补充：上游 OAuth 仅低成本复用时支持**：不为了“形式上支持全部认证”开发新 OAuth 授权服务器、Token Vault、刷新服务或周期任务。Portal 已支持 OAuth DCR 与手动客户端配置；但若 Clerk Gateway 到 Portal 只能走机器 Service Token，则 Portal 的用户级上游 OAuth（`on_behalf=true`）无法直接复用。必须有安全的实际路径，并评估首次同意、Refresh Token 的归属/撤销和凭据范围；否则明确标记 **Deferred / Unsupported in first phase**，保留原生直连或原 Portal 方案，不把管理员 OAuth 授权静默替换成用户 OAuth。
- **Q5=A，不增加管理 UI**：优先沿用 Cloudflare Portal 的 MCP 注册和凭据管理，以及既有仓库配置、CI 和发布流程。新界面、单独仓库、身份系统、数据库等均需先证明真实缺口和明显的维护收益。
- **决策顺序**：按最新共识，整个 Gateway 固定使用 **一个专用 Service Token**，所有已批准接入的 MCP 共用，不因服务种类或风险新增第二枚 Gateway Token；先验证 Gateway 在每个 Clerk Resource 的实际工具调用边界能阻断跨 MCP 请求，再决定是否需要同仓库的薄 Worker；不直接挪用旧 Workflow 机器令牌。

### 2026-11-14 最终补充：唯一 Gateway Service Token 与通用性

- **唯一机器身份**：Gateway 仅持有一组专用 Portal Service Token，所有逐批准入的 MCP（包括未来按明确授权接入的高影响 MCP）共用。绝不为每个 MCP 额外创建 Token，也不按风险组拆分多个 Gateway Token；已有 `workflow-mcp-worker` Service Token 属于旧系统，不转给新 Gateway，也不因此删除。Gateway Token 的生产创建、扩展授权范围和撤销均需针对实际对象、影响与恢复路径获明确授权。
- **业务无关**：Gateway 仅实现通用 Clerk OAuth/PRM、MCP 请求处理、资源路由、工具级权限执行检查和转发，不包含具体 MCP 的 API、业务字段、工具特例或上游 OAuth 实现。自建/第三方使用同一配置契约；Portal 继续作为上游 MCP 地址、认证和工具元数据的事实来源。
- **配置驱动，避免重复路由表**：每个独立客户端 Resource（例如 `/mcp/raindrop`）从经校验的 Portal `server_id` 派生地址，Clerk 以完整 HTTPS URL 注册受众。Gateway 在请求时必须验证实际 Clerk Resource 已登记、目标 Portal 上游已准入和准确工具命名空间；不持有第二份逐 MCP 路由表或 Cloudflare 管理 API Token。若现有认证元数据不足以安全验证有效 Resource，先标 Unknown/Blocked，再研究最小必要核验方式，不默认追加数据库。
- **仍须严格工具隔离**：单 Token 可以在 Portal 访问多个上游，但每个 Clerk Resource 必须独立核验 Issuer、Owner、Audience、Scope 和真实工具目标；Gateway 只透出所选上游的工具，在 `tools/call` 执行处阻止跨 `server_id`、Portal 管理及 Code Mode 工具，拒绝未知执行方法。Portal 是工具允许状态的事实来源，需实测禁用工具被拒绝；不得只凭 `tools/list` 展示推断安全。先以两个低风险测试上游验证，再逐批扩大。
- **风险取舍**：共享机器 Token 一旦泄露、或 Gateway 的授权/路由检查被突破，攻击者可能访问它获准的**全部上游**，包括未来批准纳入的高影响服务。单用户场景降低管理成本，但不消除该爆炸半径；SSH、Remote Control、Database、Workflow 等高影响 MCP **不会在首批试点直接迁移**，后续如纳入唯一 Token 须在真实风险、现有业务门禁与运行时拒绝实测通过后取得明确生产授权。若风险无法接受，则该 MCP 保持原入口，不通过新增第二枚 Gateway Token 规避用户的单 Token 约束。



### 第三轮最终方案：自动接入、Clerk 资源与安全停用

**Q6=A、Q7=A；设计树 Q1–Q7 全部收敛。** 自动接入从一次已授权的用户请求或现有 Cloudflare/Clerk 连接器工作流开始，而非监听 Portal Dashboard 变化；Gateway 路由从已核实的 Portal `server_id` 推导 `/mcp/{server_id}`，不长期维护第二份逐 MCP 路由表。**路径匹配仅定位目标，不构成使用授权**；不能证明安全准入的候选资源一律 fail-closed。

**每新增一个 MCP，Clerk 究竟需要什么：**

- **复用一次性全局配置**：当前 Clerk Production 的 Issuer、Owner、已预注册的 ChatGPT CIMD 客户端、PKCE、Audience 开关、已有 Refresh 机制。不创建新的 Clerk 应用、OAuth 客户端、用户或密钥，也不为每个 MCP 创建独立的 OAuth 服务器。
- **每个 MCP 注册一个完整 HTTPS Resource URL**：例如新 Gateway 的 `https://<gateway-domain>/mcp/sentry`；它既是客户端输入的 MCP 地址，也是 Clerk OAuth Access Token 需要精确匹配的 Resource Audience。用现有 `configure_mcp_server` 工具做 `dry_run` 预检，再在明确生产授权后注册/回读；已存在且等价的 URL 直接复用。此举不会自动实现 Gateway MCP/PRM 路由，也不代表 ChatGPT 已安装或已登录。当前生产 Clerk 只有 Raindrop 这个 MCP Resource。
- **Scope 并非每个新 MCP 必配**：独立 Resource Audience、Owner 和业务工具边界可以覆盖单用户基本隔离。如果 Sentry 需要区分只读/写入等独立权限，才按实际需要在 Clerk OAuth Scopes 中新增必要的自定义 Scope、授予预注册的 ChatGPT 客户端，并在 Gateway 的 PRM/实际 Token 校验中保持一致。Clerk 广告 Scope 不会自动授权客户端，也不会自动让 Gateway 校验它。部分 OAuth 客户端会省略 `scope`，需实测 ChatGPT 的请求及 Clerk 默认 Scope 配置；避免为了每个 MCP 创造未使用的 Scope。
- **长期授权复用现有机制**：Clerk `offline_access` / Refresh 是 ChatGPT 到 MCP 的客户端授权机制，不是 Gateway 到 Portal 的机器凭据，也不能替代第三方用户 OAuth。当前 Clerk Production `oauth_jwt_access_tokens=false`，Raindrop 的 SDK 验证已包含在线 Token 验证路径；不强制修改全局 Token 格式。OAuth Access Token 的到期/撤销、Refresh 的实际续期、Clerk 浏览器 Session 均为不同边界。生产真实静默刷新尚为 Unknown。
- **下线时同时处理实际调用路径**：从 Clerk 注销 Resource 或删除 Scope **不代表已经签发的 Access Token 立即不可用**。必须先让 Gateway/Portal 针对该目标拒绝真实工具调用，再按已核实依赖撤销该 MCP 的唯一 Gateway Token 上游 Access 准入、相关 Clerk 授权/资源，验证旧 Token 与旧 URL 无法继续使用；不能撤销共享 Gateway Token 本体而导致其它 MCP 一起失联。

**一次请求接入的最小安全顺序（涉及生产写入均须单独授权）：**

1. **只读预检**：核实新的远程 MCP HTTP URL、上游认证方式、`server_id` 的规范化和命名空间冲突、是否已在 Portal 注册/挂载、工具及风险、是否已有 Clerk Resource、现有唯一 Gateway Token 准入和恢复基线；同配置复用，不凭同名覆盖异物。
2. **先准备业务与客户端资源**：经授权注册/挂载 Portal 上游并核实 Ready，按 `server_id` 派生完整 HTTPS Gateway URL，调用 Clerk MCP Resource 注册能力并核对元数据及当前设置。Portal `PUT` 的 `servers` 为**全数组替换**，必须写前回读并保留全部原上游挂载与字段，写后逐一对账；若有并发漂移或写入副作用 Unknown，停写回读，不能盲目重试。
3. **最后扩大机器准入**：仅在前述资源准备和安全核验通过、明确生产授权存在时，把**同一枚专用 Gateway Service Token** 加入目标 MCP Access 应用的 Service Auth Policy。不得使用已有 `workflow-mcp-worker` Token 替代；不能一次性默认准入所有 11 个上游或自动扩大高风险服务权限。
4. **实测然后交付**：核实精确 Clerk Audience、Owner、必要 Scope、只读业务正向调用、跨 Resource 和禁用工具反向拒绝，并确保 Portal 内置管理/工具搜索、Code Mode 和未知可执行方法被阻断；适用时对照真实 ChatGPT 协议验证 MCP 请求头/JSON body 一致。只有全部关键门禁 Pass 才返回“已配置、可在 ChatGPT 添加”的独立 URL；用户仍需首次安装和授权，生产自动 Refresh 是单独的验收项。

**失败、幂等与停用**：Portal、Access、Clerk 三方没有原子事务。以各方真实标识和已有 URL 回读作为续办断点，不新增 onboarding 状态机、数据库、锁、Cron、同步事件监听器。若 Portal Ready 但 Clerk 注册失败，则保留真实状态、标未就绪并允许原地续办；不误删既有 Portal MCP 或凭据。Gateway 的动态 Resource 必须依托可信的 Clerk 注册/当前准入状态，不能仅靠合法 URL 和有效签名 Token 启用未知服务；注册后删除及旧 Access/Refresh Token 的行为仍要真实验证。无法仅通过现有元数据可靠证明准入时，优先采用最小已有控制或受控准入方式，不为保持零路由表而放宽授权。

**Portal 工具权限与协议**：Portal 是上游工具启停的单一事实来源；Gateway 不复制整套工具白名单，但需要过滤 `tools/list`，在 `tools/call` 真实执行时限制为当前上游的业务工具、拒绝 `portal_*`、Code Mode、其它执行入口；核实 Portal 禁用的工具即使直接构造调用也被拒绝。当前 Portal 11 个映射均 `default_disabled=false`；高影响 MCP 在准入前按风险核实是否设显式允许工具，不能无授权改变现有连接。仅支持真实 ChatGPT 客户端所需 MCP 协议组合，避免预先兼容全部历史版本。

**结论**：Cloudflare/Clerk 的管理接口已存在，Q6 的一次操作方案具备可用 API 基础；**端到端自动接入、Q7 动态授权准入、跨 MCP 工具隔离、停用旧 Token 和 Production 长期刷新仍为 Unknown**。这些是实施事实门，不是继续新增架构组件的理由；原 Portal、已上线 Raindrop Clerk 以及其它插件连接保留直至单独批准迁移。

与此前 Spec #853 的长期目标保持一致：CIMD 仅允许已预注册 ChatGPT 客户端、PKCE、明确 Owner、拒绝无效/过期/跨资源 Token、Refresh Token 不进入日志或聊天、不开放匿名 DCR 或 Everyone/Bypass，不向 ChatGPT 下发 Portal 或上游机器凭据。

## 已核实的实现与生产状态

1. Cloudflare 账号现有 **1 个 Portal（mcp.lirtual.dpdns.org）、11 个上游 MCP**；2026-11-14 只读回读全部 Ready、认证类型为 **Bearer** 且挂载均为 **on_behalf=false**。上游包括 Raindrop、Sentry、Git Guardian 等。这是 Portal 的上游配置数量，**不代表 ChatGPT 安装插件数、OAuth Grants 或独立 Client 的数量**。
2. 当前 Portal 已承担上游 MCP 注册、工具枚举/选择、转发及预置上游凭据管理。Cloudflare 的产品层支持多种上游认证模式（例如 OAuth、Bearer、Custom Headers、None），但上述 **11 个实际生产上游仅有 Bearer 配置证据**；不能把产品支持等同于这些模式已在本项目验收。Portal 是否能够直接验证外部 Clerk OAuth、按每个独立 Resource 安全转发并保持长期客户端 Refresh，**尚未证实**。
3. 现有 Raindrop Worker 将 Portal Bearer 入口 /mcp 与独立 Clerk 入口 /clerk/mcp 分开。前者仍提供原有 24 个工具；Clerk 入口只提供 collection_list，并强制核验 OAuth token type、Issuer、精确 Owner、Resource Audience、raindrop:read Scope。当前源码的 Clerk 逻辑与 Release Variables **仅为 Raindrop 定制**，不是通用 Gateway。
4. **Clerk Production 已上线并经过真实业务 E2E**。Issuer 为 https://clerk.lirtual.dpdns.org，唯一预注册的 ChatGPT CIMD Client 经过检查；Raindrop 生产 Worker Version 88c0f704-c889-4808-920e-2142aeefc0e9 已发布 100%。受保护资源元数据、未认证 401 Bearer Challenge、Scope 指引和 HTTPS/PKCE Discovery 通过公网检查。ChatGPT 新插件 Raindrop Clerk 实际调用 collection_list 返回 4 个收藏夹，见 [T25](https://github.com/lirtual/mcp-workers/issues/853#issuecomment-6858294406) 和 [T26](https://github.com/lirtual/mcp-workers/issues/853#issuecomment-6858433695)。
5. 非生产 Clerk Lab 已捕获真实 ChatGPT Refresh Grant 并验证超过 24 小时的已授权调用；**生产环境短期 Token 到期后的实际自动刷新、真实撤销与非 Owner 拒绝仍 Unknown**。不能因成功登录、Discovery 或单次业务 E2E 将这些项标为 Pass。没有必要人为设置七天等待门禁。
6. 旧 Portal /mcp、上游 Bearer 凭据、既有 Access Policy 和 ChatGPT 连接目前没有因 Raindrop Clerk 试点迁移或撤销。原版 Worker 保留为受控回退基线。

## 2026-11-14 Portal Service Token / Access Policy 只读可行性审查

**当前状态：控制面机制已有官方支持，现有全上游 Workflow 令牌不适合直接充当 Gateway 令牌；使用唯一专用 Gateway 令牌覆盖经逐批批准的 MCP 是待验证候选。实际数据面工具隔离仍 Unknown。**

### 实际资源与策略回读

- Cloudflare Access 应用 API 返回 15 个应用，其中 Portal `MCP` 1 个、类型 `mcp` 的应用 11 个；MCP Portal 挂载 11 个上游，当前均为 `auth_type=bearer`、`on_behalf=false`，全部 Ready。
- Access Service Token 列表仅有 1 条现存记录（名称 `workflow-mcp-worker`，只读返回标识符和到期元数据；不读取凭据值）。`WORKFLOWS` Reusable Policy（决策 `non_identity`）的唯一 Include 是该 Service Token。
- **Portal 及 11 个 MCP Access 应用全部引用同一个 `WORKFLOWS` Policy**；从 Portal、Raindrop、Sentry、Git Guardian 四个应用的 **实际 Application Policies API** 分别回读已独立确认。Owner Allow Policy 与上述机器 Policy 同时存在。由此现有 Service Token 已被配置成可通过所有上游的 Service Auth 边界，**绝不可直接作为通用 Clerk Gateway 的共享机器身份**。
- 当前 Portal 的每个上游映射 `default_disabled=false`；Cloudflare 文档支持 `default_disabled=true` 配合显式 `updated_tools` 列表缩小暴露面，但本项目尚无**实际排除工具后仍尝试通过构造 `tools/call` 的拒绝**证据。列表隐藏与服务端调用拒绝必须分开验证。

### 机制成立与尚未证明的部分

- Cloudflare [MCP Portals 官方契约](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/) 要求机器调用同时在 Portal Access 应用及对应上游 MCP Access 应用获得 Service Auth；当上游不匹配该 Token Policy 时，文档说明该上游工具从客户端列表隐藏；`on_behalf=true` 上游不能用于 Service Token 会话。
- 因而 **Gateway 统一持有一枚专用 Service Token** 是固定设计约束；首次仅允许一个低风险上游，验证后在**同一枚 Token** 的 Access Policy 范围内逐批加入需要迁移的 MCP，不为新增 MCP 创建 Token。Gateway 必须在每个 Clerk Resource 的服务端执行边界限制目标与工具。原 `WORKFLOWS` Token 不能无授权删除、重配或挪用。任何 Gateway Token/Policy/Secret 的生产写入与授权扩张均须明确授权。
- **控制面官方文档通过（Pass，产品能力级）**；**将现有 Workflow Token 直接用作 Gateway 身份（Fail，违反独立机器身份约束）**；**唯一专用 Gateway Token 下不同 Clerk Resource 的实际调用隔离（Unknown）**；**Portal 原生识别 Clerk OAuth（Unknown）**。不能声称门禁已全部通过。
- 由于确定只用一枚 Gateway Service Token，必须明确 **一个凭据泄露可能影响它所获授权的全部上游**；工具权限检查隔离正常请求，不能消除 Gateway 运行时被攻破的影响。不新增按 MCP 拆分的 Gateway Token、Worker 或额外数据库来掩盖这一取舍；高影响接入必须独立做风险准入。

### 仅在获批范围内的最小验证路径

1. 先只读记录 Portal 与目标上游的有效 Policy、旧 Token 依赖以及回滚基线，确保现有 `WORKFLOWS` 机器路径、Owner 访问不受影响。
2. **经生产权限/Secret 写操作另行授权后**，仅创建一枚 Gateway 专用 Service Token，先为一个低风险上游在 Portal 和对应 MCP App 追加适用的 Service Auth Policy，保留现有 Policy；设置停止条件和恢复路径。未来扩大范围时修改同一枚 Token 的准入范围，未经授权不批量开放其它上游。
3. 用专用 Gateway 试点凭据实际验证被批准的低风险目标上游只读 `tools/list` / `tools/call`；先测试未加入集合的高风险上游不可见、直接构造非目标 `tools/call` 亦被拒绝。再在非生产或授权范围内让一个机器 Token 访问两个低风险测试上游，验证两个不同 Clerk Resource **只能调用各自的工具**，包括直接构造同一凭据授权范围内另一上游的工具名、被禁用工具及 Code Mode 替代路径；验证错误 Resource/Audience/Owner/Scope、凭据缺失 fail-closed。不能只看 UI 或工具列表就宣布安全。
4. 只在前述服务端拒绝实际通过后，进一步确认 Clerk 能否直接与 Portal 结合；若不能，才评估同仓库最薄认证适配 Worker。未通过时暂停受影响路径，保持现有 Portal 与 Raindrop Clerk 连接，不提升机器令牌权限，也不添加 Token Vault/刷新服务。

## 术语与责任边界

- **ChatGPT 插件 / MCP Resource**：用户独立安装的连接及其唯一资源受众。共享域名或 Worker 不能意味着共享工具授权。
- **客户端授权（Clerk）**：ChatGPT 到受保护 MCP 入口的 OAuth；校验用户、客户端、Issuer、Audience、Scope、状态及必要的撤销结果。
- **上游 MCP / 上游认证**：入口到具体业务服务的另一条信任关系。Bearer、Headers、None 或 OAuth 由上游约定决定；用户级 OAuth 的 Token 和刷新属于此边界，不能拿 Clerk Token 直接冒充。
- **路由与工具边界**：入口把一个 Resource 映射到一个明确的上游身份及受许可的工具集。路由表不是权限证明；必须在真正可调用的执行边界禁止越界请求。
- **凭据作用域**：唯一 Gateway Service Token 可访问所有被授权的上游，这是明确接受的共享凭据风险；每个 Clerk Resource 的正常请求由 Gateway 执行严格隔离，但并不能消除 Gateway/凭据泄露波及全部准入上游的风险。

## 候选方案与实施前证据门

**优先方案：复用现有 Portal，仅补足 Clerk 客户端 OAuth 与独立资源的安全适配。** 首先只读确认 Cloudflare Portal/Access 的公开契约与当前策略能否接受外部 Clerk 授权、是否能够为每个 MCP 独立约束 Portal 内实际可执行的工具、上游凭据和刷新，不把 Access 登录 IdP 的更换误认为替代 Cloudflare Managed OAuth 的 Grant 生命周期。没有证据前不能称原生 Portal 已支持此方案。

**条件性备选：同仓库的最薄无状态入口 Worker。** 只有现有 Portal 无法满足客户端授权或资源隔离、且确有可验证的安全上游路径时，才考虑一个最小共享适配入口；不重写完整 MCP Portal，也不默认每个 MCP 添加业务代码或独立 Worker。它可以统一验证 Clerk 与分发请求，但**不能**因单一 Portal Service Token 拥有全部上游能力便宣称隔离。若 Portal 与 Gateway 不能在实际工具调用边界做到跨 Resource 拒绝，则该接入路线保持 Blocked、旧连接继续使用；不通过第二枚 Gateway Token 或扩大已有 Workflow Token 权限绕过。

上游认证逻辑上按 OAuth、Bearer、Custom Headers、None 分类，但 Cloudflare Portal API 的实际 `auth_type` 为 `oauth`、`bearer` 和 `unauthenticated`；Custom Headers 属于 `bearer` 类型的 `auth_credentials` 配置，而非额外独立 `auth_type`。该差异不需要另起抽象或重复代码。优先复用 Portal 已可靠运行的能力。

Cloudflare 官方文档确认：对服务令牌，Portal 及各上游 MCP Access 应用必须分别有匹配的 Service Auth Policy；只有 `on_behalf=false` 的上游可用，并使用其管理员凭据。令牌能看见哪些工具受上游 Access Policy 约束，但**不能**由“客户端看不见某工具”推断后端无法越权调用。**一枚专用 Gateway Token** 可用于所有已批准接入的上游；每个 Clerk Resource **仍须在 Gateway 的真实执行边界校验 Audience、路由和工具允许列表**。该令牌被窃或 Gateway 被攻破时，可能影响已授权的全部服务；高影响 MCP 是否纳入此单一凭据应逐项审查。

真正的上游用户级 OAuth 需要首次 Consent、Refresh Token 归属、安全存储、撤销、受众与跨用户隔离。Portal 原生 OAuth 接入虽可配置，但 **Service Token 路径不能代表用户授权（`on_behalf=true`）**，因此不能将原生 OAuth 的配置简便误认为与 Clerk Gateway 组合也简便。若只为此能力而必须另建 Token Vault / Refresh 服务，则按 Q4 暂缓；若未来有已验证的原生低成本路径，单独开启并验收。Portal 已知的手动 OAuth 工具同步限制、上游管理员 Token 静默过期风险及仅远程 HTTP 支持，应在具体接入服务时按风险核对。

高风险 Secret、可写工具、跨上游转发和授权失败后的副作用需要独立验收。

## Gateway 的实现与放置方式（候选，当前尚不存在）

- **运行位置**：Cloudflare Workers 边缘运行时；**源码位置**：继续放在 `lirtual/mcp-workers`，如果需要新增一个部署单元，建议 `apps/mcp-gateway-worker/`；复用现有 GitHub CI、Release Worker 及 Clerk 验证实现。不新建独立 GitHub 仓库、服务器或管理后台。Clerk 继续使用现有托管 Production 实例，**Clerk 本身不运行 Gateway**。
- **暴露接口**：一个 Gateway 按**安全核验后的 Portal `server_id`** 推导多个独立受保护 MCP Resource，例如 `/mcp/raindrop`、`/mcp/sentry`（仅为拟议路径）。在 Clerk 程序化注册对应完整 HTTPS Resource URL，OAuth Protected Resource Metadata / 401 Challenge 与该业务入口一致。**不维护逐 MCP 的第二份路由注册表、工具目录、业务 Worker 分支或 MCP 专属 Service Token**；仅靠路径匹配不代表授权成立。
- **核心处理**：按实际请求验证 Clerk OAuth Token 类型/有效性/Issuer/精确 Owner/完整 Resource Audience/必要 Scope 和 Resource 实际登记状态；按已验证 `server_id` 命名空间筛选 `tools/list`，在 `tools/call` 执行边界限制只能调用该 MCP，默认阻断 `portal_*` 内置工具、Code Mode、未知方法/查询参数，并核验所用协议版本下请求头与 body 一致；首期优先支持真实 ChatGPT 所需的 Streamable HTTP 版本，不理解各业务参数语义。服务端仅用**唯一** Gateway Service Token 访问固定 Portal URL，严禁把入站 Clerk Token 发到上游或把 Portal Token 给 ChatGPT；遵循 Cloudflare Workers 的流式响应与拒绝带凭据重定向约束。
- **职责划分**：Gateway 只做“客户端授权 + 路由 + 执行权限检查 + 最小 MCP 协议适配”；Portal 继续做上游注册、认证、工具同步和上游转发。能由现有 Portal 原生完成的职责不复制。若 Portal 原生不能安全兼容该结构，优先停止并重新核查，而非增加复杂代理链。
- **非目标**：不在首批同时迁移全部 11 个 MCP，不为不同 MCP、不同风险组再创建额外 Gateway Token；不自行实现上游业务代码、完整 OAuth 授权服务、Token Vault、MCP Portal 管理后台、数据库或定时任务。Gateway 当前仍是条件候选，未经授权不得创建生产 Worker。

## 最小验收与迁移顺序（设计，未授权执行）

1. **只读事实门**：确认 Portal 的 MCP 服务器/挂载关系、Access Policy、客户端 Grant 行为、是否支持外部 Clerk 入口、服务令牌实际权限、上游工具执行边界；不要读取任何真实 Token 明文。
2. **非生产证明**：用已存在的 Bearer 上游及独立 MCP Resource 验证未授权访问、跨 Audience/Scope、非 Owner、错误/撤销 Token、跨上游工具调用均 fail-closed；不能由单纯显示工具列表或 Mock 证明真实隔离。对重定向、凭据外传、超时及未知写入结果使用现有 Worker 安全契约。
3. **生产分批（另行授权）**：完成明确的对象、影响、停止条件与回退预检后，先低风险只读代表性工具，确认真实 ChatGPT 首次授权、工具访问和续期；随后每个上游独立验收专有工具与权限。保留未迁移插件和原 Portal，任何迁移失败先核实副作用再恢复。
4. **状态分层**：Docs、Code、CI、Clerk、Cloudflare、ChatGPT、业务工具和长期刷新分别标 Pass、Fail、Waived 或 Unknown；真实令牌刷新无证据时不得把“已连接”作为其替代。

## 决策树收敛与事实门

- 设计树所有用户取舍 **Q1=A、Q2=A、Q3=A、Q4=A（上游 OAuth 条件支持）、Q5=A、Q6=A、Q7=A** 已确定，Grill With Docs 正式结束；下一步由工程侧按证据门验证，不因某项 Unknown 就默认添加组件。
- **Gate 1 — Portal 安全复用**：已确认现有 `WORKFLOWS` Token 跨全部 11 个上游，因此**直接复用旧令牌为 Gateway 令牌是 Fail**。候选为**仅一枚新 Gateway Service Token**，通过 Portal/上游 Access Policy 逐批获准访问指定 MCP；无论该 Token 有权访问多少上游，Gateway 都必须对每个 Clerk Resource 的跨 MCP `tools/call` 做实际拒绝。控制面具备官方支持，**数据面 Unknown**；未经授权不得修改生产 Access Policy/Secret。
- **Gate 2 — 最小适配必要性**：先确认现有 Portal 是否可以直接接受并验证 Clerk OAuth；若不能，且 Gate 1 的单资源通道可安全成立，再考虑同仓库一个最薄、无状态的 Clerk 入口 Worker，复用 Portal 的上游凭据与协议能力。若连 Gate 1 也不成立，则保留现有连接，停止受影响路径，不能为了交付“统一”扩展全部机器身份权限。
- **Gate 3 — 认证模式范围**：首批验证现有 Bearer，按需验证 Custom Headers/None；上游 OAuth 仅在实际支持安全、低成本原生复用时启用。Service Token + `on_behalf=true` 不成立是已知产品限制，不重复作为尝试路径。若要支持必须自建凭据代理，保持 Deferred，日后有实际需求再单独评估。
- **Gate 4 — 自动接入与可回退 E2E**：同一接入请求完成 Portal→单枚 Gateway Token 准入→Clerk Resource 注册→Gateway 路由与工具验证；新 Resource 失败、重复、并发修改及部分完成场景能通过回读续办、不覆盖原 Portal 数组。现有 Portal、Raindrop Clerk、旧插件与 Worker 保持不变。生产配置更改、上线与回滚需独立授权；ChatGPT 首次安装/授权、实际业务、长期刷新分别验收。
- 单个新 Worker、持久状态、独立 OAuth 管理或额外部署单元，**均不是当前的已决架构结论**。如证据表明不加新组件就能安全满足目标，直接复用即可。

**设计阶段完成用户层面的必要选择；技术可行性与生产验收仍未完成。本次文档更新没有授权任何生产改动。**

## 相关证据

- [Spec #853 及 T17–T26 验收记录](https://github.com/lirtual/mcp-workers/issues/853)
- [Raindrop Worker 的当前实现](../apps/raindrop-mcp-worker/src/clerk-pilot-auth.ts)
- [Cloudflare MCP Portals 官方文档（含 Service Token / OAuth 的明确限制）](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)
- [Cloudflare Managed OAuth 文档](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- [ChatGPT 自定义 MCP 连接文档](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
