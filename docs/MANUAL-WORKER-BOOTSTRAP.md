# 手动发布 MCP Workers：全局配置 + Worker 独立配置空间

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

| Environment 名称 | 所需 Environment Secrets | 可选 Environment Variables |
| --- | --- | --- |
| `raindrop-mcp-worker` | `RAINDROP_ACCESS_TOKEN` | `RAINDROP_RATE_LIMIT_MAX_RETRIES` |
| `ima-mcp-worker` | `API_KEY` | **`CLIENT_ID`（必填）**、`IMA_BASE_URL`（可选） |
| `database-mcp-worker` | `DATABASE_CONFIG` | `MAX_ROWS`、`MAX_RESULT_BYTES`、`MAX_SCHEMA_BYTES`、`QUERY_TIMEOUT_MS`、`MAX_WRITE_AFFECTED_ROWS` |
| `ssh-mcp-worker` | `MCP_BROKER_TOKEN` | 暂无 |
| `remote-control-mcp-worker` | 无新增必需密钥（正常发布保留 Cloudflare 现有 Secret） | 暂无 |
| `github-actions-mcp-worker` | `GH_TOKEN` | 暂无 |
| `workflow-mcp-worker` | `MCP_PORTAL_CLIENT_ID`、`MCP_PORTAL_CLIENT_SECRET`、`WORKFLOW_EXECUTOR_GITHUB_TOKEN` | 发布脚本固定注入 `MCP_PORTAL_ENDPOINT` 等受审查配置 |

所有 Worker 可继承 Repository Secret `MCP_ACCESS_TOKEN`；单个 Worker 如需例外，可配置同名 Environment Secret 覆盖。配置特殊保密数据只能使用 **Secret**，不能使用 **Variable**。

`DATABASE_CONFIG` 直接填写原始、完整 JSON 文本（作为**单个 Secret 值**），例如：

```json
{"scrape_relay":"mysql://user:password@host:3306/scrape_relay"}
```

不需要 `*_SECRETS_JSON`、不需要套一层 JSON、也不需要手动转义双引号。

SSH 的 `MCP_BROKER_TOKEN` 应与现有 `edgessh` Broker 侧配置的令牌相同（最少 32 字符）。如果在 GitHub 修改该 Token，请先安排 EdgeSSH Broker 侧凭据同步：本项目仅管理 `ssh-mcp-worker`，不会自动更新仓库之外的 `edgessh`。保留 `edgessh` 的 `MCP_BROKER_HOST_IDS` 白名单。正式 SSH Worker 使用私有 `EDGE_SSH_BROKER` Service Binding，不复制 `ENCRYPTION_KEY` 或 `EDGE_SSH_DB`；默认受限，不启用 `MCP_BROKER_FULL_ACCESS`。

GitHub 的 Environment 如果配置了所需审批/分支保护，请为每个 Worker 的 Environment **重新设置同等保护**；原 `production` 的保护规则不会继承。Repository 级密钥对拥有工作流修改/运行权限的人仍可见于任务运行上下文，请限制主分支修改权限与发布权限。

## 3. Variables 的行为与限制

GitHub Environment Variables 只影响对应 Worker。工作流显式允许下面的运行时覆盖，其余变量不会自动传入 Cloudflare：

- Raindrop：`RAINDROP_RATE_LIMIT_MAX_RETRIES`（0–10）。
- IMA：**`CLIENT_ID`（必填，非空、不能包含空格或控制字符，最大 512 字符）**；`IMA_BASE_URL`（可选 HTTPS URL，不能包含 URL 凭据）。
- Database：`MAX_ROWS`（1–5000）、`MAX_RESULT_BYTES`（1–8388608）、`MAX_SCHEMA_BYTES`（1–4194304）、`QUERY_TIMEOUT_MS`（1–60000）、`MAX_WRITE_AFFECTED_ROWS`（1–100）。
- SSH、Remote Control：本次不允许附加运行时变量，保留源码安全配置。

未填写可选 Variable 时仍采用 `wrangler.jsonc` 中的默认值；GitHub 中填写时会由 `wrangler deploy --var` 传入**当前选中的 Worker**，并在发布前进行类型/范围验证。受管 Worker 使用 `keep_vars: false`，所以旧 Cloudflare Dashboard 中**没有在源码或当前 GitHub Variables 明确声明的普通 Variable 会在下次手动部署后被清理**。不要把数据库密码或访问 Token 当作 Variable；Durable Object、Service Binding 和 Secret 不属于这些可选纯文本 Variable。

