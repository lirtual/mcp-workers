---
name: ima-companion
description: IMA Companion Skill. Defines agent operating policies, target resolution, user confirmation gates, and error recovery when interacting with the IMA MCP server.
---

# IMA MCP 伴随操作规范 (Companion Skill)

本规范定义 Agent 在使用 `ima-mcp` 工具时的交互决策原则、目标定位、分页流转及安全约束。

## 1. 意图决策门 (Intent Resolution)

| 意图 | 决策与动作 |
| :--- | :--- |
| 模糊的「记下 / 记录 / 保存」 | **禁止默认直接调用 `create_note`**。若上下文未明确是新建还是向某篇笔记追加，必须先让用户确认：是「新建笔记」还是「追加到已有笔记」。 |
| 明确新建笔记 | 确认内容与分类笔记本后，调用 `create_note`。 |
| 向已有笔记追加 | 先定位并确认唯一目标 `note_id`，再调用 `append_note`。 |
| 上传本地文件 | 换成服务端可下载的公网 HTTPS URL，再调用 `upload_file_to_knowledge_base`。 |
| 收藏网页 / 公众号文章 | 确认属于网页或微信文章后，调用 `add_urls_to_knowledge_base`。 |
| 读取笔记正文 | 调用 `get_note`。默认 Markdown（`target_content_format=1`，含图片链接）。需要纯文本传 `0`；需要块 JSON 传 `2`。 |
| 阅读知识库条目 | 优先调用 `read_knowledge_source`；笔记类型同样可传 `target_content_format`（默认 Markdown）。URL 文本按 `next_offset` 分块续读；二进制文件在 R2 配置下直接返回下载链接。不得展示内部下载鉴权头。 |
| 导出文件 / 导出笔记 / 获取下载链接 | 调用 `export_file`（传 `media_id` 导出知识库文件/文档，或传 `note_id` 导出笔记为 Markdown），获取 R2 公网/自定义域下载链接。 |

## 2. 目标定位与消歧 (Target Resolution)

1. **笔记目标定位**：
   - 用户给出明确 `note_id` 且上下文唯一时直接使用。
   - 用户仅给出标题时，调用 `search_notes(query=..., search_type=0)` 检索。
   - **多候选项门禁**：若检索到多个匹配结果，**必须列出候选项的标题、摘要及更新时间供用户确认选择**，不可自行猜测第一项。
2. **知识库与文件夹定位**：
   - 用户给出知识库名称时，先调用 `search_knowledge_bases` 解析出唯一的 `knowledge_base_id`。
   - 若指定了子目录/文件夹，通过 `list_knowledge` 或 `search_knowledge` 取得匹配的 `folder_id`。
   - 知识库根目录：工具边界省略 `folder_id`。`add_urls_to_knowledge_base` 由服务端把 `knowledge_base_id` 补为 API 所需的根 folder_id；子文件夹才传实际 `folder_id`。

## 3. 自动分页契约 (Pagination Loop)

- 当用户请求「全部」、「所有笔记」或限定时间范围（如“最近一个月”）时：
  - **笔记列表与知识库条目列表**：分别调用 `list_notes`、`list_knowledge`，首次请求 `cursor=""`；若 `is_end=false`，将响应的 `next_cursor` 作为下一页 `cursor`，直至结束或超出时间范围。
  - **笔记本列表**：首次请求 `cursor="0"`，循环直到 `is_end=true`。
  - **笔记搜索**：使用 `start` 与 `end`（单页跨度不超过 20），按 `total_hit_num` 递增分页范围直至覆盖全部结果。

## 4. Markdown 正文写入门禁 (Markdown Content Gates)

调用 `create_note` 或 `append_note` 前：
1. **图片链接检查**：
   - 网络图片链接（`https://...`）原样保留。
   - 本地图片路径（如 `![img](file://...)` 或 `![img](./pic.png)`）无法直接写入 IMA 云端笔记。
   - 检查到本地图片时，必须向用户列出将被省略的图片。若省略图片会实质改变笔记内容，应在写入前取得用户确认，或指引用户使用公网图床/临时上传。
2. **编码与格式**：确保 `content` 为非空有效 UTF-8 字符串。

## 5. 隐私与多方上下文保护 (Privacy)

- 在多参与者环境或群聊中，检索笔记或知识库时，默认仅展示**标题、摘要和修改时间**。
- 仅在明确指示或私密环境中展示完整笔记正文，防止敏感信息外泄。

## 6. 异常恢复与重试策略 (Failure Recovery)

1. **版本冲突 (`210008` / `VERSION_CONFLICT`)**：
   - 立即调用 `get_note` 重新拉取该笔记的最新正文。
   - 比对变更后，确认追加位置并重试；若存在不可协调的冲突，向用户说明情况。
2. **单篇内容超限 (`210009` / `CONTENT_SIZE_OVERLOAD`)**：
   - 告知用户单篇笔记已达容量上限。
   - 经用户同意后，将待写入内容拆分为有序的段落进行多次追加，或建议新建卷册。
3. **同名文件冲突**：
   - 上传文件提示同名时，询问用户是否「保留两者」；用户同意后传入 `keep_both=true`，系统将自动追加精确时间戳后缀。

## 7. 平台边界

- 本地文件先换成服务端可下载的公网 HTTPS URL，再调用 `upload_file_to_knowledge_base`。
- `list_notes` 固定按修改时间排序，不要传 `sort_type`。`list_notebooks` 只做 `cursor` 分页，不要传 `version`。
- 不拦截 Skill 新版本；服务版本以 `/health` 为准。
