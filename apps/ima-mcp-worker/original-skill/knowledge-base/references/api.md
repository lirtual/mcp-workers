# IMA知识库 API

接口路径、请求和响应结构的权威参考。运行时路由与写入门见上级 `SKILL.md`。

## 数据结构

### KnowledgeBaseInfo（知识库信息）

| 字段                    | 类型     | 说明          |
| ----------------------- | -------- | ------------- |
| `id`                    | string   | 知识库唯一 ID |
| `name`                  | string   | 知识库名称    |
| `cover_url`             | string   | 封面图 URL    |
| `description`           | string   | 描述          |
| `recommended_questions` | string[] | 推荐问题列表  |

### KnowledgeInfo（知识条目）

| 字段               | 类型   | 说明          |
| ------------------ | ------ | ------------- |
| `media_id`         | string | 媒体 ID       |
| `title`            | string | 标题          |
| `parent_folder_id` | string | 所属文件夹 ID |

### FolderInfo（文件夹条目）

| 字段               | 类型   | 说明        |
| ------------------ | ------ | ----------- |
| `folder_id`        | string | 文件夹 ID   |
| `name`             | string | 文件夹名称  |
| `file_number`      | int64  | 文件数      |
| `folder_number`    | int64  | 子文件夹数  |
| `parent_folder_id` | string | 父文件夹 ID |
| `is_top`           | bool   | 是否置顶    |

### AddableKnowledgeBaseInfo（可添加的知识库信息）

| 字段   | 类型   | 说明       |
| ------ | ------ | ---------- |
| `id`   | string | 知识库 ID  |
| `name` | string | 知识库名称 |

### SearchedKnowledgeBaseInfo（搜索到的知识库信息）

| 字段        | 类型   | 说明       |
| ----------- | ------ | ---------- |
| `id`        | string | 知识库 ID  |
| `name`      | string | 知识库名称 |
| `cover_url` | string | 封面图 URL |

### SearchedKnowledgeInfo（搜索到的知识条目）

| 字段                | 类型   | 说明                       |
| ------------------- | ------ | -------------------------- |
| `media_id`          | string | 媒体 ID                    |
| `title`             | string | 标题                       |
| `parent_folder_id`  | string | 所属文件夹 ID              |
| `highlight_content` | string | 高亮内容（内容匹配时返回） |

### ContentInfo（内容信息）

| 字段         | 类型   | 说明                    |
| ------------ | ------ | ----------------------- |
| `content_id` | string | 内容 ID（网页时为 URL） |

### ImportURLData（URL 导入结果）

| 字段       | 类型   | 说明                    |
| ---------- | ------ | ----------------------- |
| `url`      | string | 导入的 URL              |
| `ret_code` | int32  | 0=成功，非 0=失败       |
| `media_id` | string | 导入成功后返回的媒体 ID |

### URLInfo（访问链接信息）

| 字段      | 类型                  | 说明                                                      |
| --------- | --------------------- | --------------------------------------------------------- |
| `url`     | string                | 访问链接                                                  |
| `headers` | map\<string, string\> | 访问链接所需 header，非空时需在请求 url 时同时传入 header |

### NotebookExtInfo（笔记扩展信息）

| 字段          | 类型   | 说明    |
| ------------- | ------ | ------- |
| `notebook_id` | string | 笔记 ID |

### FileInfo（文件信息）

`add_knowledge` 文件上传时使用：

| 字段               | 类型   | 说明                       |
| ------------------ | ------ | -------------------------- |
| `cos_key`          | string | COS 对象 Key               |
| `file_size`        | uint64 | 文件大小（字节）           |
| `last_modify_time` | int64  | 最后修改时间（秒级时间戳） |
| `password`         | string | 文件密码（如有）           |
| `file_name`        | string | 文件名称                   |

### Credential（COS 上传凭证）

`create_media` 返回，用于上传文件到腾讯云 COS：

| 字段            | 类型   | 说明                       |
| --------------- | ------ | -------------------------- |
| `token`         | string | 临时 TOKEN                 |
| `secret_id`     | string | 临时 Secret ID             |
| `secret_key`    | string | 临时 Secret Key            |
| `start_time`    | int64  | 凭证开始时间（秒级时间戳） |
| `expired_time`  | int64  | 凭证过期时间（秒级时间戳） |
| `appid`         | string | COS AppID                  |
| `bucket_name`   | string | COS 桶名称                 |
| `region`        | string | COS 桶所在区域             |
| `custom_domain` | string | 自定义域名                 |
| `cos_key`       | string | COS 对象 Key               |

### MediaType（媒体类型枚举）

