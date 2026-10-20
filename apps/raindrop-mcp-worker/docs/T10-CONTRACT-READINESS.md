# T10 — Spec #123 公开契约切换就绪审查（2026-10-20）

**结论：BLOCKED（不得执行公开契约切换）。** Draft PR #134 当前共注册 **42 个工具 = 27 个目标候选 + 15 个其余旧工具**；其中 bookmark_search 与 collection_list 属于同名原有工具。此文只证明就绪状态与缺口，不授权合并 main、移除旧工具、部署 Worker、刷新插件、使用真实数据或调用真实 Raindrop。

## 验收含义

- **源码**：已在 Draft 集成分支实现，并非已经发布或真实 API 可用。
- **Mock**：现有 T01–T09 HTTP 样本、失败/重试/安全单测通过；不等于官方现网响应验证。
- **SDK MCP**：现有 Client + InMemoryTransport 通过真实 MCP 注册与 tools/list、tools/call 边界验证，但 Service/HTTP 仍使用 Mock，不能称为已连接真实部署。
- **Live**：全部候选功能尚无此 Draft 修订版的真实认证 Raindrop / Portal 上游验收。只可在单独批准的可丢弃环境验证写入。
- **破坏性受限**：尤其 trash_empty 是不可逆全局操作，不能用生产库做破坏性验收；必须记录 acceptance-limited 和预览后并发变化的竞态风险。

## 27 候选工具逐项状态

表中“通过*”仅表示 Mock/API 夹具与 SDK MCP 测试，不代表已真实接入官方账户。真实状态若为“受限”，也不等于验收失败。

| 候选工具 | 源码 | HTTP Mock | SDK MCP | 真实 API | 切换残余门槛 |
|---|---|---|---|---|---|
| bookmark_search | 已实现/修正 | 通过* | 通过* | 待验收 | 空查询、分页、过滤算符 |
| bookmark_get | 已实现 | 通过* | 通过* | 待验收 | 完整书签及高亮 ID |
| bookmark_exists | 已实现 | 通过* | 通过* | 待验收 | 单 URL 存在与否 |
| bookmark_create | 已实现 | 通过* | 通过* | 待验收 | 测试书签写入 |
| bookmark_update | 已实现 | 通过* | 通过* | 待验收 | 仅显式更新字段 |
| bookmark_delete | 已实现 | 通过* | 通过* | 待验收 | Trash 状态/永久删除受限 |
| bookmark_move | 已实现 | 通过* | 通过* | 待验收 | 目标收藏夹及归属 |
| bookmark_batch_update | 已实现 | 通过* | 通过* | 待验收 | ≤50 ID、单源、聚合未知 |
| bookmark_batch_delete | 已实现 | 通过* | 通过* | 待验收 | 预检与按 ID 真实结果 |
| collection_list | 已实现/扩展 | 通过* | 通过* | 待验收 | 已严格拒绝未知字段（MCP 已验证）；仍待真实 API |
| collection_get | 已实现 | 通过* | 通过* | 待验收 | 完整子集合/父级 |
| collection_create | 已实现 | 通过* | 通过* | 待验收 | 测试收藏夹 |
| collection_update | 已实现 | 通过* | 通过* | 待验收 | 只更新明确字段 |
| collection_delete | 已实现 | 通过* | 通过* | 待验收 | 级联删除、权限、摘要受限 |
| tag_list | 已实现 | 通过* | 通过* | 待验收 | 官方 Tag 结构 |
| tag_rename | 已实现 | 通过* | 通过* | 待验收 | 重命名不得误合并 |
| tag_merge | 已实现 | 通过* | 通过* | 待验收 | 多来源合并与回执 |
| tag_delete | 已实现 | 通过* | 通过* | 待验收 | 测试标签删除 |
| highlight_list | 已实现 | 通过* | 通过* | 待验收 | 属于指定书签 |
| highlight_create | 已实现 | 通过* | 通过* | 待验收 | 定向 PUT/其他高亮不变 |
| highlight_update | 已实现 | 通过* | 通过* | 待验收 | 字符串 ID/所属校验 |
| highlight_delete | 已实现 | 通过* | 通过* | 待验收 | 一条高亮删除 |
| bookmark_filters_get | 已实现 | 通过* | 通过* | 待验收 | 无统计不能填 0 |
| bookmark_suggest | 已实现 | 通过* | 通过* | 待验收 | 官方建议/无 Sampling |
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
| get_suggestions | bookmark_suggest | 官方建议，验证字段含义 |
| suggest_tags | 有意不保留服务端 Sampling | AI 推断留在对话端，官方建议来自 bookmark_suggest |
| library_audit | bookmark_filters_get + bookmark_search | 通过官方筛选加分页组合；不再提供单调用整库审计 |
| diagnostics | 内部观测，不再作为业务工具 | 不属于 27 项，需要另行获准的公开入口清理 |
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
7. **未解决**：27 项均缺此 Draft 版本的真实认证 MCP/API 验收；涉及写入的需经单独授权的可丢弃测试对象；全局永久清空记录 acceptance-limited。前述测试矩阵只覆盖模拟场景。

