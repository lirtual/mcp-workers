# T04 — 恢复系统 Cron 和维护循环，停用示例周期执行

Status: draft — awaiting granularity review
Priority: P0
Blocked by: T02
Proposed triage label: blocked
Spec: docs/workflow-mcp/v0.1-spec.md §27.1, §28.3; docs/workflow-mcp/v0.1-scope.md operational acceptance

## 问题

部署配置生成器设置 crons: []，使系统调度及回调补发维护没有周期触发。

## 交付范围

- 修正 build-deploy-config.ts，保留一个系统 Cron，驱动既有 scheduler/maintenance。
- 移除 trigger-http-smoke 每五分钟访问 example.com 的正式 schedule，保留合适的手动/测试覆盖。
- 验证调度去重、latest misfire 与维护批次，不新增队列产品或第二套调度器。

## 验收标准

- [ ] 生成配置包含且仅包含预期系统 Cron，不再被发布脚本清空。
- [ ] 没有正式周期运行的 example.com smoke。
- [ ] 同一 schedule occurrence 重复 tick 不重复创建 Run。
- [ ] 回调通知失败后可由维护 tick 补发；维护批次保持有界。

## 边界

仅覆盖本工单的运行链路；不新增动态插件、多租户、任意代码执行或凭证保险库。不得将凭证或个人收藏正文写入仓库。生产执行与配置变更必须记录真实结果，不以测试桩通过替代线上验收。