| 值  | 名称           | content_type / 说明                                                                                           |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | PDF            | `application/pdf`                                                                                             |
| 2   | 网页           | N/A（直接 AddKnowledge，`web_info.content_id=<url>`）                                                         |
| 3   | Word           | `application/msword` / `application/vnd.openxmlformats-officedocument.wordprocessingml.document`              |
| 4   | PPT            | `application/vnd.ms-powerpoint` / `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| 5   | Excel          | `application/vnd.ms-excel` / `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` / `text/csv` |
| 6   | 微信公众号文章 | N/A（直接 AddKnowledge，`web_info.content_id=<url>`，URL 匹配 `mp.weixin.qq.com/s`）                          |
| 7   | MarkDown       | `text/markdown` / `text/x-markdown` / `application/md` / `application/markdown`                               |
| 9   | 图片           | `image/png`, `image/jpeg`, `image/webp`                                                                       |
| 11  | 笔记           | N/A（直接 AddKnowledge，`note_info.content_id=<doc_id>`）                                                     |
| 12  | AI会话         | N/A（直接 AddKnowledge，`session_info.content_id=<session_id>`）                                              |
| 13  | TXT            | `text/plain`                                                                                                  |
| 14  | Xmind          | `application/x-xmind` / `application/vnd.xmind.workbook`；`application/zip` 仅在扩展名为 `.xmind` 时接受       |
| 15  | 录音           | `audio/mpeg`(mp3), `audio/x-m4a`(m4a), `audio/wav`(wav), `audio/aac`(aac)                                     |
| 16  | 视频解析       | **不支持通过 skill 添加**。Bilibili/YouTube等仅支持在 ima 桌面端内添加进知识库                                |
| 20  | HTML           | `text/html`（.html 文件上传）                                                                          |
| 21  | EPUB           | `application/epub+zip`（.epub 文件上传）                                                               |

---

## 接口详情

### 1. 创建媒体

POST /openapi/wiki/v1/create_media

#### 请求参数

| 字段                | 类型   | 必填 | 说明                           |
| ------------------- | ------ | ---- | ------------------------------ |
| `file_name`         | string | 是   | 文件名称（最长 1024 字符）     |
| `file_size`         | uint64 | 是   | 文件大小（字节）               |
| `content_type`      | string | 是   | MIME 类型                      |
| `knowledge_base_id` | string | 是   | 知识库 ID                      |
| `file_ext`          | string | 是   | 文件后缀名（无点号，如 `pdf`） |

#### 返回字段

| 字段             | 类型       | 说明         |
| ---------------- | ---------- | ------------ |
| `media_id`       | string     | 媒体 ID      |
| `cos_credential` | Credential | COS 上传凭证 |

---

### 2. 添加知识

POST /openapi/wiki/v1/add_knowledge

#### 请求参数

| 字段                  | 类型        | 必填     | 说明                                    |
| --------------------- | ----------- | -------- | --------------------------------------- |
| `media_type`          | int32       | 是       | 媒体类型                                |
| `media_id`            | string      | 否       | 文件上传时必填，CreateMedia 返回的 ID   |
| `title`               | string      | 是       | 标题                                    |
| `knowledge_base_id`   | string      | 是       | 知识库 ID                               |
| `folder_id`           | string      | 否       | 文件夹 ID（省略则添加到根目录）         |
| `note_info`           | ContentInfo | 否       | 笔记内容信息                            |
| `web_info`            | ContentInfo | 否       | 网页内容信息（media_type=2 时必填）     |
| `web_info.content_id` | string      | 条件必填 | 网页 URL（media_type=2 时必填）         |
| `session_info`        | ContentInfo | 否       | 会话内容信息                            |
| `file_info`           | FileInfo    | 否       | 文件信息（文件上传时必填，见 FileInfo） |

#### 返回字段

| 字段       | 类型   | 说明    |
| ---------- | ------ | ------- |
| `media_id` | string | 媒体 ID |

---

### 3. 获取知识库信息

POST /openapi/wiki/v1/get_knowledge_base

#### 请求参数

| 字段  | 类型     | 必填 | 说明                              |
| ----- | -------- | ---- | --------------------------------- |
| `ids` | string[] | 是   | 知识库 ID 列表（1-20 个，不重复） |

#### 返回字段

| 字段    | 类型                             | 说明           |
| ------- | -------------------------------- | -------------- |
| `infos` | map\<string, KnowledgeBaseInfo\> | 知识库信息映射 |

---

### 4. 浏览知识库内容

POST /openapi/wiki/v1/get_knowledge_list

#### 请求参数

| 字段                | 类型   | 必填 | 说明                          |
| ------------------- | ------ | ---- | ----------------------------- |
| `cursor`            | string | 是   | 游标，首次传空字符串          |
| `limit`             | uint64 | 是   | 数量限制（1-50）              |
| `knowledge_base_id` | string | 是   | 知识库 ID                     |
| `folder_id`         | string | 否   | 文件夹 ID（省略则列出根目录） |

#### 返回字段

| 字段             | 类型            | 说明             |
| ---------------- | --------------- | ---------------- |
| `knowledge_list` | KnowledgeInfo[] | 知识条目列表     |
| `is_end`         | bool            | 是否到达列表末尾 |
| `next_cursor`    | string          | 下页游标         |
| `current_path`   | FolderInfo[]    | 当前路径         |

---

### 5. 搜索知识库内容

POST /openapi/wiki/v1/search_knowledge

#### 请求参数

| 字段                | 类型   | 必填 | 说明                 |
| ------------------- | ------ | ---- | -------------------- |
| `query`             | string | 是   | 搜索关键词           |
| `cursor`            | string | 是   | 游标，首次传空字符串 |
| `knowledge_base_id` | string | 是   | 知识库 ID            |

#### 返回字段

| 字段          | 类型                    | 说明                                                                     |
| ------------- | ----------------------- | ------------------------------------------------------------------------ |
| `info_list`   | SearchedKnowledgeInfo[] | 搜索结果（`media_id`, `title`, `parent_folder_id`, `highlight_content`） |
| `is_end`      | bool                    | 是否到达列表末尾                                                         |
| `next_cursor` | string                  | 下页游标                                                                 |

---

### 6. 搜索知识库列表

POST /openapi/wiki/v1/search_knowledge_base

#### 请求参数

| 字段     | 类型   | 必填 | 说明                 |
| -------- | ------ | ---- | -------------------- |
| `query`  | string | 是   | 搜索关键词           |
| `cursor` | string | 是   | 游标，首次传空字符串 |
| `limit`  | uint64 | 是   | 数量限制（1-20）     |

#### 返回字段

| 字段          | 类型                        | 说明                                  |
| ------------- | --------------------------- | ------------------------------------- |
| `info_list`   | SearchedKnowledgeBaseInfo[] | 搜索结果（`id`, `name`, `cover_url`） |
| `is_end`      | bool                        | 是否到达列表末尾                      |
| `next_cursor` | string                      | 下页游标                              |

---

### 7. 获取可添加的知识库列表

POST /openapi/wiki/v1/get_addable_knowledge_base_list

#### 请求参数

| 字段     | 类型   | 必填 | 说明                 |
| -------- | ------ | ---- | -------------------- |
| `cursor` | string | 是   | 游标，首次传空字符串 |
| `limit`  | uint64 | 是   | 数量限制（1-50）     |

#### 返回字段

| 字段                          | 类型                       | 说明                   |
| ----------------------------- | -------------------------- | ---------------------- |
| `addable_knowledge_base_list` | AddableKnowledgeBaseInfo[] | 可添加内容的知识库列表 |
| `next_cursor`                 | string                     | 下页游标               |
| `is_end`                      | bool                       | 是否到达列表末尾       |

---

### 8. 检查文件名重复

POST /openapi/wiki/v1/check_repeated_names

#### 请求参数

| 字段                | 类型                      | 必填 | 说明                          |
| ------------------- | ------------------------- | ---- | ----------------------------- |
| `params`            | CheckRepeatedNamesParam[] | 是   | 待检查的文件列表（1-2000 个） |
| `knowledge_base_id` | string                    | 是   | 知识库 ID                     |
| `folder_id`         | string                    | 否   | 文件夹 ID（省略则检查根目录） |

**CheckRepeatedNamesParam：**

| 字段         | 类型   | 说明                          |
| ------------ | ------ | ----------------------------- |
| `name`       | string | 文件名称                      |
| `media_type` | int32  | 媒体类型（见 MediaType 枚举） |

#### 返回字段

| 字段      | 类型                       | 说明     |
| --------- | -------------------------- | -------- |
| `results` | CheckRepeatedNamesResult[] | 检查结果 |

**CheckRepeatedNamesResult：**

| 字段          | 类型   | 说明                      |
| ------------- | ------ | ------------------------- |
| `name`        | string | 文件名称                  |
| `is_repeated` | bool   | `true` 表示同名文件已存在 |

---

### 9. 导入 URL

POST /openapi/wiki/v1/import_urls

#### 请求参数

| 字段                | 类型     | 必填 | 说明                                |
| ------------------- | -------- | ---- | ----------------------------------- |
| `knowledge_base_id` | string   | 是   | 知识库 ID                           |
| `folder_id`         | string   | 是   | 文件夹 ID                           |
| `urls`              | string[] | 是   | URL 列表（1-10 个，每个非空字符串） |

#### 返回字段

| 字段      | 类型                         | 说明                                      |
| --------- | ---------------------------- | ----------------------------------------- |
| `results` | map\<string, ImportURLData\> | URL→结果映射（含 `ret_code`、`media_id`） |

---

### 10. 获取媒体信息

POST /openapi/wiki/v1/get_media_info

#### 请求参数

| 字段       | 类型   | 必填 | 说明                |
| ---------- | ------ | ---- | ------------------- |
| `media_id` | string | 是   | 媒体 ID（不可为空） |

#### 返回字段（`data` 内）

| 字段                | 类型            | 说明                                                                                              |
| ------------------- | --------------- | ------------------------------------------------------------------------------------------------- |
| `media_type`        | int32           | 媒体类型（见 MediaType 枚举）                                                                     |
| `url_info`          | URLInfo         | 访问链接信息，非笔记类型时填写（见 [URLInfo](#urlinfo访问链接信息)）                              |
| `notebook_ext_info` | NotebookExtInfo | 笔记扩展信息，`media_type=11`（笔记）时填写（见 [NotebookExtInfo](#notebookextinfo笔记扩展信息)） |

#### 响应分支说明

| 场景                                   | 响应特征                                                             | 处理方式                                                                     |
| -------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 媒体可通过 URL 访问                    | `code=0`，`data.url_info` 存在，`url` 非空                           | 使用 `url` 和 `headers`（如有）请求原文内容                                  |
| 媒体是笔记类型                         | `code=0`，`data.media_type=11`，`notebook_ext_info.notebook_id` 存在 | 将 `notebook_id` 作为 `note_id` 调用 notes 模块的 `get_doc_content` 获取内容 |
| 媒体不可访问（无 URL 或 URL 请求失败） | `code=0`，`data.url_info` 为空，或请求 `url` 返回非 200 状态         | 提示用户使用 IMA 客户端查看原文                                              |

---

## 文件夹

`get_knowledge_list` 同时返回文件（`KnowledgeInfo`）和文件夹（`FolderInfo`）；`current_path` 是当前路径。`search_knowledge` 结果也可含文件夹。`folder_id` 的根目录规则与定位步骤见上级 `SKILL.md`。

---

## URL Type Detection

添加 URL 到知识库时，需根据 URL 模式和 Content-Type 判断类型。

**1. Content-Type 为 `text/html` 时，按 URL 模式区分：**

| URL 模式                                            | media_type | 类型           | 处理方式                                                  |
| --------------------------------------------------- | ---------- | -------------- | --------------------------------------------------------- |
| 匹配 `mp.weixin.qq.com/s/` 或 `mp.weixin.qq.com/s?` | 6          | 微信公众号文章 | 使用 `import_urls`                                        |
| 以 `https://www.bilibili.com/video/` 开头           | ❌ 16      | 视频网页       | **不支持**，告知用户「仅支持在 ima 桌面端内添加进知识库」 |
| 以 `https://www.youtube.com/watch` 开头             | ❌ 16      | 视频网页       | **不支持**，告知用户「仅支持在 ima 桌面端内添加进知识库」 |
| 以 `file://` 开头                                   | ❌         | 本地 HTML      | **不支持**，告知用户「仅支持在 ima 桌面端内添加进知识库」 |
| 其他 `text/html` 页面                               | 2          | 普通网页       | 使用 `import_urls`                                        |

