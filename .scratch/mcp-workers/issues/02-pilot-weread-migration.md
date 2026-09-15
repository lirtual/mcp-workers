# 02 — 创建 mcp-workers 骨架并迁移 WeRead 作为 tracer-bullet

**Status:** `ready-for-agent`  
**Blocked by:** #01（complete）  
**Scope:** `mcp-workers`（明确排除 Quark MCP）

## Goal

验证稳定快照 → apps/ → 单一发布源 → Portal 实际调用的完整迁移路径。

## In scope

- 确认/创建最小目标仓库骨架。
- 按 #01 固定 WeRead commit 迁入 apps/weread-mcp-worker，并记录来源/许可证。
- 保持原依赖解析、Worker 名、资源、运行地址、鉴权和工具契约。
- 运行现有本地检查。
- 切换 WeRead Cloudflare Builds；确保旧自动发布源失效。
- 验证真实 Worker、Portal discovery 和一个明确只读工具调用。
- 记录回退步骤。

## Out of scope

- 不切 pnpm workspace/单锁文件。
- 不升级 SDK/TS/Wrangler/compatibility_date。
- 不改入口 token 或 Portal-only 语义。
- 不顺手提取 portal-auth 或全仓格式化。

## Acceptance criteria

- [ ] 源码可追溯到 #01 commit。
- [ ] tools/schema 无非预期变化。
- [ ] 本地验证状态明确。
- [ ] Cloudflare Build 成功。
- [ ] 不存在双发布源。
- [ ] Portal 能发现并调用指定只读工具。
- [ ] 回退步骤可执行且不含 secret。

## Verification

- [ ] tools/list baseline diff。
- [ ] 现有 test/typecheck/build/dry-run。
- [ ] Cloudflare Build/部署记录。
- [ ] Portal 只读 smoke。

## Source

spec §8 Phase A/B, §10 AC07/AC08/AC13
