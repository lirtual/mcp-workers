# 手动发布 MCP Workers：全局配置 + Worker 独立配置空间

**Spec #392 退役说明**：微信源码与发布流程已迁至独立 [cloudflare-actions](https://github.com/lirtual/cloudflare-actions)；本仓库不再部署、注册或测试旧微信 MCP。原生产 D1、密文和 Owner Access 由独立 Provider 维护，不能从本仓库恢复旧 MCP。

本项目没有 staging/production 等多环境运行模式。每个 Worker 使用一个**同名 GitHub Environment**，只作为 Secrets / Variables 的独立配置空间；部署目标仍是唯一的 Cloudflare Worker，入口为 GitHub Actions → Release Worker → Run workflow（必须选 `main`）。

> **迁移提醒**：旧 GitHub `production` Environment 不会被代码自动删除，也不会自动迁移其 Secrets。迁移并确认新配置完整前请保留它，**不要运行任何新版手动部署**。本次代码变更不会部署 Worker。

## 1. Repository 全局配置

在 [GitHub repository Actions secrets and variables](https://github.com/lirtual/mcp-workers/settings/secrets/actions) 配置：

| 层级 | 类型 | 名称 | 作用 |
| --- | --- | --- | --- |
| Repository | Secret | `CLOUDFLARE_API_TOKEN` | Wrangler 和只读发布检查所需 Cloudflare API Token |
| Repository | Secret | `MCP_ACCESS_TOKEN` | 所有 Worker 每次手动发布时同步的**默认** Portal Bearer Token |
| Repository | Variable | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID |

如果之前将 Cloudflare Token 或账户 ID 仅保存在 `production` Environment 中，请自行将**原值**迁到 Repository（已隐藏的 Secret 无法从 GitHub 取回明文；须使用自己保存的凭据或重新签发）。不要放进代码、PR、Issue 或聊天中。

**注意**：同名 Environment Secret 优先于 Repository Secret。例如某个 Worker 使用独立 Portal Token，可在自己的 Environment 设置 `MCP_ACCESS_TOKEN`。**每次手动部署当前 Worker**，Actions 都会将 GitHub 中该 Worker 的全部必需 Secret 随代码同步到 Cloudflare；仅修改 GitHub Secrets 本身不会立即触发部署或轮换。若修改共享 `MCP_ACCESS_TOKEN`，其他 Worker 不会自动发布，应协调逐个发布、更新 Portal 客户端凭据，避免不同步造成认证中断。

## 2. 每个 Worker 对应自己的同名 GitHub Environment

打开 [Settings → Environments](https://github.com/lirtual/mcp-workers/settings/environments)，建立下表所列的**环境名称**（名称只是配置作用域，不代表 staging/production）。Actions 根据 `inputs.worker` 自动选择同名 Environment，无须配置 `WORKER_CONFIG_SCOPE` 或其他环境名称标记。请注意：GitHub 可能自动创建尚不存在的空 Environment，因此应在首次手动发布前配置专属 Secrets 和必要的审批/分支保护规则。**任何手动发布**缺少必需密钥都会在上传代码前终止。

| Environment 名称 | Environment Secrets（不含继承的 `MCP_ACCESS_TOKEN`） | Environment Variables |
| --- | --- | --- |
| `database-mcp-worker` | `DATABASE_ENCRYPTION_KEY`（密钥轮换时可选 `DATABASE_ENCRYPTION_PREVIOUS_KEY`） | **`DATABASE_KEY_ID`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`OWNER_EMAIL`（必填）**，以及可选的 `DATABASE_PREVIOUS_KEY_ID`、`MAX_ROWS`、`MAX_RESULT_BYTES`、`MAX_SCHEMA_BYTES`、`QUERY_TIMEOUT_MS`、`MAX_WRITE_AFFECTED_ROWS` |
| `email-mcp-worker` | `MAIL_ENCRYPTION_KEY` | `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`OWNER_EMAIL` |
| `ima-mcp-worker` | `IMA_API_KEY` | `IMA_CLIENT_ID`、`IMA_BASE_URL` |
| `raindrop-mcp-worker` | `RAINDROP_ACCESS_TOKEN` | `RAINDROP_RATE_LIMIT_MAX_RETRIES` |
| `ssh-mcp-worker` | `ENCRYPTION_KEY` | 无 |
| `remote-control-mcp-worker` | 无 | 无 |
| `github-actions-mcp-worker` | `ACTIONS_GITHUB_DISPATCH_TOKENS` | 无 |
| `http-mcp-worker` | `HTTP_CREDENTIALS_JSON`（可选） | 无 |
| `openlist-mcp-worker` | `OPENLIST_API_TOKEN` | `OPENLIST_ALLOWED_ROOTS` |
| `workflow-mcp-worker` | `MCP_PORTAL_CLIENT_SECRET`、`WORKFLOW_GITHUB_DISPATCH_TOKEN`、`SESSION_RUNTIME_DATA_KEY` | `MCP_PORTAL_CLIENT_ID`、`WORKFLOW_ACTION_APPROVED_REPOSITORIES` |

表中 Email 的三个 Access Variables、Database Owner 的三个 Access Variables、IMA 的 `IMA_CLIENT_ID`、OpenList 的 `OPENLIST_ALLOWED_ROOTS`、Workflow 的 `MCP_PORTAL_CLIENT_ID` 均为必填；Database 的 `DATABASE_KEY_ID` 是非敏感 Environment Variable，原有 `b2b`、`scrape_relay` 身份已由发布门禁固定校验，不需要 `DATABASE_CUTOVER_EXPECTED_IDS`。其余列出的 Variables 为可选。HTTP 的 `HTTP_CREDENTIALS_JSON` 是可选 Secret，未配置时不要提交空占位值。

所有 Worker 可继承 Repository Secret `MCP_ACCESS_TOKEN`；单个 Worker 如需例外，可配置同名 Environment Secret 覆盖。配置特殊保密数据只能使用 **Secret**，不能使用 **Variable**。

**Database MCP Spec #344 尚未切换生产。** 上表为 Draft 分支拟采用的 GitHub 发布配置契约，并非当前线上 Worker 已迁移。现网原有 `DATABASE_CONFIG` Secret 必须保留，直到真实 Cloudflare Workers MySQL/PostgreSQL TLS、专用 D1、独立 Owner Access、迁移完整性及回滚均经独立验收并取得生产切换授权。Draft 分支发布门禁明确禁止把旧完整 JSON 重新写入运行时。不要复制旧业务数据库凭据到测试实例，也不要提前运行 Database Worker 生产发布。参见 [Spec #344 切换与回滚清单](./database-cutover-344.md)。


当前 SSH Worker 使用与 EdgeSSH 已加密 D1 记录一致的 `ENCRYPTION_KEY`（规范 32 字节 Base64）作为 `ssh-mcp-worker` Environment Secret。退役的 `SSH_BROKER_TOKEN`、`MCP_BROKER_TOKEN` 与 `EDGE_SSH_BROKER` Service Binding 不再属于正式 SSH Worker 发布要求。不得为文档修正重建 D1、重置 Operations DO 或擅自轮换 EdgeSSH 密钥；遗留资源须独立审查后退役。

GitHub 的 Environment 如果配置了所需审批/分支保护，请为每个 Worker 的 Environment **重新设置同等保护**；原 `production` 的保护规则不会继承。Repository 级密钥对拥有工作流修改/运行权限的人仍可见于任务运行上下文，请限制主分支修改权限与发布权限。

## 3. Variables 的行为与限制

GitHub Environment Variables 只影响对应 Worker。工作流显式允许下面的运行时覆盖，其余变量不会自动传入 Cloudflare：

- Raindrop：`RAINDROP_RATE_LIMIT_MAX_RETRIES`（0–10）。
- IMA：**`IMA_CLIENT_ID`（必填，非空、不能包含空格或控制字符，最大 512 字符）**；`IMA_BASE_URL`（可选 HTTPS URL，不能包含 URL 凭据）。
- Database：`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`OWNER_EMAIL`（Owner Access 必填）；`DATABASE_KEY_ID`（Environment Variable，必填）；`MAX_ROWS`（1–5000）、`MAX_RESULT_BYTES`（1–8388608）、`MAX_SCHEMA_BYTES`（1–4194304）、`QUERY_TIMEOUT_MS`（1–60000）、`MAX_WRITE_AFFECTED_ROWS`（1–100）。
- Email：`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`OWNER_EMAIL`（三者必填，必须是已批准的 Access 生产身份值）。
- OpenList：`OPENLIST_ALLOWED_ROOTS`（必填，1–16 个经运行时路径解析器验证的绝对路径 JSON 数组）。
- Workflow：`MCP_PORTAL_CLIENT_ID`（必填）；`WORKFLOW_ACTION_APPROVED_REPOSITORIES`（可选，受控批准的仓库清单，发布流程映射为运行时 `GITHUB_ACTION_APPROVED_REPOSITORIES`）。
- SSH、Remote Control、GitHub Actions、HTTP：没有额外可自定义的 Environment Runtime Variables。Remote Control 安装地址从 Wrangler 自定义域名自动推导。

未填写可选 Variable 时仍采用 `wrangler.jsonc` 中的默认值；GitHub 中填写时会由 `wrangler deploy --var` 传入**当前选中的 Worker**，并在发布前进行类型/范围验证。受管 Worker 使用 `keep_vars: false`，所以旧 Cloudflare Dashboard 中**没有在源码或当前 GitHub Variables 明确声明的普通 Variable 会在下次手动部署后被清理**。不要把数据库密码或访问 Token 当作 Variable；Durable Object、Service Binding 和 Secret 不属于这些可选纯文本 Variable。

## 4. 手动部署

1. 完成上述全局配置和对应 Worker 的配置空间迁移；不用删除旧 `production` 环境。
2. 打开 [GitHub Actions → Release Worker](https://github.com/lirtual/mcp-workers/actions/workflows/release.yml)，选择 `main`，每次只选择一个 Worker，并显式勾选 `deploy_to_production`。
3. GitHub 自动选择与所选 Worker 同名的 Environment；**每次发布**必须找到该 Worker 所有必需 Secrets，以及 Email、IMA、OpenList、Workflow 各自的必填 Environment Variables，缺一即中止，绝不静默沿用 Cloudflare 上的旧值。
4. Preflight 检查 Cloudflare 账户与 Worker 是否存在。随后无论是首次部署还是更新，都仅将**选中 Worker** 的全部必需非空 Secrets 写入权限 0600 的 runner 临时文件，执行 `wrangler deploy --secrets-file`；未列出的现有 Secret 不会因本次上传而自动删除。
5. 若 Worker 已存在，GitHub 的必需 Secret 值会覆盖 Cloudflare 对应值。Remote Control 也使用同一套密钥同步规则，但其 `DEVICE_COORDINATOR` Durable Object、配对、Agent 身份及回执均不应因 Secret 同步被重置或迁移。
6. 部署后核对 Cloudflare 100% 活跃版本、所需绑定与安全设置。最后通过原 Portal 做一次认证读取验收。不得误将未认证 401/403 当作已通过端到端验收。

**每次发布前的凭据核对**：GitHub Secret 是本次发布的值来源；Cloudflare API 无法读回 Secret 明文，因而不能证明 GitHub 当前值与既有运行时值相同。发布会覆盖同名 Secret，尤其要先核对 IMA API Key、SSH 加密密钥等与现网一致。IMA 的 `IMA_CLIENT_ID` 和 Workflow 的 `MCP_PORTAL_CLIENT_ID` 必须为 GitHub Environment Variables，发布后由 Cloudflare 绑定读回验证为唯一的 `plain_text`。对确实仍保留旧 `CLIENT_ID` 或旧同名 Secret 的**遗留部署**，先按历史迁移记录核对并受控迁移；不要把已完成的一次性迁移当作每次日常发布的必经操作。

如果一次部署因缺少密钥/变量而失败，仅修复选中 GitHub Environment，然后重新手动发起任务；不要在失败后自动清空 DO 或重建其他 Worker。修改 GitHub 本身不会在后台自动同步：只有手动触发该 Worker 发布时才执行。

## 5. 仅适用于遗留部署的 IMA Client ID 更名

1. 若 Cloudflare 仍存在旧名 `CLIENT_ID` Variable，先在 `ima-mcp-worker` GitHub Environment Variables 中配置相同值的 `IMA_CLIENT_ID`；`IMA_API_KEY` 始终是 Secret。已完成更名的现网不要重复执行。
2. 核验 GitHub 中 `IMA_API_KEY`、`MCP_ACCESS_TOKEN` 的有效来源。发布需走受控的单 Worker GitHub Actions；仅修改配置不自动发布。
3. 发布前确认新变量非空，发布后回读 `IMA_CLIENT_ID` 是唯一 `plain_text` 绑定，旧 `CLIENT_ID` Variable 已消失；完成 IMA 功能验收后精确清理 GitHub 的旧 `CLIENT_ID` Variable。
4. Workflow 的 `MCP_PORTAL_CLIENT_ID` 是另一种**同名 Secret → Variable**历史迁移，与 IMA 的不同名字更名不是同一操作。只有旧绑定确实存在时才参考历史 #199 隔离验证记录评估迁移；日常发布直接要求唯一 `plain_text` 绑定和有效 Portal 客户端身份。

以上更名不改变 Client ID 值、IMA API 协议或其他 Worker 的权限。

## 6. 删除旧 Environment 的条件

只有在完成 Repository 全局凭据迁移、**所有需要使用的 Worker** 创建独立 Environment、确认旧 `production` 里的密钥/变量及保护规则均已妥善迁移后，才自行删除旧 `production`。本次改动不会自动删除该 Environment 或 Cloudflare 上的任何东西。
