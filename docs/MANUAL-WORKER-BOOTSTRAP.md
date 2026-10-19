# 手动发布 MCP Workers：全局配置 + Worker 独立配置空间

本项目没有 staging/production 等多环境运行模式。每个 Worker 使用一个**同名 GitHub Environment**，只作为 Secrets / Variables 的独立配置空间；部署目标仍是唯一的 Cloudflare Worker，入口仍为 GitHub Actions → CI → Run workflow（必须选 `main`）。

> **迁移提醒**：旧 GitHub `production` Environment 不会被代码自动删除，也不会自动迁移其 Secrets。迁移并确认新配置完整前请保留它，**不要运行任何新版手动部署**。本次代码变更不会部署 Worker。

## 1. Repository 全局配置

在 [GitHub repository Actions secrets and variables](https://github.com/lirtual/mcp-workers/settings/secrets/actions) 配置：

| 层级 | 类型 | 名称 | 作用 |
| --- | --- | --- | --- |
| Repository | Secret | `CLOUDFLARE_API_TOKEN` | Wrangler 和只读发布检查所需 Cloudflare API Token |
| Repository | Secret | `MCP_ACCESS_TOKEN` | 所有 Worker 首次部署的**默认** Portal Bearer Token |
| Repository | Variable | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID |

如果之前将 Cloudflare Token 或账户 ID 仅保存在 `production` Environment 中，请自行将**原值**迁到 Repository（已隐藏的 Secret 无法从 GitHub 取回明文；须使用自己保存的凭据或重新签发）。不要放进代码、PR、Issue 或聊天中。

**注意**：同名 Environment Secret 优先于 Repository Secret。例如某个 Worker 使用独立 Portal Token，可以在该 Worker 的 Environment 中单独设置 `MCP_ACCESS_TOKEN`。这只影响后续**首次部署**的 Secret 注入；已经部署的 Worker 上的 Token 不会在普通发布时被自动更换。Portal 侧的 Bearer Token 必须对应匹配，统一密钥并不意味着现有 Worker 会自动轮换。

## 2. 每个 Worker 对应自己的同名 GitHub Environment

打开 [Settings → Environments](https://github.com/lirtual/mcp-workers/settings/environments)，建立下表所列的**环境名称**（名称只是配置作用域，不代表 staging/production）。在每个环境里添加 **Environment variable**：
`WORKER_CONFIG_SCOPE`，值必须与**环境名称完全一致**。此标记用于防止 GitHub 自动生成空 Environment 时意外发布。

| Environment 名称 | 所需 Environment Secrets | 可选 Environment Variables |
| --- | --- | --- |
| `raindrop-mcp-worker` | `RAINDROP_ACCESS_TOKEN` | `RAINDROP_RATE_LIMIT_MAX_RETRIES` |
| `ima-mcp-worker` | `API_KEY`、`CLIENT_ID` | `IMA_BASE_URL` |
| `database-mcp-worker` | `DATABASE_CONFIG` | `MAX_ROWS`、`MAX_RESULT_BYTES`、`MAX_SCHEMA_BYTES`、`QUERY_TIMEOUT_MS`、`MAX_WRITE_AFFECTED_ROWS` |
| `ssh-mcp-worker` | `MCP_BROKER_TOKEN` | 暂无 |
| `remote-control-mcp-worker` | 无新增必需密钥（正常发布保留 Cloudflare 现有 Secret） | 暂无 |

所有 Worker 可继承 Repository Secret `MCP_ACCESS_TOKEN`；单个 Worker 如需例外，可配置同名 Environment Secret 覆盖。配置特殊保密数据只能使用 **Secret**，不能使用 **Variable**。

`DATABASE_CONFIG` 直接填写原始、完整 JSON 文本（作为**单个 Secret 值**），例如：

```json
{"scrape_relay":"mysql://user:password@host:3306/scrape_relay"}
```

不需要 `*_SECRETS_JSON`、不需要套一层 JSON、也不需要手动转义双引号。

SSH 的 `MCP_BROKER_TOKEN` 应与现有 `edgessh` Broker 侧配置的令牌相同（最少 32 字符）。保留 `edgessh` 的 `MCP_BROKER_HOST_IDS` 白名单。正式 SSH Worker 使用私有 `EDGE_SSH_BROKER` Service Binding，不复制 `ENCRYPTION_KEY` 或 `EDGE_SSH_DB`；默认受限，不启用 `MCP_BROKER_FULL_ACCESS`。

GitHub 的 Environment 如果配置了所需审批/分支保护，请为每个 Worker 的 Environment **重新设置同等保护**；原 `production` 的保护规则不会继承。Repository 级密钥对拥有工作流修改/运行权限的人仍可见于任务运行上下文，请限制主分支修改权限与发布权限。

## 3. Variables 的行为与限制

GitHub Environment Variables 只影响对应 Worker。工作流显式允许下面的运行时覆盖，其余变量不会自动传入 Cloudflare：

- Raindrop：`RAINDROP_RATE_LIMIT_MAX_RETRIES`（0–10）。
- IMA：`IMA_BASE_URL`（HTTPS URL，不能包含 URL 凭据）。
- Database：`MAX_ROWS`（1–5000）、`MAX_RESULT_BYTES`（1–8388608）、`MAX_SCHEMA_BYTES`（1–4194304）、`QUERY_TIMEOUT_MS`（1–60000）、`MAX_WRITE_AFFECTED_ROWS`（1–100）。
- SSH、Remote Control：本次不允许附加运行时变量，保留源码安全配置。

未填写可选 Variable 时仍采用 `wrangler.jsonc` 中的默认值（以及原本保留的运行时配置）。填写后会由 `wrangler deploy --var` 传入**当前选中的 Worker**，并在发布前进行类型/范围验证。不要把数据库密码或访问 Token 当作 Variable。

## 4. 手动部署

1. 完成上述全局配置和对应 Worker 的配置空间迁移；不用删除旧 `production` 环境。
2. 打开 [GitHub Actions → CI](https://github.com/lirtual/mcp-workers/actions/workflows/ci.yml)，选择 `main`，每次只选择一个 Worker。
3. 若 `WORKER_CONFIG_SCOPE` 不是所选 Worker 名称，任务在取得 Cloudflare 部署权限之前中止。
4. Preflight 严格检查 Cloudflare 账户与 Worker 是否存在。若缺失且属于 Raindrop/IMA/Database/SSH，安全校验选中 Worker 的非空 Secrets 后一次性写入权限 0600 的 runner 临时文件，并用 `wrangler deploy --secrets-file` 新建 Worker。
5. 若 Worker 已存在，则沿用当前 Secret，不重复覆盖或轮换。**Remote Control 仍不可使用首次部署模式**，且不更改已有 DeviceCoordinator/Agent 状态。
6. 部署后核对 Cloudflare 100% 活跃版本、所需绑定与安全设置。最后通过原 Portal 做一次认证读取验收。不得误将未认证 401/403 当作已通过端到端验收。

如果一次部署因环境缺少密钥/变量而失败，仅修复选中 Environment，然后重新手动发起任务；不要在失败后自动清空 DO 或重建其他 Worker。

## 5. 删除旧 Environment 的条件

只有在完成 Repository 全局凭据迁移、**所有需要使用的 Worker** 创建独立 Environment、确认旧 `production` 里的密钥/变量及保护规则均已妥善迁移后，才自行删除旧 `production`。本次改动不会自动删除该 Environment 或 Cloudflare 上的任何东西。
