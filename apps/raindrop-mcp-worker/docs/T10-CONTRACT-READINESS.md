## 最新 G0 门禁 · 根收藏夹清理回查修复（2026-10-21，优先于下文历史）

- **最小修复已提交到 Draft（未合并、未部署）：** 业务代码修复在 `83f6cfd`，最终修正测试夹具后的代码提交为 `b8b086e`。根收藏夹 `getCollections(true)` 现在仅在 `GET /collections` 返回 `result:true` 且 `items` 为数组时认为列表有效；否则抛出可识别的 `UpstreamError`，不再把无效响应转换为空列表。严格校验由同一现有 Service 复用，没有新增依赖、存储、Runner 或 API 客户端。
- **源码级测试证据：** [Node24 CI #39533924163](https://github.com/lirtual/mcp-workers/actions/runs/39533924163) **Success**；Raindrop 本地测试集合在 CI 中 **402 passed / 3 skipped**。覆盖合法空根列表、HTTP/缺失/错误响应、不可缓存无效结果，并保持已有读取有限重试语义。上一轮 CI #39533698716 曾因测试夹具缺少 `result:true` 与断言未关闭有限读取重试而失败；已修正后通过。CI 并非真实 G0。
- **历史真实 G0 仍失败：** [#39526769234](https://github.com/lirtual/mcp-workers/actions/runs/39526769234) 使用旧代码 `e6fc4dd`，Favorite 断言失败（`count=0`）但清理 PASS。旧版可把异常查询响应误转成零结果；目前未取得足以归因 Favorite 搜索根因的真实响应证据。最新版增加有限范围的 `LIVE_FAVORITE_DIAGNOSTIC`，但尚未运行授权后的第三次真实验收。
- **发布仍 NO-GO：** 当前仓库没有经安全审批获准、独立于发布工作流的 G0 Secret-bearing 入口。不得通过 Shell/WSL、其他连接器或提前部署规避平台安全限制。获准后需重新确认 **PR 最新提交 SHA**，仅在一次性隔离作业中运行 `pnpm --filter raindrop-mcp-worker run test:live:spec123`，记录退出码、Favorite 正反筛选、逐 ID 写入/核验、`LIVE_FAVORITE_EXCLUSION_PASS`、`LIVE_SCOPED_WRITES_PASS`、`LIVE_ISOLATED_CLEANUP_PASS` 和最终随机集合消失回执，并撤销临时入口；失败不得自动重放写入。
- **阶段边界：** G0 尚未完成；G1 合并/原有 Actions 发布需要另外明确授权；G2 Portal/插件真实验收须在实际发布后执行。全局 Trash 永久清空与 Pro 正向去重仍按已接受的验收范围限制，不补造破坏性样本。

---

## 当前 G0 状态（2026-10-21；此节优先于下文历史快照）

- **遗留可丢弃集合已由用户在 Raindrop 网页端清理：** 用户明确确认删除测试集合 `76295923`（随机专属名称 `spec123-b-b84e8bfc4b00450f82ecbb560de0eaf8`），刷新后不存在；此前 `76295921` 已取得精确 ID 删除回执。这是**用户完成的网页端核对**，不是 ChatGPT 再次执行生产 API 读回；不应重复要求清理或跨接口绕过此前的安全限制。
- **代码与现有 CI：** Draft PR #134 仍未合并，`d00014f` 已通过 [Node 24 CI #39523405631](https://github.com/lirtual/mcp-workers/actions/runs/39523405631)。G0 脚本已补全 Favorite 正/负样本、独立保留原始失败和 cleanup 失败、最终无缓存集合消失核对；这些只通过本地 Mock/CI，**尚未真实重测**。正式部署版仍为旧 Worker，G1/G2 均未运行。
- **G0 目前 NO-GO：** 旧 [Actions #39519905146](https://github.com/lirtual/mcp-workers/actions/runs/39519905146) 验收失败；一次性生产 Secret 作业已撤销。最近尝试增加新的受控 G0 工作流时，被平台安全检查阻止（**没有成功创建、运行或重新授权**）。不能通过更换 Shell、GitHub API、其它工具或提前合并部署绕过安全检查。需要合规获准的既有凭据隔离执行路径才能获取新版 collection/bookmark/tag/batch 真实写入、逐 ID 回查、准确清理及 `important:false` 证据。
- **后续决策：** 不再为通过 G0 加新模块、重复 Mock 或自动发布系统；未获得授权执行路径前停止真实账号写入。始终保留 G0 →（另行授权）G1 → G2 的顺序。


---

# T10 — Spec #123 公开契约切换就绪审查（2026-10-20）

**最新结论：公开契约切换仍 BLOCKED。** Draft PR #134 当前共注册 **41 个工具 = 26 个目标候选 + 15 个其余旧工具**；其中 bookmark_search 与 collection_list 属于同名原有工具。此前已在用户授权下使用**现有生产 Raindrop Token**完成受控只读与可丢弃高亮真实 API 验收（见下方最新状态和运行证据）。本文件不授权合并 main、移除旧工具、部署 Worker 或刷新插件。

## 最新范围收敛：删除不可用的建议候选（2026-10-20）

- **已经删除**：`bookmark_suggest` 的新候选注册、输入/输出 Schema、工具处理器和候选专用 `getOfficialSuggestions` 转换逻辑，不再出现在 `tools/list`；直接调用已删除名称会得到 MCP `Tool not found`，不访问上游。移除其正式 Mock 测试与认证只读 smoke 中的相关步骤。
- **新的准确数量**：**41 个工具 = 26 个新候选 + 15 个旧兼容工具**。并没有执行全面 41→26 切换；当前独立兼容 `get_suggestions`、`suggest_tags` 保留，前者仍调用旧 API、可能 403，这不是候选功能恢复。
- **验收证据**：下方原始 10 项生产验收日志是删除前的历史事实。原 9 项已通过，其中 1 项是被移除的新建议工具导致的 403；当前只读脚本不再发起这项请求，**没有因此宣称新版本已重新进行 9/9 的真实认证验收**。其余真实 API 证据仍有效。
- **限制**：本次只移除明确点名的一个候选工具及其独占代码，不改旧工具名、凭据、Portal、Worker 部署或破坏性写入权限。

## 最新真实验收快照（以本节为准，以下 T10 原始记录保留审查历史）

- **SDK MCP → 真实 API 的只读验证**：10 项 smoke 中 9 项通过，包含工具注册/无写入断言；`collection_list`、`collection_get`、`bookmark_search`、`bookmark_get`、`highlight_list`、`tag_list`、`bookmark_filters_get` 的实际调用成功。[运行 #39437631284](https://github.com/lirtual/mcp-workers/actions/runs/39437631284)。
- **Draft Service → 真实 API 的隔离写入验证**：在随机新建的可丢弃书签上，高亮创建、读取、更新、删除和书签精确清理成功；这是 Service 真实 API 验收，**不是通过线上 Portal 的 MCP 写入验收**。[运行 #39439062465](https://github.com/lirtual/mcp-workers/actions/runs/39439062465)。
- **建议功能已从新候选移除**：原候选的 `GET /raindrop/{id}/suggest` 真实测试返回 HTTP 403，旧版 `POST /raindrop/suggest` 也收到 403。新候选完全不再公开；独立旧兼容 `get_suggestions` 暂保留（同样可能遇到 403），不伪造建议。
- **发布边界**：大部分其它候选写入仅 Mock/SDK 测试；`trash_empty` 全局永久清空不可拿真实生产库作测试。当前正常 CI 和 Environment 原有分支限制已恢复，无常驻 Draft 生产 Secret 测试入口。**41→26 工具切换需另外明确授权。**

## 验收含义

- **源码**：已在 Draft 集成分支实现，并非已经发布或真实 API 可用。
- **Mock**：现有 T01–T09 HTTP 样本、失败/重试/安全单测通过；不等于官方现网响应验证。
- **SDK MCP**：常规 Client + InMemoryTransport 测试走真实 MCP 注册与 tools/list、tools/call 边界，通常以 Mock Service/HTTP 验证；另有上文记录的部分 Draft SDK MCP→真实 API 测试，但都不是已部署的生产 Worker。
- **Live**：已有部分 Draft 真实认证 Raindrop API 验收；尚未完成全部工具的生产 MCP/Portal 端到端验证。写入仅对获授权的可丢弃对象测试。
- **破坏性受限**：尤其 trash_empty 是不可逆全局操作，不能用生产库做破坏性验收；必须记录 acceptance-limited 和预览后并发变化的竞态风险。

## 26 候选工具逐项状态

表中“通过*”仅表示 Mock/API 夹具与 SDK MCP 测试。真实 API 列区分 **MCP 实测**（Draft 内存 MCP→真实 API）、**Service 实测**（Draft Service→真实 API）、**未实测**以及 **403 未通过**；不能混为已部署 Worker 的在线能力。

| 候选工具 | 源码 | HTTP Mock | SDK MCP | 真实 API | 切换残余门槛 |
|---|---|---|---|---|---|
| bookmark_search | 已实现/修正 | 通过* | 通过* | MCP 实测通过 | 空查询、分页、过滤算符 |
| bookmark_get | 已实现 | 通过* | 通过* | MCP 实测通过 | 完整书签及高亮 ID |
| bookmark_exists | 已实现 | 通过* | 通过* | 待验收 | 单 URL 存在与否 |
| bookmark_create | 已实现 | 通过* | 通过* | Service 实测（临时书签） | 测试书签写入 |
| bookmark_update | 已实现 | 通过* | 通过* | 待验收 | 仅显式更新字段 |
| bookmark_delete | 已实现 | 通过* | 通过* | Service 实测（仅临时书签） | Trash 状态/永久删除受限 |
| bookmark_move | 已实现 | 通过* | 通过* | 待验收 | 目标收藏夹及归属 |
| bookmark_batch_update | 已实现 | 通过* | 通过* | 待验收 | ≤50 ID、单源、聚合未知 |
| bookmark_batch_delete | 已实现 | 通过* | 通过* | 待验收 | 预检与按 ID 真实结果 |
| collection_list | 已实现/扩展 | 通过* | 通过* | MCP 实测通过 | 已严格拒绝未知字段；真实根/子集合重叠已修复 |
| collection_get | 已实现 | 通过* | 通过* | MCP 实测通过 | 完整子集合/父级 |
| collection_create | 已实现 | 通过* | 通过* | 待验收 | 测试收藏夹 |
| collection_update | 已实现 | 通过* | 通过* | 待验收 | 只更新明确字段 |
| collection_delete | 已实现 | 通过* | 通过* | 待验收 | 级联删除、权限、摘要受限 |
| tag_list | 已实现 | 通过* | 通过* | MCP 实测通过 | 官方 Tag 结构 |
| tag_rename | 已实现 | 通过* | 通过* | 待验收 | 重命名不得误合并 |
| tag_merge | 已实现 | 通过* | 通过* | 待验收 | 多来源合并与回执 |
| tag_delete | 已实现 | 通过* | 通过* | 待验收 | 测试标签删除 |
| highlight_list | 已实现 | 通过* | 通过* | MCP 实测通过 | 属于指定书签 |
| highlight_create | 已实现 | 通过* | 通过* | Service 实测通过 | 定向 PUT/其他高亮不变 |
| highlight_update | 已实现 | 通过* | 通过* | Service 实测通过 | 字符串 ID/所属校验 |
| highlight_delete | 已实现 | 通过* | 通过* | Service 实测通过 | 一条高亮删除 |
| bookmark_filters_get | 已实现 | 通过* | 通过* | MCP 实测通过 | 无统计不能填 0 |
| trash_empty | 已实现 | 通过* | 通过* | **受限** | 不可逆全局清空/完整范围 |
| collection_remove_empty | 已实现 | 通过* | 通过* | 待验收 | 已批准空叶子范围 |
| bookmark_remove_duplicates | 已实现 | 通过* | 通过* | 待验收 | 已验证输出 Schema；副本保护仍待真实数据验收 |


## 旧 17 项到候选契约的迁移映射

| 原有工具 | 候选新工具 / 保留方式 | 功能差异与迁移风险 |
|---|---|---|
| bookmark_search | 同名保留 | 同时支持空查询列表与搜索 |
| collection_list | 同名保留 | 根集合及全部子集合、父级关系 |
| list_raindrops | bookmark_search | 不再维护第二个列表入口 |
| get_raindrop | bookmark_get | 严格数字 ID、结构化详情 |
| bookmark_manage | bookmark_create / update / delete | 旧删除已有 Trash 防绕过；迁移写入参数 |
| collection_manage | collection_create / update / delete | **旧 delete 已拒绝无预览级联删除**；新工具核对全部子树 |
| get_collection_tree | collection_list | 用 parentId 重建层级 |
| tag_manage | tag_list / rename / merge / delete | 避免重命名和合并混淆 |
| highlight_manage | highlight_list / create / update / delete | 指定书签和字符串高亮 ID |
| bulk_edit_raindrops | bookmark_batch_update / batch_delete | **旧写入已拒绝无预检/缺 ID 路径**；新 update 同时支持批量移动 |
| get_suggestions | 暂保留旧工具，无新候选替代 | 现有生产账号建议 API 曾返回 403；兼容入口保留，移除需另行授权 |
| suggest_tags | 暂保留旧工具，不纳入 26 项候选 | AI Sampling 兼容行为独立于已移除的官方建议候选，未来切换另审 |
| library_audit | bookmark_filters_get + bookmark_search | 通过官方筛选加分页组合；不再提供单调用整库审计 |
| diagnostics | 内部观测，不再作为业务工具 | 不属于 26 项，需要另行获准的公开入口清理 |
| empty_trash | trash_empty | 旧 confirm:true 已安全禁止；新工具绑定完整 Trash ID 摘要 |
| cleanup_collections | collection_remove_empty | 旧 PUT /collections/clean 全球清理入口已安全禁止；限定根、空叶子和摘要 |
| remove_duplicates | bookmark_remove_duplicates | 旧 dryRun:false 已安全禁止；单集合候选与副本保留 |

这些迁移并非全部一对一等价：尤其 library_audit、suggest_tags、diagnostics 有**明确功能范围缩减**；不能仅凭名称替换证明已保留全部旧使用体验。最后的移除与公开工具实际切换必须单独授权。

## T10 代码审查发现的缺口及修复

1. **已封堵**：原有 cleanup_collections(confirm:true) 会不经作用域摘要确认调用全局 PUT /collections/clean。现保留工具名，仅返回迁移说明，confirm:true 在上游请求前拒绝。
2. **已封堵**：原有 collection_manage(operation:delete) 可直接级联删除收藏夹；现拒绝该旧操作，指向 collection_delete 的完整子树预览/摘要确认。旧 create/update 暂保留。
3. **已封堵**：原有 bulk_edit_raindrops 可用缺省 ID 更新整集合，且 remove/move 未通过 T06 新鲜逐条成员核验。为避免隐式全量/跨集合写入，旧批量工具保留名称但拒绝全部写入意图，明确指向两个 T06 新工具。
4. **已封堵（先前 T03/T08/T09）**：bookmark_manage 的 Trash 永久删绕过、remove_duplicates 的无摘要清理、empty_trash 的计数式清空分别已拒绝危险路径。
5. **已修复（后续补丁）**：collection_list 使用 strict 输入 Schema，真实 MCP tools/call 已验证未知字段及错误类型被拒绝，且不访问上游。
6. **已修复（后续补丁）**：bookmark_remove_duplicates 已为预览、无需执行及批量失败/未知结果声明并校验输出 Schema；仍需真实 API 验收。
7. **后续已部分推进**：最初 26 项均缺此 Draft 版本的真实认证 MCP/API 验收；最新局部成果详见本文顶部快照；涉及写入的需经单独授权的可丢弃测试对象；全局永久清空记录 acceptance-limited。前述测试矩阵只覆盖模拟场景。

## P0 独立审查后续修复（2026-10-20）

- **已修复单书签删除竞态**：`bookmark_delete` 与旧 `bookmark_manage` 的安全软删入口均改为调用同一 Service 删除方法，必须传入明确原始集合。Service 再次无缓存读取并校验原始集合后，使用官方 `DELETE /raindrops/{collectionId}` + `{ids:[id]}`；仅在调用者显式传入 `-99` 时允许执行永久删除。即使书签在预检和 DELETE 之间转入 Trash，也不会从原集合的 DELETE 升级为永久删除。仅 `result:true` 且 `modified:1` 视作确认，否则返回不确定结果、不得自动重试。
- **已修复重复书签内容保护**：对不同 `title` 或 `excerpt` 的相同 URL 记录拒绝自动清理，缺少上述字段也默认保护；保留现有标签、笔记、高亮、收藏、提醒保护机制。
- **独立 HTTP/SDK Mock 回归**：新增原集合限定、预检过期、不重试及摘要/标题差异等测试；本地 WSL Node22 共 353 passed / 3 skipped / 0 failed，源码/测试 typecheck、lint（0 errors）及 diff-check 通过。Node24 CI 和真实 API 验收仍另行核查。
- **发布门槛不变**：虽然代码级 P0 修复完成，认证只读 smoke、可丢弃数据写入验收、26 项工具最终切换授权均仍缺失；`NO-GO` 保持有效。

## P1 真实只读验收边界（2026-10-20）

- **生产基线已完成（旧版插件，非 Draft）**：通过已连接的 Raindrop MCP 插件诊断版本 `2.4.5`、17 个工具；`collection_list(skipCache:true)` 返回 4 个集合；新鲜的不存在关键词搜索返回 0 条；`list_raindrops(0, perPage:1)` 及 `get_raindrop` 的单条读取响应一致。只记录结构、数量与是否成功，不保留个人书签正文或凭据。
- **严格区分版本**：以上结果来自**已部署的旧版插件**，不能填写 26 个候选工具的 Draft「真实 API」为通过。当前 WSL Shell 无 `RAINDROP_ACCESS_TOKEN` / `MCP_ACCESS_TOKEN`，仓库亦只有 `.env.example`；现有 GitHub Actions 仅在受保护的 main 手动发布作业注入生产密钥，PR CI 无此权限。不得在 PR 作业中暴露生产密钥来凑验收结果。
- **只读测试入口**：新增 `tests/read-only.live.test.ts`，从此 Draft 源码启动内存 MCP 客户端调用 8 个只读候选工具；只在明确设置 `RUN_LIVE_API_TESTS=true` 时运行，并要求已安全注入 `RAINDROP_ACCESS_TOKEN`。其 `fetch` 守卫拦截任何非 GET 请求、非 HTTPS/非 Raindrop API 目标和跳转请求；此守卫另外通过 7 项离线用例，不调用创建、删除、建议 POST 或破坏性清理；无令牌时不做外网请求；测试中不打印个人收藏内容。
- **执行命令**：在凭据经既有授权渠道以环境变量安全注入、且明确设置 `RUN_LIVE_API_TESTS=true` 的独立测试进程中运行 `pnpm --filter raindrop-mcp-worker run test:read-only-live`。命令入口自身拒绝遗漏开关或令牌，避免跳过用例时误报通过。不得在命令行明文写 token、写入 .env、提交日志或把主账户 Token 复制到 GitHub PR 上下文。只读 smoke 完成后仍需另行授权的可丢弃数据环境检验写入，全球 Trash 永久清理继续标记受限。
- **状态**：本次仅编制和本地验证可执行的只读验收入口；Draft 源码**尚未**进行授权的真实上游请求，保持 **NO-GO**。

## P1 预算与显式作用域修补（2026-10-20）

- **重复书签 60 次预算**：`bookmark_remove_duplicates` 只额外复核实际待删除项及其所属分组的保留副本，不对完全无关的单例分组重复获取元数据；保留确认时完整新鲜快照、T06 独立成员核验和写入不重试。确认阶段预估 HTTP 次数为 `3 + 已观察记录数 + 实际复核 ID 数 + 删除候选数 + 1`，超过 60 时在预览中拒绝提供不可执行的确认。本估算不预留 GET 失败重试；实际发生重试仍由现有 Service 全程 60 次上限安全阻断，不能保证每次都执行写入。Mock 证实 50 条已观察记录、1 条待删可以按 57 次请求完成确认；50 条、10 条待删会在预览阶段拒绝。
- **标签写入范围**：`tag_rename` / `tag_merge` / `tag_delete` 以及兼容的 `tag_manage` 都要求显式 `collectionId`：`0` 表示用户主动选择全局操作，正整数限定具体集合，遗漏直接在工具参数边界拒绝。仅只读 `tag_list` 保留省略参数查询全库。新旧工具都受同一严格 Schema 约束，没有新增配置项或服务。
- **验证边界**：均为本地 MCP SDK/HTTP Mock 回归，不是 Draft 的真实认证现网验收；`NO-GO` 不变。

## P1 生产 Raindrop 账号隔离验收（2026-10-20，已部署旧版插件）

用户已明确允许直接使用现有生产 Raindrop 账号进行验收。本轮只操作**专门创建的可丢弃测试对象**，不改动普通用户集合/书签；本节结果**仅验证目前连接的旧版 17 工具 MCP 插件**，并非 Draft PR #134 新代码的真实 API 验收。

| 场景 | 生产实测 | 证据与边界 |
|---|---|---|
| 生产集合列表 | 通过 | 基线 4 个集合，测试前后原有集合 ID 与数量保持一致 |
| 创建测试集合 | 通过 | 创建 ID `76274543`，仅用于本轮隔离验收 |
| 创建测试书签 | 通过 | ID `1895524020`，仅归属测试集合，特殊 URL/tag 易辨认 |
| 单集合分页与 ID 详情 | 通过 | `count=1`，详情 ID、标题、标签一致 |
| 更新标题、描述与标签 | 通过 | 无缓存重新读取，确认更新后的值 |
| 高亮创建（旧 `highlight_manage`） | **失败** | 旧插件返回 `Resource not found`，未取得创建成功回执；不要将此项标为通过 |
| 仅删除测试书签 | 通过软删除 | 精确 ID 删除回执为 `deleted:true`，从源集合消失，在回收站中可查 |
| 更新测试集合标题 | 通过 | 仅更新测试集合 |
| 删除已确认空的测试集合 | 通过 | 源集合核对为 0 项后按 ID 删除，重新列出只有原有 4 个集合 |

**回收站保护**：删除测试书签前回收站已有 2,550 条记录；本轮精确软删除后变为 2,551，其中包含测试书签 ID `1895524020`。**没有执行全局清空**，测试书签留在回收站，不声明已被永久销毁；其他既有回收站记录没有被批量处理。

**高亮失败的可解释线索**：仓库 `main` 的旧 Service 实现通过 `POST /highlights` 创建、`PUT /highlights/{id}` 更新，但 Raindrop [官方 Highlights 文档](https://developer.raindrop.io/v1/highlights) 当前要求在目标书签上执行 `PUT /raindrop/{id}`，通过 `highlights` 数组创建/修改/删除。Draft T07 已采用官方目标书签 PUT 的方法并有 HTTP Mock 验证。这一旧实现的路径差异**可能**解释生产旧插件的 404；未取得生产 HTTP 请求日志，不能仅凭返回信息断言根因已经完全证实。不能把旧版失败归咎为 Draft 失败，也不能把 Draft Mock 成功当真实修复已通过。

**官方端点核查与防回归（2026-10-20）**：官方 [Highlights API](https://developer.raindrop.io/v1/highlights) 明确规定高亮创建、修改、删除都使用 `PUT /raindrop/{id}` 的 `highlights` 补丁，且高亮 `_id` 是字符串；对照当前生产 `main` 的旧 Service，旧实现创建为 `POST /highlights`，是与官方规范不一致的明确代码事实。生产工具返回 404 与此一致，但未取得请求追踪，仍不宣称完全证实该 404 的唯一原因。Draft T07 新代码已经走官方 PUT，本轮新增 `tests/highlight_contract_replay.test.ts` 三项从 SDK `tools/call` 走到真实 Service HTTP 请求构造的 Mock 回归：新 `highlight_create`、兼容 `highlight_manage(create)` 均只产生 `GET → PUT /raindrop/{id}`，绝不重走旧 `POST /highlights`；目标 GET 返回 404 时仅一条 GET，拒绝写入/不自动重试。属于**凭据隔离的 HTTP Mock 验证**，不是 Draft 现网写入验证。

**后续验收结论**：现有已部署插件的一部分生产读写链路可用；Draft 专用的 8 项认证只读 smoke、Draft 新版高亮 PUT 的真实验收、其他具有破坏性的候选操作仍待安全注入 Token 或经单独授权的部署执行。此生产账号虽可用于可丢弃对象验收，但 `NO-GO` 与明确的工具切换授权门槛不变。

## P1 新版真实调用准备：修复测试入口（2026-10-20）

- 发现两个既有真实 API 测试隐患：`tests/mcp.integration.test.ts` 和 `tests/destructive.live.test.ts` 虽通过环境变量决定是否启用测试，却实例化未传入 Access Token 的 Service；后者还传入新版 Service 已拒绝的 `createBookmark(0,...)`。两处现已显式从测试进程的 `RAINDROP_ACCESS_TOKEN` 注入，创建书签时不传入集合 ID，使用 Raindrop 默认 Unsorted 位置。两个测试移除了自动读取本地 `.env` 的逻辑，防止凭据来源不透明。
- `destructive.live.test.ts` 现使用**只属于本次测试的随机唯一 URL + 返回的书签 ID**进行完整高亮创建/读取/更新/删除真实接口验收。仅通过精确 ID 和原 URL 再次核对后进行测试书签清理；先限定原集合软删，确认已进入 Trash，才限定 Trash 删除该测试书签。绝不调用全局 `trash_empty` 或对未知书签动手。清理失败必须报告测试失败，不再静默忽略。
- 运行仍采用原有显式开关，不新增服务、Worker、环境变量名或 CI Secret：`RUN_DESTRUCTIVE_LIVE_TESTS=true`、`CONFIRM_DESTRUCTIVE_LIVE_TESTS=DELETE_ONLY_TEST_BOOKMARKS` 和测试进程 `RAINDROP_ACCESS_TOKEN` 缺一不会发出测试请求。只需在持有 Token 的本机 WSL 终端进入仓库根目录后运行：

```bash
cd apps/raindrop-mcp-worker
bash -c 'set -eu; IFS= read -rsp "Raindrop API Token: " RAINDROP_ACCESS_TOKEN </dev/tty; printf "\n"; export RAINDROP_ACCESS_TOKEN RUN_DESTRUCTIVE_LIVE_TESTS=true CONFIRM_DESTRUCTIVE_LIVE_TESTS=DELETE_ONLY_TEST_BOOKMARKS; ./node_modules/.bin/vitest run tests/destructive.live.test.ts'
```

- **证据等级**：本轮仅静态检查及无令牌跳过验证；由于 Remote Control WSL Shell 无 Raindrop Token，尚未执行 Draft 的认证读写。生产旧版插件此前已实测，但它的连接凭据无法直接交由另一进程使用。不得以为本段已经完成了新版的真实高亮验收。

## 认证验收可信度修正（2026-10-20）

- `tests/read-only.live.test.ts` 原来在未选出真实集合/书签时返回成功，导致 `collection_get`、`bookmark_get`、`highlight_list`、当时尚存在的 `bookmark_suggest` 有可能未实际调用就被记为通过。现要求本账号至少有 1 个集合和 1 条书签；缺少目标 ID 时对应场景**明确失败**，不会出现「空数据假绿灯」。只读测试仍仅允许 HTTPS 官方 GET 且不跟随重定向。
- 旧 `test:e2e` 命令原先在没有凭据或显式开关时得到全体 skipped，却可能以 0 退出。现与 `test:read-only-live` 一致，要求 `RUN_LIVE_API_TESTS=true` 和安全注入 `RAINDROP_ACCESS_TOKEN`，否则在 Vitest 启动前退出非零；未额外增加服务或配置键。
- 上述均是**验收工具准确性改进**，不涉及外部账号数据。本轮没有触发新版 Draft 的实际认证请求、上线或工具切换；`NO-GO` 保持。

## 高亮未知回执缓存安全修复（2026-10-20）

- **问题**：高亮 PUT 已发送，但响应缺少可验证的结果或网络出现异常时，Service 返回 `status:unknown` 且禁止自动重试，但旧版仅在确认成功后失效 `cacheBookmarks` 和 `cacheSearch`。如果此前读过这个书签，后续 `bookmark_get` 可能直接返回**写入前缓存**，干扰用户对「未知写入」的人工复核。
- **最小修复**：高亮写入请求 Promise 一旦结束（成功、拒绝或网络异常），一律失效当前书签 ID 与搜索缓存；预检失败时仍不执行写入、也不失效缓存。此举只影响本地缓存，不新增上游调用、不改变目标或 payload、不自动重试写入。
- **验证**：`highlights.service.test.ts` 加入完整路径的缓存回归，先填充书签读取缓存，再模拟 `PUT` 返回不完整结果，确认 `status:unknown` 后下一次 `getBookmark` 必须再次 GET；成功与未知结果的缓存断言均已更新。该修复属于本地 HTTP Mock 检验，**Draft 真实 API 写入验收仍未完成**。

## Draft 源码生产账号认证只读验收（2026-10-20）

使用现有 GitHub Environment `raindrop-mcp-worker` 中的 `RAINDROP_ACCESS_TOKEN`，由仓库所有者手动触发**临时、仅 GET**的 Actions 验收作业，以 Draft 源码运行内存 MCP Client；没有向 WSL 或日志导出明文 Token，也没有部署 Worker、合并 PR 或操作生产书签。临时 CI 验收入口及脱敏排障代码在验收结束后已撤销，不保留扩大 Draft Secret 使用范围的常驻权限。

- [首次真实只读验收 #39436009140](https://github.com/lirtual/mcp-workers/actions/runs/39436009140)：10 项中 7 通过、3 失败。真正调用了 Raindrop API，不属于 Mock 测试。
- [类型/状态排障 #39436971993](https://github.com/lirtual/mcp-workers/actions/runs/39436971993)：`GET /collections` 与 `GET /collections/childrens` 均 200 且 `result:true`；两个数组分别有 4 和 1 条记录，但同一个 ID 跨接口重复出现 1 次。新版 `collection_list` 此前错误地拒绝所有重复，因此实际用户的列表和依赖列表的 `collection_get` 验收失败。已按同 ID、同标题及父级不冲突的限制合并跨接口重叠项，并为相互矛盾的条目保留明确拒绝。
- [移除前真实只读复测 #39437631284](https://github.com/lirtual/mcp-workers/actions/runs/39437631284)：**当时 10 项中 9 通过、1 失败**。`collection_list`、`collection_get`、`bookmark_search`、`bookmark_get`、`highlight_list`、`tag_list`、`bookmark_filters_get` 及工具注册/无写入校验均通过；`bookmark_suggest` 调用官方 `GET /raindrop/{id}/suggest` 获得上游 **HTTP 403**。接口路径与官方文档相符，但该 Token/目标书签的建议能力暂无法通过；不推断 403 的具体授权原因，也不把它改标为通过。
- **安全与发布结论**：上述请求只访问现有生产账号、不写入数据；没有运行新版创建、编辑、高亮写入或永久删除的真实验收。26 项候选工具尚不满足全部真实 API 发布门槛，`NO-GO`，PR 保持 Draft。不得把原生产旧版插件的读写成功结果作为此 Draft 写入通过。

## P1 新版高亮真实写入验收及建议 403 复现（2026-10-20）

- **生产认证链路**：临时 owner-only 的 Actions 作业复用现有 GitHub Environment `raindrop-mcp-worker` 的 `RAINDROP_ACCESS_TOKEN`，在 Draft 源码上执行 `tests/destructive.live.test.ts` 的**唯一高亮生命周期场景**，不是运行整个破坏性测试套件；密钥未导出到 WSL 或 Git 日志，没有部署 Worker。
- **真实写入 PASS**：[GitHub Actions #39439062465](https://github.com/lirtual/mcp-workers/actions/runs/39439062465) 成功，明确 `1 passed / 1 skipped`。在生产 Raindrop 账号中随机创建**一条自有可丢弃书签**，执行新版高亮创建、按 ID 读取、更新备注、删除高亮、核对空结果。测试的精确 ID+唯一 URL 清理和永久删除后 404 验证也通过；不对用户其他书签或整个回收站操作。
- **建议接口限制，仍不通过**：此前 [#39437631284](https://github.com/lirtual/mcp-workers/actions/runs/39437631284) Draft 的 `GET /raindrop/{id}/suggest` 返回上游 HTTP 403。通过已部署的**旧版生产 Raindrop MCP 插件**对公开示例 URL `https://example.com` 请求官方建议（关闭 AI Sampling），也得到 403 Forbidden；两者使用现有生产账号，但分别调用现有书签 GET 建议和 URL POST 建议。这说明 403 不是 Draft 的集合去重/建议输出 Schema 特有的故障。不能由此确定具体权限、账号等级或 Raindrop 服务策略；该工具仍标记真实验收未通过，不构造或猜测建议。
- **临时入口恢复**：完成真实验收后，从 Draft 恢复原始 `.github/workflows/ci.yml`，删除临时生产 Secret 写入验收作业与 Draft 手动测试分支豁免。保持正常 PR 仅做无密钥自动化、受保护 `main` 上的既有手动部署条件。
- **结论**：新版核心高亮路径的生产读写已验收通过；真实只读 9/10 通过，唯一未通过的是上游建议接口 403；还未覆盖全部其它破坏性操作的真实生产验收。仍不应自动标记 27 工具全部通过，不合并或部署，不执行 41→26 工具切换。

## 发布风险核对

| 风险 | 已有控制 / 证据 | 结论 |
|---|---|---|
| Portal 与凭据 | 现有 worker.security.test.ts：401/403/503、Origin、两种独立 Token | Mock 通过；待真实认证试用 |
| 官方端点与 -99 | Service Mock 覆盖单条/批量、标签、高亮和 DELETE /collection/-99，不将其当 DELETE /raindrops/-99 | Mock 通过；待官方真实账户验收 |
| 请求预算 | Service 请求中间件计入重试、最多 60 次 HTTP；分页大范围 fail-closed | Mock 通过；非全局账户限流 |
| ID/来源/权限 | T03/T06/T07/T08/T09 全量预检、根/子级、保留副本、Empty Trash 全成员摘要 | Mock 通过；仍有确认与执行间竞态 |
| 写入不确定性 | 不自动重放写入；聚合修改数不冒充逐条成功；unknown 须人工检查 | Mock 通过；真实错误形态待测 |
| 旧工具安全绕过 | 三个清理旧入口、旧集合 delete 和旧批量写入口拒绝危险行为 | 必须继续由公开 MCP 协议回归测试锁定 |
| 关键能力迁移 | 17→26 映射已列；创建/编辑/移动、层级、标签、高亮、软删及单独授权永久删都有候选路径 | **不能仅凭 Mock 证明现有真实工作流无回归** |
| 工具数量与说明 | 41 个共存是过渡状态；26 是候选清单，不是发布配额 | 未获授权，不移除旧别名 |
| 预览哈希 | 稳定成员摘要能阻止确认阶段的成员替换 | 非锁、非事务；不能保证确认后的零竞态 |

## 最小后续门槛与切换结论

### 凭据和发布门槛

已在受控 GitHub Actions 中复用现有 `raindrop-mcp-worker` Environment Secret 完成上述实测，**无需另建 Token 或要求用户再次在 WSL 输入密钥**。临时只读/写入验收作业均已从 Draft 删除；未来如需补充真实测试，继续短时、明确限制作用域，不复制生产 Token 到 PR 日志或 WSL。

**当前判定：NO-GO / BLOCKED，保留 Draft。** 当前源代码共 **41 个注册名称 = 26 个候选 + 15 个旧兼容**；42/27 只是更早提交的历史数量。未经单独批准，不得将 41 项直接删减为 26 项，也不能将任何 Mock 成功描述为真实上游成功。

- **已完成**两处 Schema 缺口及对应 MCP tools/call 回归；下列真实验收门槛依然有效。
- 已用现有认证环境完成只读 9/10 与可丢弃高亮写入验收；其余需要安全证明的关键写入和异常响应仍需按需补足，不修改普通用户书签；不可安全实测的 Trash 全局永久清空保留 acceptance-limited。
- 将旧生产关键工作流与新工具逐项比对并进行独立代码审查；任何无法确认的候选工具在切换时必须安全排除，不为了 26 项配额强行公开。
- **只有取得另一次明确的切换授权**，才可在另外的实施中移除旧别名、Sampling、library_audit、公开 diagnostics 并刷新测试清单；本轮 T10 不执行这些动作。关闭评估 Ticket 也不是生产发布许可。

**证据范围：** #124–#132 的 Draft 代码、Mock API/SDK MCP/Portal 测试；T10 新增对安全旧入口的 SDK tools/list 与 tools/call 验证。GitHub Actions/CI 仅证明对应源码通过自动化；**本轮另有对生产 Raindrop 账号隔离可丢弃数据的真实读写验收**（详情见 P1 生产账号隔离验收章节），未修改生产 Worker 或 PR CI 凭据。


## P0 补充安全复核：Environment 授权边界与真实验收门槛（2026-10-20）

- **复核范围（源码层，不冒充外部独立审查）**：当前 Draft 41 个名称（26 新候选 + 15 旧兼容）；对照官方 Raindrop API 核对原集合限定的 `DELETE /raindrops/{collectionId}`、显式 ID 批量 `PUT/DELETE /raindrops/{collectionId}`、`PUT/DELETE /tags/{collectionId}`、书签范围内高亮补丁、`DELETE /collection/{id}` 和全局回收站 `DELETE /collection/-99`。源码及已运行 Mock/SDK 测试显示旧 `empty_trash`、`cleanup_collections`、`remove_duplicates`、`bulk_edit_raindrops` 的危险意图均被拒绝，旧 `collection_manage(delete)` 被禁用，旧 `bookmark_manage(delete)` 与原子入口复用有原集合核验的 Service 方法。此项是针对性审查证据，**不等于整份 PR 的独立安全审查签字**。
- **官方 API 的真实回执限制**：官方批量更新仅返回聚合 `modified`，不足以证明每个 ID 都成功；Draft 的 `bookmark_batch_update/delete` 对单项结果仍返回 `unknown`，禁止以聚合数捏造逐项成功。标签官方契约使用 `{tags,replace}` 重命名/合并及 `{tags}` 删除。若真实写入的结果与 Mock 不一致，先停下来核对原因，不新增兼容层。
- **已观察到的 GitHub Environment 配置风险**：对 `raindrop-mcp-worker` 的只读 GitHub Environment 元数据查询返回 `deployment_branch_policy: null`、`protection_rules: []`，即没有单独的 Environment 分支/审批保护；当前唯一 CI `.github/workflows/ci.yml` 的正式发布作业通过 `workflow_dispatch + refs/heads/main` 和预检进行代码级发布限制。**这不证明密钥泄露或当前 CI 绕过**，但未来若修改同仓 PR 工作流以引用该 Environment，可能新增接触生产密钥的路径。建议在另行明确批准后为现有 Environment 评估/配置受限分支，不新建密钥系统；本次不改 Environment。
- **不以部署换验收**：当前仅有的正常 CI 无受控 Draft 写入验收作业；`RAINDROP_ACCESS_TOKEN` 未注入 WSL 会话，且生产密钥不应复制到工作树或日志。不得用 `main` 的正式发布 dispatch、放宽保护规则、长期保留 PR 密钥作业来规避真实验收门槛。
- **剩余最小真实验收**：在明确安全授权的既有受控密钥通道中，仅创建两份可丢弃 collection、少量唯一 URL bookmark 与隔离 tag；依次验证 collection 创建/更新/定向删除，bookmark 更新/移动/软删，tag 重命名/合并/删，以及严格显式 ID 的批量作用域拒绝。每次以官方 GET 独立核实目标 ID 与修改后状态；未知回执不重试，停止并检查。只能清理本轮精确新建的 ID，绝不执行 `trash_empty(confirm:true)` 或影响其他回收站项目。
- **验收结论**：离线合同和模拟保护通过，Draft 的上述关键真实写入、部署链路端到端认证及独立全 PR 安全审查仍未完成，保持 **NO-GO / Draft**，不合并、不部署、不移除旧兼容工具。


## 完整 Draft 独立只读审查与最小修复（2026-10-20）

- 通过 WSL 已安装的 Codex CLI `exec review --base origin/main` 对 PR #134 完整差异做只读独立审查，**没有访问真实 Raindrop 数据、改动生产环境或创建 Tickets**。
- 审查提出 3 项可定位的 **P2 正确性问题**，均在现有 Service / MCP 工具契约处修复，不新增依赖或架构：
  1. `deletionTree` 原本会拒绝 `/collections` 与 `/collections/childrens` 返回的合法一致重叠；现在接受一致记录、使用明确的父级，仍拒绝单接口重复、冲突元数据、孤儿或循环结构。补充正常重叠预览/确认和冲突拒绝 Mock。
  2. `bookmark_get` 原本从输出丢弃系统收藏夹 `-1` / `-99`；现在其只读输出 Schema 允许真实返回的这两个 ID，供软删除后状态核对；写入工具的来源作用域及危险系统 ID 禁止规则**不变**。
  3. `collection_create/update` 原本在上游写入回执丢失时返回普通 MCP 错误；现结构化标记 `status:unknown` 并禁止盲目重试，确定的前置验证/鉴权/不存在仍直接错误。成功返回 `status:succeeded` 和精确收藏夹数据，不将响应未证实的写入报成功。补充 MCP 客户端模拟回执丢失回归。
- 本轮此前还修复官方收藏夹 `result:true`、正整数 `_id` 及更新字段回执核验缺口，补充 7 个 Service HTTP 样本；Mock 和 SDK 仅证明响应处理正确，不代表真实 API 已验收。
- **发布门槛保持**：本地及 Node24 CI 状态单独记录；缺少此 Draft 对现有生产 Token 的隔离 collection/bookmark/tag/batch 真实写入验收，以及部署后 Portal 真实新版工具调用。全局 `trash_empty` 永久清空仍属 `acceptance-limited`。**NO-GO**，维持 Draft，不删除旧兼容工具、不合并或部署。


### 修复提交二次聚焦复审（2026-10-20）

- 独立 Codex `exec review --commit 0d91249` 发现：收藏夹写入工具的 `unknown` 包装错误吞掉了明确的上游 `RateLimitError`（HTTP 429）及其等待提示，尤其可能将父收藏夹预检的 429 误报为写入结果未知。
- 最小修正为将 `RateLimitError` 与 Validation/Auth/NotFound 一起直接抛出；禁止重试已提交的写入、其他未知回执行为和工具数量均不变。对应 `collection_create/update` 的 MCP 测试增加模拟限流与等待信息保留断言。
- 此改动尚须按最新源提交跑完整 Mock/SDK、typecheck、Node24 CI；**不可凭单次局部审查宣告整个 Worker 生产验收完成**。

## S1 最小真实写入验收入口（待执行，2026-10-20）

- 新增单场景 `tests/spec123-disposable.live.test.ts`，**只用于显式授权的可信终端/作业**；普通 CI 无 Raindrop Token 时自动跳过，单独的 TypeScript 检查不涉及真实 API。
- 复用现有 `RAINDROP_ACCESS_TOKEN` 和两项显式开关 `RUN_DESTRUCTIVE_LIVE_TESTS=true`、`CONFIRM_DESTRUCTIVE_LIVE_TESTS=DELETE_ONLY_TEST_BOOKMARKS`。不创建额外密钥、Worker、数据库或持久化任务。
- 仅生成随机命名的两个私有集合、三个唯一 URL 书签与唯一标签，测试创建/更新、移动/软删、限定标签重命名合并删除、批量显式 ID 修改及错误作用域拒绝；逐 ID 使用真实 GET 独立复核聚合写入返回的 `unknown`。清理只能在再次验证原始 ID、URL、集合标题和空集合预览一致后执行，且仅永久删除此次创建的书签；从不运行全局 Trash 清空。任何不确定结果停止盲目重试，输出失败证据。
- 当前标准 CI 只在 `main` 发布作业注入生产 Secret，**不能把 `main` 发布视为 Draft 验收**。复核曾成功使用的临时受控 Actions 方案后，当前操作接口的安全检查未批准新增引用该生产 Secret 的 Draft 作业；本轮未创建、触发或隐藏此作业，也未部署。避免换其他路径绕过该授权限制。
- 在获许可的可信终端可以用不回显的方式显式注入 Token 后运行单个测试文件（例如终端内执行 `read -rs RAINDROP_ACCESS_TOKEN`，随后导出变量及两个显式开关）。**不要把 Token 粘贴到 ChatGPT、Issue、PR 或工作流日志中**。在实际运行结果及最终清理证据未获得前继续 **NO-GO / Draft**。


### 真实验收脚本预执行安全校验（2026-10-21）

- 检查到 `spec123-disposable.live.test.ts` 的错误作用域场景误将预期的 MCP `isError:true` 当作普通返回；已仅针对 `status:failed` 接受此预期结果，其他 MCP 错误继续停止验收。
- 为避免将多个候选工具调用和末尾清理累计到同一个 60 次上游请求预算，清理流程改用独立且无需额外凭据的 Service 实例；不增加上游 Worker 或服务层。
- 清理只根据事前记录的随机测试 URL、精确 ID、原集合与唯一测试集合名执行；某条清理失败会继续尝试其他已经核实身份的测试对象，但最终必须汇总失败并判 FAIL。若 POST 回执丢失而尚未获得书签 ID，会明确报告原测试 URL 需要人工核查，**绝不凭模糊匹配删除他人书签，也不虚报清理通过**。
- 本地 TypeScript、ESLint 与 `test:local` 通过；无 Token 场景正确跳过 Live，用于验证隔离门槛而非真实写入完成。只读独立复审没有发现此补丁新增明确缺陷。依然 **NO-GO**，只在现有授权途径真正完成测试、核实所有测试对象清理后更新发布状态。

## 发布门槛顺序收敛（2026-10-21：仅文档，不授权执行）

以前部分说明将“新版 Portal 真实端到端验收”列在“首次部署之前”。这形成循环依赖：新版 Worker 不部署就无法进行新版生产 Portal 验收。本节明确 G0/G1/G2 三阶段，历史 NO-GO 均按实际阶段解读，不增加 staging、Worker、密钥或部署流程。

### G0 — 合并与部署前

- 当前 Draft：26 个新候选 + 15 个兼容名称 = 41 个工具名称；现网 17 个旧工具中有两个名称与新候选重合（collection_list 和 bookmark_search），**其余 15 个均仍在 Draft 保留**，包含 get_suggestions 和 suggest_tags。首次上线建议原样保留，单独批准前不删旧工具，也不把 26 当发布必须达到的上限。
- 复用完整源码独立审查、TypeScript、SDK/Mock、鉴权拒绝、60 次请求预算、受保护删除和最新 Node24 CI 证据；CI/Mock 不等于真实上游操作。
- 在**已授权且凭据隔离**的环境中对 Draft 完成最小真实上游验收：只使用新建可丢弃的两个 collection、三个有唯一 URL 的 bookmark、随机 tag；验证创建/更新/移动/软删、定向空集合删除、tag 重命名/合并/删、显式 ID 批量作用域拒绝与聚合回执逐 ID GET 核实。任何写入结果未知时不自动重试；测试对象无法确证或清理失败即报告阻塞。之前成功的高亮实测证据复用。
- trash_empty 全局永久清空已明确只要求安全模拟（#132 acceptance-limited）；不为 G0 做真实全局清空，不处理历史回收站测试书签。
- GitHub PR CI 不接触生产 Environment Secret；先前尝试新增带生产 Secret 的 Draft 作业未获安全许可。不能通过同义临时作业、复制凭据到 WSL、或触发 main 发布来绕过限制。
- G0 完成只表明具备**请求另一次明确合并/生产发布授权**的条件，不是默认授权。

### G1 — 单独授权后才执行合并与发布

- 将 PR #134 切换为 Ready、合并 main，并只通过现有 ci.yml 的 main workflow_dispatch 选择 raindrop-mcp-worker；保留现有 GitHub Environment、Wrangler、全部 15 个兼容入口。不新增部署机制。
- 记录源码 SHA、Actions run、Cloudflare active version。CI 与部署动作成功不代表 G2 自动验收成功。
- 未达到 G0 或尚无明确合并/部署授权时，不执行 G1。

### G2 — 真正部署之后

- 用现有 MCP Portal 鉴权与 Worker 请求检查工具列表确有 41 个名称，真实无效 Bearer 拒绝，并经授权验证少量真实读写与旧兼容调用。刷新 MCP 插件，核对实际工具清单。此阶段才有条件声明**新版 Portal 真实 E2E**，不能反过来作为 G0 的硬前置。
- 若新版 Portal/写入/工具列表不符合预期，立即停止收尾并记录实际版本。现有 CI 明确不做自动回滚；只评估已有 Cloudflare 版本恢复手段，需要相应操作授权，不得虚称自动恢复。
- G2 验收成功后再处理剩余 Tickets 与父 Spec 关闭；单项源码 Ticket 可以按其原验收标准先行独立关闭。

**当前阶段：G0 NO-GO。** Draft 关键 collection/bookmark/tag/batch 的隔离真实写入仍未取得证据；G1/G2 均未执行。以上仅为发布顺序澄清，不改变生产配置或密钥权限。


### G0 可执行入口与真实 Favorite 正负样本（2026-10-21）

- 在现有 `tests/spec123-disposable.live.test.ts` 的随机命名私有测试集合中，三个原本必须创建的书签现在显式标记为 **1 个 `important:true` 与 2 个 `important:false`**。真实执行时，先用不缓存的 Draft `bookmark_search(collection=a,important:true/false)` 分别核对包含/排除的精确 ID，再进入原有移动/批量/tag/删除阶段。**无需额外真实写入**，同时补齐原先缺失的 Favorite 正负对照。失败则停止后续正常操作并按已核实身份清理。
- 新增唯一建议使用的安全入口：`pnpm --filter raindrop-mcp-worker run test:live:spec123`。此命令启动前必须同时看到经授权注入的进程环境变量 `RAINDROP_ACCESS_TOKEN`、`RUN_DESTRUCTIVE_LIVE_TESTS=true` 及 `CONFIRM_DESTRUCTIVE_LIVE_TESTS=DELETE_ONLY_TEST_BOOKMARKS`。否则**退出非零并注明 G0 NOT RUN**，避免直接执行 Vitest 时把 skipped 误认为真实验收通过。不得把 Token 贴进 PR、工作流日志、聊天或文档。
- 当前 WSL 未有可用 Token，**只实际验证了非零拒绝路径**，本地 TypeScript、ESLint 与 377 passed / 3 skipped 的 Mock 套件通过；尚未执行真实写入、Favorite 过滤或精确清理。此更新不修改生产代码、Runner、GitHub Environment 或发布流程。G0 仍 NO-GO。


### G0 首次真实 API 验收失败后的保守修复（2026-10-21）

- [Actions #39519905146](https://github.com/lirtual/mcp-workers/actions/runs/39519905146) 在 owner-only 临时 Job 中使用原有 GitHub Environment Token 运行**固定旧源码提交** `6b894b5` 的可丢弃数据验收。真实 Job 失败：测试在 finally 清理两个新建根集合时出现 `Invalid child collection scope`，**原始前段测试失败原因可能被覆盖**。不能把本次尝试算作 Favorite/批量/标签/完整清理通过。发布 Job Skipped；临时 Job 已于 `0de58c6` 撤销。
- 旧版生产 Raindrop 插件只读核实两个新建集合均为根级、没有子集合、直属书签数为零。第一个精确 ID 的定向删除获 `deleted:true` 回执；第二个精确 ID 的删除及后续再次读取受到平台安全检查限制，仍**不能**标记为已完成清理。不得改用其它接口绕过限制；需账户所有者按此前指定的唯一名称/ID 在 Raindrop UI 另行核查，不清空整个 Trash。
- 原因分析：Draft `deletionTree` 的 `/collections/childrens` 适配器看到缺失正数父 ID 的记录会报 `Invalid child collection scope`。Raindrop 官方契约要求它只返回嵌套集合，故**暂不确认真实响应为何缺父 ID**；保守修复只允许和 `/collections` 根列表的 ID + 标题 + 空父级完全相符的重复根记录，未知无父级成员、重复成员、冲突元数据仍拒绝；新增 HTTP Mock 覆盖成功与拒绝分支。原有完整子树 SHA-256、权限、直属数、60 次请求预算保持不变。
- Live 验收脚本原先 `finally` 的 cleanup 异常会覆盖更早的失败；现分别捕获原始失败和清理失败，必要时返回双错误。**补丁只证明代码逻辑和 Mock，未复跑真实 API，也未验证真实返回恰好是根记录重影。**
- 截止目前 **G0 仍 NO-GO**。剩余一个测试集合清理状态尚待用户核实，任何新的真实写入验收必须在完成旧测试数据核对、审查补丁及另行授权后才可以执行，不直接复用已撤销临时 Job。
