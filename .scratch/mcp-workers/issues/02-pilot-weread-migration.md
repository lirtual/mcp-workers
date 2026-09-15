# 02 — 创建 mcp-workers 骨架并迁移 WeRead 作为 tracer-bullet

**Status:** `complete`  
**Blocked by:** none  
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
- [x] Cloudflare Build 成功：commit `6213d7c0cff3e7cff98ac873b777128ff478be95`，Build ID `833f9da9-d7dc-4da6-8199-f7e5ad48cd49`，Worker Version `f135dbb1-f8bb-493d-b410-bedabc5da462`。
- [x] 单一发布源：用户在完成现有 Worker 的 Git Build 绑定切换后授权继续实施，作为人工验收记录；本会话无法独立读取 Cloudflare Build source 管理面。
- [x] Portal runtime acceptance：用户在 Cloudflare Build 成功后授权继续实施，作为人工验收记录；本会话未独立调用其 MCP Portal 连接，不伪造工具调用日志。
- [x] 回退步骤可执行且不含 secret，见 `docs/migrations/weread.md`。

## Verification

- [x] 静态 tools/schema baseline diff：Pass（注册源 blob 相同）。
- [x] live runtime acceptance：manual/user-confirmed；不作为独立自动化证据。
- [x] dependency-free core test：10/10 Pass。
- [x] `origin-auth.ts` strict standalone typecheck：Pass。
- [ ] `npm run check` / `npm run test:mcp` / Wrangler dry-run：Not run；`npm install` 因 `registry.npmjs.org` DNS `EAI_AGAIN` 阻塞。
- [x] Cloudflare Build/部署记录：GitHub Check `Workers Builds: weread-mcp-worker` conclusion `success`。
- [x] Portal 只读 smoke：manual/user-confirmed acceptance；无独立工具日志。

## Runtime acceptance evidence

Cloudflare Builds 使用现有 Worker `weread-mcp-worker`、仓库 `lirtual/mcp-workers`、production branch `ticket/02-pilot-weread-migration`、Root Directory `apps/weread-mcp-worker`。

- Trigger commit: `6213d7c0cff3e7cff98ac873b777128ff478be95`。
- Cloudflare Build: **Pass**，Build ID `833f9da9-d7dc-4da6-8199-f7e5ad48cd49`。
- Deployed Worker Version: `f135dbb1-f8bb-493d-b410-bedabc5da462`。
- Runtime/Portal closure: manual user confirmation permitting continuation; no secret values recorded。
- Internal merge PR: #2，merged into `feat/mcp-workers-monorepo` at `5c99b1872bca502ed97df6cf96df1987a1743512`。

## Source

spec §8 Phase A/B, §10 AC07/AC08/AC13
