# T07 — 启用 Raindrop 日程并完成部署后的独立线上验收

Status: draft — awaiting granularity review
Priority: P1
Blocked by: T05, T06
Proposed triage label: blocked
Spec: docs/workflow-mcp/v0.1-spec.md §27.1, §28.3; docs/workflow-mcp/v0.1-scope.md operational acceptance

## 问题

首版完成须证明正式服务脱离部署 Job 后仍可运行，且包含真实业务日程。

## 交付范围

- 为 raindrop-daily-snapshot 加入 0 9 * * *、Asia/Shanghai、misfire: latest；保留手动入口。
- 执行兼容检查、部署、按 T05 顺序清理废弃绑定并核查线上配置数量；稳定凭证缺失时只报告缺失名称。
- 在部署 Job 结束后独立验证 GitHub 重任务与 R2 产物读取，执行 T06 平台验收。
- 观察真实北京时间 09:00 定时发生并验证结果；可阶段记录待观察，不以手动调用冒充定时通过。
- 补齐应用 README：配置、部署、手动运行、结果查询、凭证轮换、故障恢复；记录现有数据保留行为和未确定事项，不擅自设置破坏性清理策略。

## 验收标准

- [ ] 实际 Raindrop 定时 Run 的计划时间、run ID、终态及可查询结果均有脱敏证据。
- [ ] 部署 Job 结束后的新 GitHub executor Run 成功，产物可读取。
- [ ] 最终线上配置为五个基础 Secrets、四个生成变量及实际业务需要的凭证；四个资源绑定保持完整。
- [ ] 取消/补发/不确定结果验收结论可追溯；未观察到的证据标记待完成。
- [ ] README 与真实部署一致，明确这是最新 20 条快照而非增量归档。

## 边界

仅覆盖本工单的运行链路；不新增动态插件、多租户、任意代码执行或凭证保险库。不得将凭证或个人收藏正文写入仓库。生产执行与配置变更必须记录真实结果，不以测试桩通过替代线上验收。

