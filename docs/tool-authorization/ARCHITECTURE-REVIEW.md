# mcp-workers 客户端工具审批方案 — 独立架构审查

审查日期：2026-10-13
审查状态：**有条件通过 / 允许启动受限代码 PR / 当前不可直接发布生产**
范围：`docs/tool-authorization/IMPLEMENTATION-PLAN.md`、主 ADR、四个 Worker 的源代码及已有发布契约。仅静态代码及文档核查，**没有运行本地测试、验证真实客户端、操作 Secret 或部署 Worker**。

## 总结

目标方向有合理性：减少重复的 Worker 工具审批，客户端负责用户交互，保留 Portal Bearer、上游数据库/OS 权限及执行安全约束；不需要构建统一权限管理平台。

但“工具审批（客户端 UX）”、“部署能力开关（服务器保护）”、“资源身份（数据库用户/Linux 账号）”不能混为一谈。当前设计存在若干真实风险，必须在相应代码 PR 和独立发布验收中关闭。较小的 IMA 简化可以开始；Raindrop、Database、Remote Control 不应因 Grilling 完成而直接发布。

## 源码证实的发现

### P0-R1：Raindrop 客户端收不到计划中的工具风险标注

- `apps/raindrop-mcp-worker/src/tools/common.ts` 中 `ToolConfig` 不包含 `annotations`。
- `apps/raindrop-mcp-worker/src/services/raindropmcp.service.ts` 的 `registerDeclarativeTools()` 调用 `server.registerTool` 时只传 title、description、inputSchema、outputSchema，**没有传 annotations**。
- 仅在 cleanup handler 添加 `destructiveHint` 不会使其进入 MCP `tools/list`。
- 最小修正：为已有 `ToolConfig` 添加可选的 MCP annotations 字段，在现有注册函数中透传；标注所有受影响的清理工具 `readOnlyHint:false` / `destructiveHint:true`，以及仍属只读的工具。通过 `tools/list` 协议层测试而不是只检查 `ToolConfig`。
- 风险标注仅是客户端提示，不能等同强制人类审批；任何声明“ChatGPT 必定弹窗”的验收都无依据。

### P0-R2：Q17 所述的保守去重规则目前并未在此实现

- `apps/raindrop-mcp-worker/src/tools/cleanup.ts` 的 `remove_duplicates` 将 API 返回项目直接提取 `_id`、分组并调用 `batchDeleteBookmarksInCollection`。现有 handler 中看不到“有笔记/高亮的重复书签不删除”的过滤，尽管 `CONTEXT.md` 和方案声称保留此项。
- `apps/raindrop-mcp-worker/tests/remove_duplicates.test.ts` 覆盖 batch/fail-fast，却未证明含 notes/highlights 条目的排除。
- 每批 50 是**请求批量大小**，不是整个调用的删除总数上限。该工具可遍历所有 collections 和分页、删除全部收集的重复项；没有全调用总量上限，不能把它描述为“每次最多删除 50”。
- 最小修正：先补齐可验证的资格过滤测试，明确 Raindrop upstream 是否实际返回识别备注/高亮所需字段；缺少证明时禁止声称已保护。确定批量删除实际可接受的总作用范围和失败路径；不需要开发新的去重算法或权限框架。

### P0-R3：保留旧名的破坏性语义变更，必须拒绝旧请求

