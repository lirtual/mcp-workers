> **实施追记 · 2026-10-21（优先于下文历史设计快照）**：本 ADR 所述 **41 → 25** 是当时已确认的设计；后续为适配 Raindrop Free 账号，进一步移除了 Pro 专属 `bookmark_remove_duplicates`，最终源码公开 **24 个原子业务工具**。该变更已随 [PR #148](https://github.com/lirtual/mcp-workers/pull/148) 合并到 `main`（`eb64cc0`），[Actions #39554129177](https://github.com/lirtual/mcp-workers/actions/runs/39554129177) 的生产发布作业成功。**ChatGPT Portal 线上 `tools/list` 与可丢弃数据写入冒烟仍待重授权后验证**；不能以源码/CI/部署成功代替线上验收。以下 25 工具及“尚未实施”的文字保留为原始设计决策历史，不再代表当前发布目标。

# 收敛 Raindrop Agent 公开工具契约

status: accepted (historical 41 → 25 design; final Free-plan release is 24, live acceptance pending)

## 背景与决定

2026-10-21：个人使用的 Raindrop MCP Worker 已通过现有 GitHub Actions 发布，目前 `tools/list` 实际公开 **41 个**工具。这是历史兼容与原子入口共存的过渡状态。用户已确认将面向 Agent 的公开契约收敛为 **25 个原子工具（17 个日常 + 8 个高影响）**，**移除 16 个**重复、兼容、建议、内部维护或全局永久删除入口；不新增 MCP 服务、动态权限系统、基础设施或另一套部署流程。

这是一次有意的破坏性公开 API 变更：调用被移除工具名的客户端在新契约上线后将收到工具不存在。现有生产仍为 41 个，本文只记录**已确认的设计**，**不代表已实施或已发布**。

## 最终目标保留：25 个

**日常 Agent 工具（17）**

- 收藏夹（4）：`collection_list`、`collection_get`、`collection_create`、`collection_update`
- 书签（8）：`bookmark_search`、`bookmark_get`、`bookmark_exists`、`bookmark_create`、`bookmark_update`、`bookmark_move`、`bookmark_delete`、`bookmark_filters_get`
- 标签（1）：`tag_list`
- 高亮（4）：`highlight_list`、`highlight_create`、`highlight_update`、`highlight_delete`

**高影响工具（8；保留公开名称不等于许可自主执行）**

- 标签（3）：`tag_rename`、`tag_merge`、`tag_delete`
- 批量书签（2）：`bookmark_batch_update`、`bookmark_batch_delete`
- 收藏夹删除（2）：`collection_delete`、`collection_remove_empty`
- 去重（1）：`bookmark_remove_duplicates`

## 最终目标移除：16 个

| 类别 | 公开名称 | 替代或原因 |
| --- | --- | --- |
| 重复查询（3） | `get_raindrop`、`list_raindrops`、`get_collection_tree` | `bookmark_get`、`bookmark_search`、`collection_list`；树路径需利用返回的 `parentId` 组合，不应宣称完全等价 |
| 旧复合入口（5） | `collection_manage`、`bookmark_manage`、`tag_manage`、`highlight_manage`、`bulk_edit_raindrops` | 改用原子工具；若仍有旧调用方，需接受明确的破坏性切换 |
| 旧清理入口（3） | `empty_trash`、`cleanup_collections`、`remove_duplicates` | 旧名称主要返回迁移指引或拒绝写入 |
| AI / 建议（2） | `get_suggestions`、`suggest_tags` | 旧建议 API 曾在真实测试返回 403；Sampling 与 Agent 已有能力重复 |
| 运维 / 综合（2） | `diagnostics`、`library_audit` | 健康检查/运维及 `bookmark_filters_get` + `bookmark_search`；不是完全等价替代 |
| 全局永久删除（1） | **`trash_empty`** | **Q1=A：Agent 不提供清空全局回收站的工具**；只在 Raindrop 网页端手动完成 |

## 第一轮 Grill With Docs 已确认决定（Q1–Q4 全选 A）

- **Q1=A — `trash_empty` 从 Agent 公开工具清单移除。** 整库回收站的永久清空交由 Raindrop 网页端手动完成。总量由此前拟定的 26 项改为 **25 项**，待移除由 15 项改为 **16 项**。保留 `bookmark_remove_duplicates` 等范围受限的工具并不授权全局清空。
- **Q2=A — `bookmark_delete` 仅允许软删除。** Agent 发起的单条删除只能将非 Trash 书签移入回收站，不接受 `permanent:true` 进入永久删除路径。回收站内书签的永久删除同样交由网页端手动完成；已在回收站的对象不能由 Agent 再次删除。确认设计意图不等于当前生产已经限制。
- **Q3=A — Agent 不公开私人收藏夹。** `collection_create`、`collection_update` 不允许 Agent 将 `public` 设为 `true`；要公开收藏夹时用户在 Raindrop 网页端操作。一般建夹默认私人，不能从模糊指令推断公开授权。
- **Q4=A — 复用现有机制，不新建统一服务端审批系统。** 高影响操作应有明确的对象、范围和用户确认；对当前已有预览、摘要及二次确认的工具继续保留这些措施，客户端负责在执行前与用户确认。**重要事实边界：** 当前标签变更及批量书签工具没有统一的预览摘要，MCP `destructiveHint` 和文字描述不是服务端强制授权；客户端能否真正弹出确认取决于具体宿主。不得描述成所有高影响写入已经强制受到服务端审批。

上述 Q1–Q4 为最终确定的行为边界，不再作为待决问题。

## 第二轮 Grill With Docs 已确认决定（Q5–Q6 全选 A）

- **Q5=A — 现有局部校验与客户端确认足够，不增加统一预览 API。** `tag_rename`、`tag_merge`、`tag_delete` 及 `bookmark_batch_update`、`bookmark_batch_delete` 等**目前没有统一预览摘要**的高影响操作，继续依靠已有的精确对象、显式范围、数量上限和变更前检查，并在有必要时由 Agent/客户端获取明确意图。标签工具的 `collectionId:0` 是全局范围，必须由用户指令明确覆盖；批量书签必须给出确切的来源收藏夹与 ID 集合。未知写入结果不得盲目自动重试。**不**为此设计新的通用预览端点、持久化确认凭证或审批服务。不能宣称上述工具已有服务端强制确认。
- **Q6=A — 足够明确的当次用户指令就算确认，不重复询问。** 当用户当前请求已经明确指定操作动作、目标、范围和执行意图（例如“将收藏夹 A 内 ID 为 123、456 的书签移到回收站”），Agent 不应重复索取一次口头确认；对于模糊、缺少必需范围或可能扩大影响的请求，仍应先澄清。**已有工具自身强制的预览、摘要匹配和二次提交步骤仍须完整履行**；用户语言确认不能替代这些校验，也不能解除 Q1–Q3 已禁止的永久删除或公开操作。

## 设计树收敛结论

本次设计树的所有用户决策均已收敛：**公开契约规模（41 → 25、移除 16）**；**危险能力边界（Q1–Q3）**；**客户端与既有工具确认职责（Q4–Q5）**；**何时可视为用户已确认（Q6）**。在本次限定范围内**无未决设计分支**，因此不再开启新的 Grill 问题轮次。

剩余事项是**未来实施和验收工作**，不是仍需猜测的产品决策：后续获单独授权后才调整注册和禁止路径、核对旧调用者、跑契约回归测试与生产只读验收。当前生产依然公开 41 个工具；本次不修改源码、不合并、不部署。

## 最小实施与验证边界（本 PR 不实施）

- 仅在后续明确批准实施时，调整已有 `buildToolConfigs()` 的公开注册、必要输入 Schema/处理器校验、工具契约测试与说明。对 `bookmark_delete` 的硬删除必须在实际运行路径阻断，仅靠描述改变不够；`public:true` 同理。
- 测试至少验证 25 个公开名称且无重复、16 个旧名称不可调用、`permanent:true` 被拒绝、`public:true` 被拒绝，且新旧客户端契约变化得到明确说明。
- 先检查是否有已知使用旧名称的真实客户端；用户接受有意破坏兼容性，不为此新增适配层。复用现有 Portal、CI、`main` 手动选定 Worker 的 GitHub Actions 发布；生产发布仍须另获明确授权。
- **未授权**在本轮修改源代码、删除现有生产工具、运行写入测试、合并或部署。旧 G0 失败与其余历史验收仍按原记录解释，不因本次设计改变而自动通过。
