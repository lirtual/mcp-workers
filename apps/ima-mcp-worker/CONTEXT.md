# IMA MCP

Cloudflare Worker MCP that exposes IMA notes and knowledge bases to coding agents.

## Language

**完全迁移**:
行为、安全门、失败处理与 original-skill 的用户侧能力等价，并且真实 IMA 测试账户 E2E（新建、追加、导入 URL、关联笔记、原文续读、COS 上传）通过。
_Avoid_: 接口可达, 工具能调, 核心意图覆盖

**平台适配**:
Worker 不能读本机路径；进入 MCP 的文件必须是服务端可下载的公网 HTTPS URL，过期与否不是该边界。与 original-skill 本地上传等价还要求目标客户端完成该转换且上传 E2E 通过。
_Avoid_: 本地路径上传, 短时链接, 临时链接

**明确放弃**:
有意不迁移的能力：`list_notebooks.version`、`list_notes.sort_type`、Skill 每日更新阻断。
_Avoid_: 待补缺口, 未完成

**知识库根目录**:
工具边界省略 `folder_id`；仅子文件夹传实际 `folder_id`。`add_urls_to_knowledge_base` 由服务端把 `knowledge_base_id` 补为 API 根 folder_id。

**Portal Client Authentication**:
Cloudflare MCP Portal + Access 负责客户端进入 Portal 的身份认证。该身份不等于 Worker origin credential，也不等于 IMA business credential。
_Avoid_: IMA API credential, Worker origin bearer

**Origin Credential**:
`MCP_ACCESS_TOKEN` 是 Portal -> `ima-mcp-worker` Worker 的固定 Bearer。缺失配置必须 fail closed；不得使用 `IMA_API_KEY` 替代。
_Avoid_: IMA API key, OAuth access token

**IMA Business Credential**:
`IMA_CLIENT_ID` 是 GitHub Environment Variable（Worker `plain_text`），`IMA_API_KEY` 是 GitHub Environment Secret（Worker `secret_text`）；二者共同用于 Worker -> IMA OpenAPI。旧名称 `IMA_OPENAPI_CLIENTID`、`IMA_OPENAPI_APIKEY`、`CLIENTID`、`APIKEY` 均不再受支持。
_Avoid_: Portal credential, per-user BYOK database

**Export removed**:
IMA MCP 不提供对外文件导出、临时上传、Litterbox 链接或图片重签能力；`read_knowledge_source` 保留分块读取，`upload_file_to_knowledge_base` 是导入 IMA，不属于导出。
_Avoid_: `export_file`, `export_to_temporary`, Litterbox, 公开导出 URL

## Authentication invariant

Portal/client 身份、`MCP_ACCESS_TOKEN`、`IMA_CLIENT_ID` / `IMA_API_KEY` 是三个独立安全边界，不得复用。Worker 不维护 OAuth client/code/token 状态，不使用 D1 保存 IMA 凭据。

## Runtime invariant

- Cloudflare Worker service name: `ima-mcp-worker`.
- GitHub repository name: `ima-mcp-worker`.
- No object storage binding or third-party public export flow.
- `/health` is stateless liveness.
- `/ready` validates required secrets/bindings without D1.
- Existing domain safety checks remain authoritative for write-capable tools.
- The historical SQLite Durable Object class/binding is retained inert for deployment compatibility, not for export or authentication.
