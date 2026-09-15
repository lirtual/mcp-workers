---
name: notes
description: IMA 笔记模块，由 ima-skill 按需加载。
disable-model-invocation: true
---

# Notes

构造请求或解析响应前，读取 [`references/api.md`](references/api.md) 中对应接口的 schema。

## 决策

| 意图 | 接口 |
| --- | --- |
| 按标题或正文搜索笔记 | `search_note` |
| 列出笔记本 | `list_notebook` |
| 列出全部或指定笔记本中的笔记 | `list_note` |
| 读取正文 | `get_doc_content` |
| 明确新建一篇笔记 | `import_doc` |
| 向明确的已有笔记追加内容 | `append_doc` |

未区分新建与追加的「记下」会写出不同结果，先让用户选择。完成决策的标准是：已确定 `import_doc`，或已确定 `append_doc` 及唯一目标笔记。

## 定位目标

- 用户明确给出目标笔记且上下文唯一时，使用其 `note_id`。
- 只有标题时先用 `search_note` 定位；多个候选项以标题、摘要和修改时间供用户选择。
- 浏览笔记本时先用 `list_notebook` 取得 `folder_id`，再调用 `list_note`。
- 用户要求「全部」或时间范围时持续分页，直到 `is_end=true` 或已越过时间边界。分页字段以 API reference 为准。

追加会修改现有笔记。进入 `append_doc` 前，目标必须唯一且与用户指定对象一致。

## 写入门

调用 `import_doc` 或 `append_doc` 前满足：

1. `content_format=1`，`content` 非空。
2. `content` 是合法 UTF-8 文本。从文件读取正文时先识别源编码；只有编码已知时才转换，转换失败则停止。用户输入和通过 `ima_api.cjs` 构造的 JavaScript 字符串无需重复转码。
3. Markdown 中的网络图片链接原样保留。本地图片引用不能写入；列出将省略的图片，若省略会实质改变笔记内容则在写入前取得用户确认。
4. `append_doc` 包含已确认的 `note_id`；`import_doc` 仅在用户选择新建时使用。

写入完成的标准是：根技能的结果门均通过，响应包含 `note_id`，并向用户说明创建或追加到了哪篇笔记。

## 读取与展示

- `get_doc_content` 使用 `target_content_format=0`；当前接口不支持 Markdown 读取。
- 时间字段按 Unix 毫秒转换为可读时间。
- 群聊中默认只展示标题、摘要和修改时间；仅在确认不会向其他参与者泄露正文时展示笔记内容。
- 列表和搜索结果通过 `note_id` 做内部关联，面向用户使用标题和笔记本名称。

## 失败处理

版本冲突时重新读取目标后再决定是否重试；超过大小限制时，仅在用户仍要求写入时拆分为有序的多次追加。
