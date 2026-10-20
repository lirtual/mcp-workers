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
| collection_list | 已实现/扩展 | 通过* | 通过* | 待验收 | 尚缺 strict 未知字段限制 |
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
| bookmark_remove_duplicates | 已实现 | 通过* | 通过* | 待验收 | 尚缺 outputSchema；副本保护 |


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
5. **未解决**：collection_list 输入对象仍没有禁止未知字段（strict）；这是接口严谨性缺口，不应依赖客户端自觉。
6. **未解决**：bookmark_remove_duplicates 尚无明确 outputSchema，不能在正式切换时声称结构化输出已完全校验。
7. **未解决**：27 项均缺此 Draft 版本的真实认证 MCP/API 验收；涉及写入的需经单独授权的可丢弃测试对象；全局永久清空记录 acceptance-limited。前述测试矩阵只覆盖模拟场景。

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

**当前判定：NO-GO / BLOCKED，保留 Draft。** 不能切换公开工具列表，不能将 42 直接删为 27，不能将任何 Mock 成功描述为真实上游成功。

- 修复上面两处独立工具 Schema 缺口并添加 MCP tools/call 的对应回归。
- 在可控认证环境中完成只读 smoke；使用**明确授权的可丢弃测试数据**验证关键写入和异常响应，不修改普通用户书签；不可安全实测的 Trash 全局永久清空保留 acceptance-limited。
- 将旧生产关键工作流与新工具逐项比对并进行独立代码审查；任何无法确认的候选工具在切换时必须安全排除，不为了 27 项配额强行公开。
- **只有取得另一次明确的切换授权**，才可在另外的实施中移除旧别名、Sampling、library_audit、公开 diagnostics 并刷新测试清单；本轮 T10 不执行这些动作。关闭评估 Ticket 也不是生产发布许可。

**证据范围：** #124–#132 的 Draft 代码、Mock API/SDK MCP/Portal 测试；T10 新增对安全旧入口的 SDK tools/list 与 tools/call 验证。GitHub Actions/CI 仅证明对应源码通过自动化，用户数据、凭据与生产 Worker 均未修改。
