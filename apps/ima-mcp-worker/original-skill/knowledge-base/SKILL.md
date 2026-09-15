---
name: knowledge-base
description: IMA 知识库模块，由 ima-skill 按需加载。
disable-model-invocation: true
---

# Knowledge Base

构造请求或解析响应前，读取 [`references/api.md`](references/api.md) 中对应接口的 schema。

## 决策

| 意图 | 接口或流程 |
| --- | --- |
| 上传本地文件 | `check_repeated_names` → `create_media` → COS → `add_knowledge` |
| 添加网页或微信文章 | `import_urls` |
| 将笔记关联到知识库 | notes 定位 `note_id` → `add_knowledge(media_type=11)` |
| 浏览或搜索知识库条目 | `get_knowledge_list` / `search_knowledge` |
| 搜索或列出知识库 | `search_knowledge_base` |
| 为未指定目标库的添加操作列出候选库 | `get_addable_knowledge_base_list` |
| 获取知识库详情 | `get_knowledge_base` |
| 查看、分析或导出原文 | `get_media_info` |

用户给出知识库名称时用 `search_knowledge_base` 定位；只有添加内容且未指定目标库时才用 `get_addable_knowledge_base_list`。完成定位的标准是：写入前已有唯一 `knowledge_base_id`，指定子文件夹时也已有唯一 `folder_id`。

## 文件夹语义

- `add_knowledge`、`check_repeated_names` 与 `get_knowledge_list` 在根目录操作时省略可选的 `folder_id`；`create_media` 没有该字段。
- `import_urls.folder_id` 是必填字段：根目录传 `knowledge_base_id`，子文件夹传实际 `folder_id`。
- 文件夹 ID 来自 `search_knowledge` 或逐级 `get_knowledge_list`。

## 文件上传门

令 `KB_DIR` 为本文件所在目录。每个文件按顺序通过以下门：

1. **预检**：

   ```bash
   node "$KB_DIR/scripts/preflight-check.cjs" --file "/absolute/path/to/file"
   ```

   对无扩展名下载文件补充 `--content-type`。退出码 `0` 且输出 `pass=true` 才进入下一门；否则展示 `reason`。

2. **重名**：用预检输出的 `file_name`、`media_type` 调用 `check_repeated_names`。无重名时继续；有重名时让用户选择取消或「保留两者」。后者生成 `{stem}_YYYYMMDDHHmmss.{ext}` 作为经用户批准的有效上传名。

3. **创建媒体**：用预检输出的 `file_size`、`content_type`、`file_ext` 和有效上传名调用 `create_media`。业务成功且取得 `media_id`、COS URL 与完整临时凭证后继续。

4. **COS 上传**：临时凭证只作为脚本参数，不展示给用户。

   ```bash
   node "$KB_DIR/scripts/cos-upload.cjs" \
     --file "/absolute/path/to/file" \
     --secret-id "<temporary_secret_id>" \
     --secret-key "<temporary_secret_key>" \
     --token "<temporary_token>" \
     --bucket "<bucket_name>" \
     --region "<region>" \
     --cos-key "<cos_key>" \
     --content-type "<content_type>" \
     --start-time "<start_time>" \
     --expired-time "<expired_time>" \
     --timeout 300000
   ```

   退出码非零即停止，且不调用 `add_knowledge`。

5. **登记知识**：COS 成功后调用 `add_knowledge`。`title` 与 `file_info.file_name` 都等于有效上传名，`file_size` 与 `cos_key` 来自前序结果；二进制文件始终按原字节上传。

完成上传的标准是：每个文件的五个门均通过且 `add_knowledge` 返回业务成功。批量操作逐文件记录结果并汇总，不让单个失败掩盖其他文件的状态。

## URL 与笔记

- 添加 URL 前按 [`references/api.md`](references/api.md) 的 URL Type Detection 判定：网页走 `import_urls`；可下载文件进入临时目录后走完整文件上传门，结束后清理临时文件。
- 笔记关联使用 `add_knowledge`，其中 `media_type=11`、`note_info.content_id=<note_id>`；先读取 notes 模块取得唯一笔记。

## 查询与原文

- 列表和搜索按 reference 的游标字段持续分页，直到满足用户范围或 `is_end=true`。
- 原文按 reference 的 `get_media_info` 响应分支处理；笔记类型先读取 notes 模块。

面向用户使用知识库、文件和文件夹名称。