## P0 独立审查后续修复（2026-10-20）

- **已修复单书签删除竞态**：`bookmark_delete` 与旧 `bookmark_manage` 的安全软删入口均改为调用同一 Service 删除方法，必须传入明确原始集合。Service 再次无缓存读取并校验原始集合后，使用官方 `DELETE /raindrops/{collectionId}` + `{ids:[id]}`；仅在调用者显式传入 `-99` 时允许执行永久删除。即使书签在预检和 DELETE 之间转入 Trash，也不会从原集合的 DELETE 升级为永久删除。仅 `result:true` 且 `modified:1` 视作确认，否则返回不确定结果、不得自动重试。
- **已修复重复书签内容保护**：对不同 `title` 或 `excerpt` 的相同 URL 记录拒绝自动清理，缺少上述字段也默认保护；保留现有标签、笔记、高亮、收藏、提醒保护机制。
- **独立 HTTP/SDK Mock 回归**：新增原集合限定、预检过期、不重试及摘要/标题差异等测试；本地 WSL Node22 共 353 passed / 3 skipped / 0 failed，源码/测试 typecheck、lint（0 errors）及 diff-check 通过。Node24 CI 和真实 API 验收仍另行核查。
- **发布门槛不变**：虽然代码级 P0 修复完成，认证只读 smoke、可丢弃数据写入验收、27 项工具最终切换授权均仍缺失；`NO-GO` 保持有效。

## P1 真实只读验收边界（2026-10-20）

- **生产基线已完成（旧版插件，非 Draft）**：通过已连接的 Raindrop MCP 插件诊断版本 `2.4.5`、17 个工具；`collection_list(skipCache:true)` 返回 4 个集合；新鲜的不存在关键词搜索返回 0 条；`list_raindrops(0, perPage:1)` 及 `get_raindrop` 的单条读取响应一致。只记录结构、数量与是否成功，不保留个人书签正文或凭据。
- **严格区分版本**：以上结果来自**已部署的旧版插件**，不能填写 27 个候选工具的 Draft「真实 API」为通过。当前 WSL Shell 无 `RAINDROP_ACCESS_TOKEN` / `MCP_ACCESS_TOKEN`，仓库亦只有 `.env.example`；现有 GitHub Actions 仅在受保护的 main 手动发布作业注入生产密钥，PR CI 无此权限。不得在 PR 作业中暴露生产密钥来凑验收结果。
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

## 发布风险核对