- 当前 `empty_trash` 和 `cleanup_collections` 无 `confirm:true` 就仅预览；`remove_duplicates` 省略 `dryRun` 默认预览。
- Q14=B 有意保留旧名并改成一次调用即执行。如果旧客户端传 `confirm:false` 或 `dryRun:true`，新接口**不得忽略该字段然后删除**。Zod `z.object` 通常默认剥离未知键，因此仅从 schema 移除字段未必阻断旧参数。
- 最小修正：将这些工具的入参 object 显式设为 strict（或等效地在 MCP 输入层拒绝未知 `confirm`/`dryRun`），添加协议级负例测试：`confirm:false`、`confirm:true`、`dryRun:true`、`dryRun:false` 和废弃字段均不得误执行；新版无此字段的合法调用才直接执行。
- 实际 ChatGPT 断开/重连、重新发现工具并核对破坏性描述，是 Q18 的发布门槛。**发布后刷新**不能倒推证明“发布前不存在任何已连接客户端风险”；必要时用短期隔离的非正式测试入口与模拟数据验证候选定义，或明确接受受控上线窗口。
- `services/raindropmcp.service.ts` 的 experimental elicitation 描述仍声称 destructive action 需要 confirmation，实施时应同步清理失实宣告。

### P0-R4：Remote Control 入口开关具有独立的部署安全价值

- `apps/remote-control-mcp-worker/src/worker.ts` 现用 `REMOTE_CONTROL_ENABLE_FILE_WRITES` 和 `REMOTE_CONTROL_ENABLE_SHELL` 限制 `tools/list` **以及** `tools/call`。这不是每次操作弹窗，而是一个真实的服务端生产暴露开关。
- 删除后，拥有正确 MCP/设备凭据的客户端可在现有 Linux 用户权限下调用文件操作/Shell。既有设计明确没有 Docker 沙箱和路径 allowlist；“测试只用临时目录”是测试纪律，**不是服务器强制权限边界**。
- 当前 T10 发布验收资料将 T09 PID/PGID 停止竞态、用户权限边界、历史凭据日志问题等列为未闭环风险。Q15=A 并未授权启用。
- 最小要求：I4 代码 PR 可以离线开发，但**禁止仅凭统一 ADR 发布生产**；现有环境的任何测试版切换必须明确批准、以真实主机权限为边界、记录正在暴露的整个能力和安全恢复步骤。谨慎重新比较保留一个粗粒度“紧急禁用 Shell”开关与删除全部部署开关的净收益；这是架构安全取舍的建议，**并不擅自更改 Q1 的已批准决定**。

### P1-D1：Database Cloudflare Secret 更新可能先发布不兼容版本

- 新代码拒绝旧 `DATABASE_CONFIG`；当前生产配置仍是 role-separated `read/write/admin`。现方案接受短暂 fail-closed 维护（Q19=A），但把 Cloudflare Secret 修改与 `workflow_dispatch` Wrangler 发布写成独立步骤，还未证明两者的版本/激活顺序。
- Cloudflare 官方 Wrangler 文档说明 `wrangler secret put` **创建并立即部署新版本**，而 `wrangler versions secret put` 只创建待发布版本。这与“GitHub Actions `workflow_dispatch` 是唯一发布入口”的字面表述冲突：一个运行时 Secret 的普通修改也是一次激活操作。
- 最小修正：部署前以非生产 Secret/Worker 验证迁移顺序，并写出一份单页 Runbook：开始拒绝请求的条件、Secret 版本准备方法、GitHub 代码发布的先后、版本读回、错误处理和经批准的恢复方法。不要在 Actions 中暴露数据库密码，也不要引入持续双格式 parser。

### P1-D2：单 `connection` 不等于所有连接都能执行 DDL

- `src/admin-config.ts` 目前明确拒绝 Hyperdrive DDL；`src/config.ts` 的 direct URL 解析对请求 TLS 的直连 URL 返回错误。
- 在要求 TLS 的远程数据库、而又只能走 Hyperdrive 的场景，新格式尽管只有一个 principal，也**不能执行 DDL**。这不是连接失败后可自动切换高权限 URL 的理由。
- 最小修正：把“Hyperdrive 连接的 DDL 不支持”和 direct/TLS 边界写进工具能力文档和测试；由实际使用方决定是否可接受该限制。不要为一项配置精简顺便扩展未经验证的 DDL/TLS 能力。

