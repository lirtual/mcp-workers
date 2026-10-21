# 收敛 Raindrop Agent 公开工具契约

status: accepted (core inventory); detailed authorization boundaries under discussion

## 背景与决定

2026-10-21：个人使用的 Raindrop MCP Worker 已通过现有 GitHub Actions 发布，目前 `tools/list` 实际公开 41 个工具。41 是历史兼容与原子入口共存形成的**过渡数量**，不是最合适的 Agent 契约。用户确认：以 **26 个原子候选工具**作为公开契约目标，移除 **15 个**重复、旧兼容、建议或内部维护入口；不新增 MCP 服务、动态权限系统、基础设施或另一套部署流程。

这是一项有意的公开 API 破坏性调整：客户端若仍调用旧工具名，精简后会收到“工具不存在”。优先提高 Agent 工具选择的确定性，而不是长期保留无人使用的兼容别名。现有实际生产仍为 41 项；本文是**已达成的设计决定，不表示已实施或已发布**。

## 目标保留：26 个

**日常 Agent 工具（17）**

- 收藏夹（4）：`collection_list`、`collection_get`、`collection_create`、`collection_update`
- 书签（8）：`bookmark_search`、`bookmark_get`、`bookmark_exists`、`bookmark_create`、`bookmark_update`、`bookmark_move`、`bookmark_delete`、`bookmark_filters_get`
- 标签（1）：`tag_list`
- 高亮（4）：`highlight_list`、`highlight_create`、`highlight_update`、`highlight_delete`

**高影响操作（9；保留候选能力，不等于允许 Agent 自主执行）**

- 标签（3）：`tag_rename`、`tag_merge`、`tag_delete`
- 批量书签（2）：`bookmark_batch_update`、`bookmark_batch_delete`
- 收藏夹删除（2）：`collection_delete`、`collection_remove_empty`
- 去重（1）：`bookmark_remove_duplicates`
- 回收站（1）：`trash_empty`（用户倾向仅手动操作；公开可见性及执行边界待定）

## 目标移除：15 个

| 类别 | 移除的公开名称 | 替代方案或原因 |
| --- | --- | --- |
| 重复查询（3） | `get_raindrop`、`list_raindrops`、`get_collection_tree` | `bookmark_get`、`bookmark_search`、`collection_list`；树路径需由返回的 parentId 组合（不能宣称完全等价） |
| 旧复合入口（5） | `collection_manage`、`bookmark_manage`、`tag_manage`、`highlight_manage`、`bulk_edit_raindrops` | 使用单动作的原子工具；旧入口的部分高风险写入本已禁用 |
| 旧清理入口（3） | `empty_trash`、`cleanup_collections`、`remove_duplicates` | 原入口已仅提示迁移或拒绝写入 |
| AI / 建议（2） | `get_suggestions`、`suggest_tags` | 既有建议 API 真实测试出现 403；Sampling 对 Agent 重复、也非可靠官方标签能力 |
| 运维 / 综合（2） | `diagnostics`、`library_audit` | 健康检查/运维渠道及 `bookmark_filters_get` + `bookmark_search`；不是一对一替换完整统计 |

**行为边界（方向已确认，细节仍需 Grill 决策）：** `bookmark_delete` 日常使用仅软删除；`collection_create/update` 设置 `public:true` 不允许从模糊指令自动推定；高影响操作必须有明确作用域和用户确认。是否从 MCP 根本移除永久删除能力、如何处理 `trash_empty` 的手动专用要求，以及确认由客户端还是服务端承载，均不在本 ADR 中臆定。

## 最小实施与验证边界

- 待上述问题收敛后，仅改动现有 `buildToolConfigs()` 暴露列表、必要的输入校验、测试和使用说明；没有证据表明必须建立新架构。
- 工具注册测试需断言最终公开名称、唯一性，以及旧名称不可调用。需要核对可能仍在使用的旧插件调用者，接受本次明确的兼容性断裂。
- 沿用当前 GitHub Actions `main` 手动选定 `raindrop-mcp-worker` 的发布方式，并在后续获明确部署授权时刷新插件、验证真实 `tools/list`。
- 这是文档/设计决策记录。创建文档或合并文档 PR **不自动授权**修改生产工具清单、执行删除或部署。之前验收资料只作历史证据，不推定新契约已验证。
