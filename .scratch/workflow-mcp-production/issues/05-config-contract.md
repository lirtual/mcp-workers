# T05 — 迁移发布 tracer 并清理正式环境测试配置

Status: draft — awaiting granularity review
Priority: P1
Blocked by: T01, T02, T03, T04
Proposed triage label: blocked
Spec: docs/workflow-mcp/v0.1-spec.md §27.1, §28.3; docs/workflow-mcp/v0.1-scope.md operational acceptance

## 问题

新配置和真实 Connection 可用后，才能移除旧运行变量与 smoke 密钥。

## 交付范围

- 将 MCP 发布 tracer 改为真实只读连接，保留重任务/R2 tracer；调整原先假定自身 workflow_list 返回的断言。
- 删除旧 executor/OIDC 环境入口及三项生产 smoke 配置，更新 Env、Wrangler、生成注册表、测试和 README。
- 确保没有悬空工作流/Connection/secret 引用；核查非终态 pinned plans，必要时阻塞清理直至其完成。
- 列明线上移除绑定顺序与回滚步骤；实际发布/清理归 T07。

## 验收标准

- [ ] 基础配置契约为五个 Secrets 与四个自动生成普通变量，业务凭证单独计数。
- [ ] 不合并不同用途密钥，不改造 R2 直传及签名下载架构。
- [ ] 发布检查不依赖 SMOKE_MODERN_MCP_ENDPOINT、SMOKE_READONLY_MCP_TOKEN、TRIGGER_SMOKE_WEBHOOK_TOKEN。
- [ ] registry/typecheck/lint/相关测试及 dry-run 通过，旧 nonterminal plan 无隐式失效。

## 边界

仅覆盖本工单的运行链路；不新增动态插件、多租户、任意代码执行或凭证保险库。不得将凭证或个人收藏正文写入仓库。生产执行与配置变更必须记录真实结果，不以测试桩通过替代线上验收。