### P1-R5：破坏性工具验收存在时序问题

- 旧工具名不变且默认语义变为删除，因此候选部署前现有 ChatGPT 只能看到旧 server 的 tool description。所谓“生产部署**前**真实 ChatGPT 刷新并观察**新**工具定义”，需要一个实际运行新代码的非生产候选路径；否则无法完成。
- 最小修正：区分 **代码发布前** 的协议/SDK/模拟上游测试与 **发布后的** 真实客户端同步验收，并明确已上线而未通过刷新验收期间的风险及停机/恢复操作。不能在同一行把两者视为同一个前置条件。

### P2-C1：文档重复高于实现本身，继续 Grilling 没有收益

- 现有六轮 19 项决策、跨 Worker ADR、独立 ADR、两个领域 CONTEXT、发布 Runbook 和 IMPLEMENTATION-PLAN 多次重复相同约束。
- 保留 ADR 历史和被 supersede 的记录是合理的；新实施只以 `IMPLEMENTATION-PLAN.md` 作为工作分解入口，以各 app 当前状态 ADR 作规范来源。避免继续添加新概念、权限矩阵、集中化审计服务或更多设计轮次。
- IMA 的 `allowWrite=true` 已是常量传入，删除可选分支属于合理的小规模清理。其他三个 Worker 是行为/权限边界变化，不能按“同样只是删布尔开关”估计风险。

## 审查裁决和工作优先级

| 阶段 | 是否可开始代码 PR | 是否满足生产发布条件 | 需要修正 |
| --- | --- | --- | --- |
| I0 基线测试 | 是 | 不涉及发布 | 将工具 metadata 和 unknown args 纳入协议测试 |
| I1 IMA | 是 | 尚未验证 | 删除冗余参数，跑回归，不牵涉 IMA R2/Litterbox |
| I2 Raindrop | 是，仅离线 | **否** | P0-R1/R2/R3、P1-R5；真实客户端刷新 |
| I3 Database | 是，仅离线 | **否** | P1-D1/D2；测试新配置与维护流程 |
| I4 Remote Control | 是，仅离线 | **否** | P0-R4；T07/T09/T10 与额外单独授权 |

### 最小修正方案

1. **不新增权限基础设施**：仅修复既有 Raindrop tool registration 的 annotations 透传、原清理操作的候选筛选/未知参数处理、现有连接解析和 Remote Control 调用入口。
2. **不重写 SQL、去重算法或 Agent**：每个改动基于当前工具形状和明确测试；保留既定安全边界、率限、回执和真正的资源授权。
3. **不进一步展开 grilling**：上述属于具体代码验证/发布流程问题。若用户要接受 Remote Control 取消生产应急开关或 Raindrop 同名语义破坏风险，必须在对应代码 PR/发布评审明确记录，而不是创建更多全局 ADR。
4. **生产分权不变**：Cloudflare Secret、任何失效/中断测试、真正的 Raindrop 清理、Remote Control 写入/Shell，均需之后明确授权；当前文档变更不授权任何执行。

## 结论

**有条件通过架构方向，不是无条件通过实施与生产上线。** 不需要重做 Q1–Q19，也不值得再开展额外采访。先实施并修复实际代码与测试发现；按 IMA → Raindrop → Database → Remote Control 顺序推进，每一项独立审查、独立接受。

审查依据：`apps/raindrop-mcp-worker/src/tools/{common,cleanup}.ts`、`src/services/raindropmcp.service.ts`、`tests/{remove_duplicates,cleanup_destructive,tool_contract}.test.ts`、`apps/database-mcp-worker/src/{config,admin-config,mcp}.ts`、`apps/remote-control-mcp-worker/src/worker.ts`、`docs/remote-control/T10-RELEASE-ACCEPTANCE.md`、`.github/workflows/ci.yml`、官方 MCP Tools annotations 规范及 Cloudflare Workers Secret 文档。
