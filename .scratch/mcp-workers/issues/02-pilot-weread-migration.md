# 02 — 创建 mcp-workers 骨架并迁移 WeRead 作为 tracer-bullet

**Status:** `runtime-acceptance-in-progress`  
**Blocked by:** Cloudflare Build + MCP Portal runtime acceptance  
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

- 不切 pnpm workspace/单 lockfile。
- 不升级 SDK/TS/Wrangler/compatibility_date。
- 不改入口 token 或 Portal-only 语义。
- 不顺手提取 portal-auth 或全仓格式化。

## Acceptance criteria

- [x] 源码可追溯到 #01 commit：`8ab71db46b0298f3776a03fe48ffd49000477db4`。
- [x] tools/schema 无非预期变化：26 个源文件 blob SHA 与冻结源快照一致；`src/server.ts` 未变。
- [x] 本地验证状态明确：核心测试 10/10；origin-auth standalone typecheck 通过；完整依赖检查因 registry DNS `EAI_AGAIN` 标记 Not run。
- [ ] Cloudflare Build 成功。
- [ ] 不存在双发布源。
- [ ] Portal 能发现并调用指定只读工具。
- [x] 回退步骤可执行且不含 secret，见 `docs/migrations/weread.md`。

## Verification

- [x] 静态 tools/schema baseline diff：Pass（注册源 blob 相同）。
- [ ] live `tools/list` baseline diff：Not run，等待目标 Worker/Portal。
- [x] dependency-free core test：10/10 Pass。
- [x] `origin-auth.ts` strict standalone typecheck：Pass。
- [ ] `npm run check` / `npm run test:mcp` / Wrangler dry-run：Not run；`npm install` 因 `registry.npmjs.org` DNS `EAI_AGAIN` 阻塞。
- [ ] Cloudflare Build/部署记录。
- [ ] Portal 只读 smoke。

## Runtime acceptance trigger

Cloudflare Builds 已由用户修正为现有 Worker `weread-mcp-worker`，仓库 `lirtual/mcp-workers`，production branch `ticket/02-pilot-weread-migration`，Root Directory `apps/weread-mcp-worker`。本提交仅更新迁移记录，用于触发一次新的 Cloudflare build；`apps/weread-mcp-worker` 源码与配置未修改。

## Source

spec §8 Phase A/B, §10 AC07/AC08/AC13

## Current blocker

源码迁移部分已提交在 `ticket/02-pilot-weread-migration`。等待本次 Cloudflare build、单一发布源确认、Portal discovery 与安全只读调用完成后才能合入统一 feature 分支；此前 #03–#07 继续 blocked。
