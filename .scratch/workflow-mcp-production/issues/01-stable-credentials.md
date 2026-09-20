# T01 — 稳定运行凭证，使部署结束后仍能执行 GitHub 重任务

Status: draft — awaiting granularity review
Priority: P0
Blocked by: None
Proposed triage label: ready-for-agent
Spec: docs/workflow-mcp/v0.1-spec.md §27.1, §28.3; docs/workflow-mcp/v0.1-scope.md operational acceptance

## 问题

部署流水线将 github.token 写入长期 Worker，并在每次部署随机生成客户端及执行器密钥；Job 内通过的 tracer 无法证明持续可用。

## 交付范围

- 修改 .github/workflows/workflow-mcp-deploy.yml 的凭证来源及注入方式；遵循 ADR 0023，使用仓库级细粒度 Token。
- 普通部署保留 MCP、Webhook（迁移完成前）、执行器签名和 R2 凭证；缺失时明确报错，不回退到临时令牌。
- 补充运行配置说明和针对部署凭证契约的验证。不要打印、提交或重新生成现有密钥。

## 验收标准

- [ ] 部署逻辑不再将 github.token 写入 Worker GITHUB_ACTIONS_TOKEN；临时 token 仅可供 Job 自身调用 GitHub。
- [ ] 普通重复部署不轮换 MCP_ACCESS_TOKEN 或 EXECUTOR_LEASE_SECRET。
- [ ] 凭证不出现在日志、工单、构建产物中；缺少所需持久凭证明确阻塞发布。
- [ ] 提供部署 Job 结束后可独立启动重任务的验证入口，最终线上证据由 T07 收集。

## 边界

仅覆盖本工单的运行链路；不新增动态插件、多租户、任意代码执行或凭证保险库。不得将凭证或个人收藏正文写入仓库。生产执行与配置变更必须记录真实结果，不以测试桩通过替代线上验收。

