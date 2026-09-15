# Final migration acceptance status

Date: 2026-09-15  
Ticket: #23  
Baseline feature commit before this ticket: `9782263119e13ceadb97672726b8d9e4c29a5f3b`

This document is the evidence record for the final migration/retirement gate. It deliberately separates source/CI evidence from live Cloudflare, MCP Portal, and upstream evidence. A missing live check is **not** inferred from source code, and an old repository is not retired while its required gate is incomplete.

## 1. Repository-wide source gate

**Pass** for the feature baseline and the #23 source correction.

GitHub Actions run `34986259551` (unified feature PR #1) checked the combined monorepo state at `9782263119e13ceadb97672726b8d9e4c29a5f3b`:

- `packages/portal-auth` check: pass.
- Application checks covered all six app packages:
  - `database-mcp-worker`
  - `ima-mcp-worker`
  - `instapaper-mcp-worker`
  - `openlist-mcp-worker`
  - `raindrop-mcp-worker`
  - `weread-mcp-worker`
- Each app check included its configured type/tests and Wrangler dry-run contract.
- Database integration: pass against disposable MySQL and PostgreSQL services.

Ticket #23 additionally fixes one source/runtime drift in WeRead: its Portal origin depends on the workers.dev hostname, so `apps/weread-mcp-worker/wrangler.jsonc` now declares `workers_dev: true`. PR #10 GitHub Actions run `34987562834` verifies that correction with the WeRead app gate: typecheck pass, core tests 10/10, MCP tests 5/5, lint pass, and Wrangler dry-run pass. Database integration was correctly skipped because #23 does not change Database or shared runtime dependencies.

## 2. Live acceptance matrix

Status vocabulary:

- **Pass** — directly verified against the current target in this acceptance pass.
- **Source-only** — the monorepo snapshot/check is valid, but there is intentionally no target Worker cutover to validate.
- **Blocked** — a required migration/cutover condition is demonstrably not satisfied.
- **Not verified** — the necessary account/Portal surface is not available in the current execution session; no pass is inferred.

| App | Source/CI | Current public runtime evidence | Portal / real tool acceptance | Final state |
| --- | --- | --- | --- | --- |
| WeRead | Pass, including #23 `workers_dev:true` gate | `https://weread-mcp-worker.aiyaya.workers.dev/health` currently returns Cloudflare 404. The repo previously declared `workers_dev:false`, so source and runtime had drifted. The corrected source has not yet been cut over and re-verified live. | Earlier migration work observed Portal discovery of 10 tools. The known `WEREAD_UPSTREAM_ERROR` is an accepted external/non-migration blocker. Post-fix Portal discovery/tool call is not yet re-run. | **Blocked** until the #23 source fix is deployed from the monorepo and health + Portal are re-verified. |
| IMA | Pass; latest combined CI includes signed-download and URL-classification tests | `/health` returns 200 with `ima-cloudflare-mcp` v0.5.0; unauthenticated `/mcp` returns 401. An unsigned `/download/final-acceptance-probe` returns `404 File not found`. That behavior exactly matches `lirtual/ima-mcp-worker@main/src/index.ts`, which reads R2 directly and returns that 404, while the monorepo signed-download implementation rejects the same unsigned/non-`exports/` request before R2 lookup. The live runtime is therefore confirmed to be running the old download-path behavior rather than the latest monorepo implementation. | Earlier baseline: Portal ready with 16 tools and a read-only `list_notebooks` call succeeded. Post-cutover Portal/tool/log review is not yet re-run. | **Blocked** on production code cutover to the monorepo plus post-cutover Portal/log checks. |
| Raindrop | Pass; latest combined CI includes retry/lifecycle fixes | `/health` returns 200 for `raindrop-mcp` v2.4.5; unauthenticated `/mcp` returns 401 with `{"error":"Unauthorized"}`. That response exactly matches `lirtual/raindrop-mcp@master/src/worker.ts`, which still uses `MCP_ORIGIN_TOKEN` and the old CORS/origin-auth path. The monorepo uses `MCP_ACCESS_TOKEN`, shared Portal auth, no generic Worker CORS, and a different 401 envelope. The live runtime is therefore confirmed to be running the old Worker behavior. | Earlier baseline: Portal ready with 17 tools. `collection_list` returned MCP `-32602` before migration and remains classified as a pre-existing runtime defect, not a migration regression. Post-cutover Portal/tool/log review is not yet re-run. | **Blocked** on production code cutover to the monorepo plus post-cutover Portal/log checks. |
| OpenList | Pass for the source-only Worker snapshot | Current production intentionally remains the existing Tunnel/local OpenList topology. `/health` resolves to the OpenList login UI and `/mcp` returns the OpenList guest-disabled response, confirming this is not the Worker snapshot. | Earlier baseline: Portal exposed the three current OpenList tools and a read-only root listing succeeded. Current-session Portal re-check is not available. | **Source-only / intentionally no Worker cutover.** Do not replace the working Tunnel topology as part of this migration. |
| Instapaper | Pass | No production Worker/Portal instance was established during the migration. No endpoint is invented from the app name. | Not applicable until a production deployment is intentionally created. | **Source-only.** |
| Database | Pass; unit suite includes the delayed-connection regression and real MySQL/PostgreSQL integration passes | No production Worker/Portal instance was established during the migration. No endpoint is invented from the app name. | Not applicable until a production deployment is intentionally created. | **Source-only.** |

## 3. Required live gate before retiring a production publisher

For a Worker that is actually being cut over, retirement requires all of the following on the new monorepo publisher:

1. Cloudflare Build/deploy success for the intended app/root/branch.
2. `/health` matches the expected shallow app contract.
3. Direct MCP connectivity and `tools/list` preserve the intended contract.
4. One explicitly selected safe/read-only tool smoke succeeds where the upstream service is available.
5. MCP Portal discovery is ready and one real Portal call succeeds where the upstream service is available.
6. Missing/incorrect Portal bearer is rejected and the ingress bearer is not forwarded as an upstream credential.
7. Logs are reviewed for routing/auth errors and credential leakage.
8. The previous repository/build source is no longer an active automatic production publisher.

Deployment success alone is not acceptance.

## 4. Retirement status

No old repository is archived by this ticket while a required gate remains incomplete. Keeping the old repositories available is the rollback path, not an indication that dual publishing is acceptable.

| Previous repository / publisher | Current repository state | Retirement decision |
| --- | --- | --- |
| `lirtual/weread-mcp-worker` | private, unarchived | **Keep.** WeRead production is currently 404 and the #23 `workers_dev:true` correction still needs deployment + Portal verification. The repository also has no root `LICENSE` and no `license` field in `package.json`; provenance/license disposition must be resolved before archival. |
| `lirtual/ima-mcp-worker` | private, unarchived | **Keep.** The current live download-path behavior matches this old repository rather than the latest monorepo signed-download implementation. The actual Cloudflare Builds repository wiring still requires account-level confirmation; cutover and final Portal/log checks remain. |
| `lirtual/raindrop-mcp-worker` | private, unarchived | **Keep** until source retirement is reconciled with the actual production publisher and the monorepo runtime has passed the live gate. |
| `lirtual/raindrop-mcp` | public, unarchived; historically observed as the active production Git source | **Keep.** The current live 401 behavior exactly matches this repository's old `MCP_ORIGIN_TOKEN` Worker implementation rather than the monorepo Portal-only code. The actual Cloudflare Builds repository wiring still requires account-level confirmation; disable any old automatic publisher only as part of a controlled cutover. |
| `lirtual/openlist-mcp-worker` | private, unarchived | **Keep for now.** Source migration is valid, but its license/provenance disposition is unresolved: no root `LICENSE` and no `license` field in `package.json`. The current OpenList Tunnel production must remain unchanged. |
| `lirtual/instapaper-mcp-worker` | private, unarchived | **Eligible only after confirming there is no active external build/publisher tied to it.** No production cutover is required because this was source-only. |
| `lirtual/database-mcp-worker` | private, unarchived | **Eligible only after confirming there is no active external build/publisher tied to it.** No production cutover is required because this was source-only. |

## 5. Remaining account-level actions

The Cloudflare account and MCP Portal connectors are not exposed in the current execution surface. Public runtime fingerprints confirm that IMA and Raindrop are still serving old-code behavior, but the following account-level facts remain deliberately **Not verified** rather than guessed:

- current Cloudflare Builds repository/production-branch/root/watch-path configuration for WeRead, IMA and Raindrop;
- whether old source repositories are still configured as active automatic publishers, as distinct from the confirmed old runtime code currently deployed;
- the post-cutover deployed commit/version for WeRead, IMA and Raindrop;
- current Portal discovery/tool-call results after those cutovers;
- Cloudflare runtime logs after cutover.

These are the remaining blockers for declaring the production migrations complete and retiring their rollback repositories.

## 6. Cutover order when Cloudflare/Portal access is available

Keep the changes independent and reversible:

1. **WeRead** — deploy the #23 `workers_dev:true` source from the monorepo; verify `/health`, the 10-tool Portal contract, and a safe read call. The already accepted upstream platform error does not block migration if routing/auth/contract are correct.
2. **IMA** — make the monorepo the single active publisher; verify the signed-download route behavior, `/health`, 16-tool Portal discovery, a safe notebook/list call, auth, and logs.
3. **Raindrop** — preserve Worker identity `raindrop-mcp` and its custom domain; switch the publisher to the monorepo without renaming the Worker; verify the Portal-only auth envelope, `/health`, 17-tool discovery, a safe read call that does not mutate user data, and logs. Preserve the pre-existing `collection_list` `-32602` classification unless separately fixed.
4. **OpenList** — no Worker cutover. Re-verify the existing Tunnel-backed Portal call only, then resolve the old Worker repo's license/provenance disposition.
5. **Instapaper / Database** — confirm no active external publisher is attached to the old source repos. Since no production target was established, do not create one merely to satisfy a migration checklist.

Only after the corresponding row is green should its old source/publisher be retired.
