# T06 — 补齐取消与异常恢复的可重复验收

Status: draft — awaiting granularity review
Priority: P1
Blocked by: T01, T04
Proposed triage label: blocked
Spec: docs/workflow-mcp/v0.1-spec.md §27.1, §28.3; docs/workflow-mcp/v0.1-scope.md operational acceptance

## 问题

正常路径 tracer 已通过，但不能替代平台事件、取消及失败恢复证据。

## 交付范围

- 核对现有测试，复用已覆盖场景；为缺少的平台证据提供受控验收入口，避免重复建设测试框架。
- 覆盖回调入库后通知失败的恢复、取消停止新步骤、执行器结果不确定的真实状态。
- 只对专用只读/测试 Run 注入故障；给出执行步骤、清理方式和脱敏证据结构。

## 验收标准

- [ ] 通知失败时 inbox 数据保留，维护/协调路径最终收敛且不重复业务执行。
- [ ] cancel_requested 后不启动新 Step；无法确认停止时不得伪报已取消。
- [ ] 不确定外部结果不自动重试非幂等操作。
- [ ] 本地可证明部分与需真实 Workflows 验证部分明确区分，T07 可按说明执行。

## 边界

仅覆盖本工单的运行链路；不新增动态插件、多租户、任意代码执行或凭证保险库。不得将凭证或个人收藏正文写入仓库。生产执行与配置变更必须记录真实结果，不以测试桩通过替代线上验收。