| 风险 | 已有控制 / 证据 | 结论 |
|---|---|---|
| Portal 与凭据 | 现有 worker.security.test.ts：401/403/503、Origin、两种独立 Token | Mock 通过；待真实认证试用 |
| 官方端点与 -99 | Service Mock 覆盖单条/批量、标签、高亮和 DELETE /collection/-99，不将其当 DELETE /raindrops/-99 | Mock 通过；待官方真实账户验收 |
| 请求预算 | Service 请求中间件计入重试、最多 60 次 HTTP；分页大范围 fail-closed | Mock 通过；非全局账户限流 |
| ID/来源/权限 | T03/T06/T07/T08/T09 全量预检、根/子级、保留副本、Empty Trash 全成员摘要 | Mock 通过；仍有确认与执行间竞态 |
| 写入不确定性 | 不自动重放写入；聚合修改数不冒充逐条成功；unknown 须人工检查 | Mock 通过；真实错误形态待测 |
| 旧工具安全绕过 | 三个清理旧入口、旧集合 delete 和旧批量写入口拒绝危险行为 | 必须继续由公开 MCP 协议回归测试锁定 |
| 关键能力迁移 | 17→27 映射已列；创建/编辑/移动、层级、标签、高亮、软删及单独授权永久删都有候选路径 | **不能仅凭 Mock 证明现有真实工作流无回归** |
| 工具数量与说明 | 42 个共存是过渡状态；27 是候选清单，不是发布配额 | 未获授权，不移除旧别名 |
| 预览哈希 | 稳定成员摘要能阻止确认阶段的成员替换 | 非锁、非事务；不能保证确认后的零竞态 |

## 最小后续门槛与切换结论

### 最小凭据注入方式（仅在用户 WSL 终端交互执行）

已有的生产 Portal 插件凭据不会导出到 PR、GitHub Actions 或 Remote Control 日志。若用户允许使用其 Raindrop API Access Token 执行**只读**测试，可在 WSL 本机终端执行以下命令，输入时不回显，Token 仅存在于该次 Bash 子进程及其测试子进程环境中，不写入 .env、源码或 shell 历史：

```bash
cd apps/raindrop-mcp-worker  # 从 mcp-workers 仓库根目录执行
bash -c 'set -eu; IFS= read -rsp "Raindrop API Token: " RAINDROP_ACCESS_TOKEN </dev/tty; printf "\n"; export RAINDROP_ACCESS_TOKEN RUN_LIVE_API_TESTS=true; npm run test:read-only-live'
```

没有可用的交互终端或 Token 时**不自动执行**；不可让远控 Agent 读取既有生产 Worker Secret 或自动把其复制到 WSL。上述过程也不测试生产 Portal 鉴权（内存 MCP 仅验证 Draft Service→真实 Raindrop API）；这两条验收路径必须单独记录。

**当前判定：NO-GO / BLOCKED，保留 Draft。** 不能切换公开工具列表，不能将 42 直接删为 27，不能将任何 Mock 成功描述为真实上游成功。

- **已完成**两处 Schema 缺口及对应 MCP tools/call 回归；下列真实验收门槛依然有效。
- 在可控认证环境中完成只读 smoke；使用**明确授权的可丢弃测试数据**验证关键写入和异常响应，不修改普通用户书签；不可安全实测的 Trash 全局永久清空保留 acceptance-limited。
- 将旧生产关键工作流与新工具逐项比对并进行独立代码审查；任何无法确认的候选工具在切换时必须安全排除，不为了 27 项配额强行公开。
- **只有取得另一次明确的切换授权**，才可在另外的实施中移除旧别名、Sampling、library_audit、公开 diagnostics 并刷新测试清单；本轮 T10 不执行这些动作。关闭评估 Ticket 也不是生产发布许可。

**证据范围：** #124–#132 的 Draft 代码、Mock API/SDK MCP/Portal 测试；T10 新增对安全旧入口的 SDK tools/list 与 tools/call 验证。GitHub Actions/CI 仅证明对应源码通过自动化；**本轮另有对生产 Raindrop 账号隔离可丢弃数据的真实读写验收**（详情见 P1 生产账号隔离验收章节），未修改生产 Worker 或 PR CI 凭据。