## 4. 手动部署

1. 完成上述全局配置和对应 Worker 的配置空间迁移；不用删除旧 `production` 环境。
2. 打开 [GitHub Actions → Release Worker](https://github.com/lirtual/mcp-workers/actions/workflows/release.yml)，选择 `main`，每次只选择一个 Worker，并显式勾选 `deploy_to_production`。
3. GitHub 自动选择与所选 Worker 同名的 Environment；**每次发布**必须找到该 Worker 所有必需 Secrets，以及 IMA 的必填 `CLIENT_ID` Environment Variable，缺一即中止，绝不静默沿用 Cloudflare 上的旧值。
4. Preflight 检查 Cloudflare 账户与 Worker 是否存在。随后无论是首次部署还是更新，都仅将**选中 Worker** 的全部必需非空 Secrets 写入权限 0600 的 runner 临时文件，执行 `wrangler deploy --secrets-file`；未列出的现有 Secret 不会因本次上传而自动删除。
5. 若 Worker 已存在，GitHub 的必需 Secret 值会覆盖 Cloudflare 对应值。Remote Control 也使用同一套密钥同步规则，但其 `DEVICE_COORDINATOR` Durable Object、配对、Agent 身份及回执均不应因 Secret 同步被重置或迁移。
6. 部署后核对 Cloudflare 100% 活跃版本、所需绑定与安全设置。最后通过原 Portal 做一次认证读取验收。不得误将未认证 401/403 当作已通过端到端验收。

**重要迁移提示**：现网某些 Secret 曾在 Cloudflare Dashboard 直接修改（尤其 IMA）。在第一次使用新版发布流程前，请确保 GitHub 对应 Secret 已更新为当前有效值，否则新的 GitHub 值会覆盖 Cloudflare 中已修复的值。Cloudflare API 无法读取 Secret 明文，发布前只能校验存在性、格式，不能核对两边是否相等。本次将 `CLIENT_ID` 改为 GitHub Environment Variable，并通过 `wrangler deploy --var CLIENT_ID:...` 同步为 Cloudflare 普通 Variable。Cloudflare 现网旧的同名 Secret 可能与新绑定发生冲突，发布后会严格校验 `CLIENT_ID` 已为非空 `plain_text` 且没有旧 Secret；若冲突导致失败，不能把发布失败当成已迁移，须核对 Wrangler 报错后再采取一次性迁移措施。

如果一次部署因缺少密钥/变量而失败，仅修复选中 GitHub Environment，然后重新手动发起任务；不要在失败后自动清空 DO 或重建其他 Worker。修改 GitHub 本身不会在后台自动同步：只有手动触发该 Worker 发布时才执行。

## 5. IMA CLIENT_ID 从 Secret 迁移到 Variable（一次性）

1. 打开 [GitHub Environments](https://github.com/lirtual/mcp-workers/settings/environments) → `ima-mcp-worker` → **Environment variables**，创建 `CLIENT_ID`，值为目前已通过验收的有效 IMA Client ID。请勿填写 `API_KEY`，它继续留在 Environment Secrets。
2. 确认 `API_KEY`、全局 `MCP_ACCESS_TOKEN` 已是当前有效值。**设置 GitHub Variable 不会自动变更 Cloudflare**。本次 PR 合并也不会部署。
3. 由你手动执行一次 `main` 分支的 `ima-mcp-worker` 工作流。先校验必填 Variable，再通过 Wrangler 将 `CLIENT_ID` 作为普通 Variable 同代码发布，发布后检查绑定必须为 `plain_text` 而不是旧 `secret_text`。
4. 原 Cloudflare `CLIENT_ID` 是 Secret，Wrangler 默认保留未列出的 Secret；同名类型切换是否被接受须以真实发布和 readback 为准。若出现冲突，**不要提前删除现网有效 Secret 或绕过校验**，应记录失败并制定一次性迁移步骤。首次发布成功后可清理 GitHub 中不再使用的旧 Environment Secret `CLIENT_ID`，仅保留 Variable。

以上只改变 IMA 的 Client ID 类型，其他 Worker 的 Secret 同步、安全配置及 Durable Objects 均保持不变。

## 6. 删除旧 Environment 的条件

只有在完成 Repository 全局凭据迁移、**所有需要使用的 Worker** 创建独立 Environment、确认旧 `production` 里的密钥/变量及保护规则均已妥善迁移后，才自行删除旧 `production`。本次改动不会自动删除该 Environment 或 Cloudflare 上的任何东西。
