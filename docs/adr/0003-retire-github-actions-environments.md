# ADR-0003: 退役 GitHub Actions Environments，统一仓库级配置

Spec: [#849](https://github.com/lirtual/mcp-workers/issues/849) — ready-for-agent，Issue 发布不代表实施或生产授权。

Status: Accepted **design decision** (2026-11-10); code implementation requested by Owner; GitHub Settings migration, deletion and production remain independently gated.

Owner 决定将 `lirtual/mcp-workers` 余下 2 个 GitHub Actions Environment Variables、6 个 Environment Secrets 在**原值不变**的前提下迁至 Repository 级，移除工作流中的 Environment 依赖并最终删除全部 10 个 Environments。此处仅改变 GitHub Actions 配置来源，不改变 Cloudflare Worker 运行时绑定、业务数据或生产发布；不新建密钥代理、兼容层、审批系统或分支 Ruleset。

明确接受三项非等价安全取舍：Repository Secrets 在仓库内的可用范围扩大；`remote-control-agent-release` 原人工审批/部署分支规则及 Raindrop Environment 规则被移除；`main` 继续无 Branch Protection/Ruleset。现有手动触发、Owner/main、候选版本及发布前校验保留，但不声称它们等同于平台级审批或可防止有写权限的身份修改工作流。现有单一直接管理员与低维护目标是此次取舍的依据；未来增加写入主体或变更触发链时重新审视风险。

所有 GitHub Secrets 原字节保持一致是删除旧来源的先决条件。GitHub API 无法读回 Secret 原值，同名 Environment Secret 会覆盖 Repository Secret；因此必须先按平台允许的受控路径迁移并独立验证，失败或结果 Unknown 时保留旧来源、停止对应清理。生产配置切换前还须最小修正 Release 暂存步骤四项非目标 Worker 无条件 Secret 注入，并按可执行触发路径批量核对历史分支，避免旧引用自动重建 Environment；二者均复用既有工作流/测试，不新增长期控制。删除 Environments 和改变生产相关 GitHub Settings 另行授权。详见 [最终设计](../github-actions-config-scope-migration-design.md)。