**2. Content-Type 为文件类型时**：按 MediaType 枚举表处理。

**3. 其他**：告知用户该类型不被支持。

**已知文件型 URL 模式**：

- `arxiv.org/pdf/*` → PDF
- `*.pdf`、`*.docx`、`*.pptx`、`*.xlsx` 结尾 → 对应文件类型
- GitHub raw 文件链接 → 按扩展名判断

**文件名推断优先级**：Content-Disposition header → URL path → last URL segment + Content-Type extension

---

## 游标翻页使用规范

1. **首次请求**：`cursor` 传空字符串 `""`
2. 检查返回的 `is_end`：`false` 表示还有更多数据
3. 将返回的 `next_cursor` 作为下次请求的 `cursor`
4. `is_end = true` 时停止翻页

---

## 错误码

| 错误码 | 说明         | 建议处理                 |
| ------ | ------------ | ------------------------ |
| 0      | 成功         | —                        |
| 110001 | 参数非法     | 检查请求参数（详见 msg） |
| 110002 | 配置非法     | 检查服务配置             |
| 110010 | 下游网络错误 | 可重试                   |
| 110011 | 下游逻辑错误 | 不可重试，详见 msg       |
| 110012 | 接口无效     | 检查接口路径             |
| 110013 | 客户端取消   | 检查请求是否超时         |
| 110020 | 安全打击     | 检查内容是否违规         |
| 110021 | 请求频控     | 降低请求频率后重试       |
| 110030 | 无权限       | 确认操作权限             |
