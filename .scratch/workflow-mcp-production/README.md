# Workflow MCP 首版运营收尾工单

状态：已编写待粒度审阅；尚未创建 GitHub Issues。此目录随用户要求推送保存；不表示实现或部署完成。

基线：main@a1dfd07 与本轮已确认规格。只拆剩余工作，不重建已有 DAG、OIDC、D1/R2 或七个 MCP 工具。已检查开放 GitHub workflow 工单，未发现匹配项；不修改或关闭任何父工单。

| 工单 | 交付 | Blocked by |
| --- | --- | --- |
| [T01](issues/01-stable-credentials.md) | 稳定运行凭证，使部署结束后仍能执行 GitHub 重任务 | None |
| [T02](issues/02-config-expand.md) | 建立集中配置入口，兼容旧变量并迁移固定参数 | None |
| [T03](issues/03-raindrop-manual.md) | 接入 Raindrop，并打通手动读取与结果查询 | T01, T02 |
| [T04](issues/04-scheduler-maintenance.md) | 恢复系统 Cron 和维护循环，停用示例周期执行 | T02 |
| [T05](issues/05-config-contract.md) | 迁移发布 tracer 并清理正式环境测试配置 | T01, T02, T03, T04 |
| [T06](issues/06-failure-recovery.md) | 补齐取消与异常恢复的可重复验收 | T01, T04 |
| [T07](issues/07-production-acceptance.md) | 启用 Raindrop 日程并完成部署后的独立线上验收 | T05, T06 |

推荐顺序：T01/T02 → T03/T04 → T05/T06 → T07。依赖以各工单 Blocked by 为准。T02 为配置扩展与兼容，T03/T04 完成迁移，T05 删除旧形式；不引入无关的全局预重构。

T01、T02 在批准发布后使用 ready-for-agent 标签；其他工单阻塞解除后再标记。T07 的真实每日定时证据可能需等到下一次 09:00（Asia/Shanghai），不可提前宣称完成。

发布到 GitHub 前按 to-tickets 技能确认粒度/依赖，再按拓扑顺序创建，替换 T 编号为真实 issue 链接。当前文件无需 GitHub issue 即可被独立审阅。

