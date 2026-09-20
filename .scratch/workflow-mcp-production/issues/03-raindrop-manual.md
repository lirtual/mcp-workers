# T03 — 接入 Raindrop，并打通手动读取与结果查询

Status: draft — awaiting granularity review
Priority: P1
Blocked by: T01, T02
Proposed triage label: blocked
Spec: docs/workflow-mcp/v0.1-spec.md §27.1, §28.3; docs/workflow-mcp/v0.1-scope.md operational acceptance

## 问题

当前 MCP tracer 仅调用自身；需要一个可手动验证的真实只读业务流程。

## 交付范围

- 新增命名 Raindrop Connection、独立业务凭证和 list_raindrops 的显式只读策略。
- 新增 raindrop-daily-snapshot 定义，先支持手动执行；参数 collectionId=0,page=0,perPage=20,sort=-created,skipCache=true。
- 通过现有结果/产物机制存储结构化返回，使用 workflow_result 查询；更新配置说明。

## 验收标准

- [ ] 运行时发现并校验真实 list_raindrops schema/auth，缺失或不兼容时显式失败。
- [ ] 手动运行返回最新至多 20 条收藏；0 条合法，不把上游错误转换为空成功。
- [ ] 只使用 Cloudflare executor；不修改收藏、不发送通知。
- [ ] 记录 run ID 和脱敏验证结果，不把收藏正文或凭证提交到公开仓库。

## 边界

仅覆盖本工单的运行链路；不新增动态插件、多租户、任意代码执行或凭证保险库。不得将凭证或个人收藏正文写入仓库。生产执行与配置变更必须记录真实结果，不以测试桩通过替代线上验收。

