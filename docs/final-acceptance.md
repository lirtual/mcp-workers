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

Ticket #23 additionally fixes one source/runtime drift in WeRead: its Portal origin depends on the workers.dev hostname, so `apps/weread-mcp-worker/wrangler.jsonc` now declares `workers_dev: true`. PR #10 GitHub Actions run `34987562834` verifies that correction with the WeRead app gate: typecheck pass, core tests 10/10, MCP tests 5/5, lint pass, and Wrangler dry-run pass. Database integration was correctly skipped because #23 does not change Database or shared runtime dependencies. The subsequent documentation-only head also passed CI in run `34987951612`.

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

## 4. GitHub-side publisher evidence

GitHub check-runs provide useful evidence about Cloudflare's Git integration. They do not replace account-level confirmation of current production-branch/root/watch-path settings, but they establish which repository heads have actually triggered Workers Builds.

- **WeRead old repository:** `lirtual/weread-mcp-worker@8ab71db46b0298f3776a03fe48ffd49000477db4` successfully triggered `Workers Builds: weread-mcp-worker` (Build `a6babc6e-1970-4d6e-bf75-3df6040b87c1`, Version `52b1db40-e28c-47ff-8761-a6033f1411c1`).
- **WeRead monorepo:** `lirtual/mcp-workers@6213d7c0cff3e7cff98ac873b777128ff478be95` later successfully triggered the same Worker (Build `833f9da9-d7dc-4da6-8199-f7e5ad48cd49`, Version `f135dbb1-f8bb-493d-b410-bedabc5da462`). This is direct historical evidence that both repositories have been connected to the same Worker at different points, so old-publisher shutdown must be confirmed explicitly.
- **IMA old repository:** current head `lirtual/ima-mcp-worker@9202e9e05dfc8b6ecc9511aaa7eb95f7fd2b0172` successfully triggered `Workers Builds: ima-mcp-worker` on 2026-09-15 (Build `be86478a-7cb9-4696-b257-70ff2cd3474b`, Version `d5a37820-27e1-4a8b-9a25-5be2b8e53bdf`). There is no newer commit in that repository.
- **Raindrop actual old production repository:** current head `lirtual/raindrop-mcp@fec792b4a9eeed9024fbf590bc85c56eb8528c99` successfully triggered `Workers Builds: raindrop-mcp` on 2026-09-15 (Build `66b9da2b-7192-48b7-9f24-ac5098e5614e`, Version `f356d44a-607f-4416-8f7e-12880f15343d`). There is no newer commit in that repository.
- **OpenList / Instapaper / Database / `raindrop-mcp-worker`:** their latest repository heads show GitHub Actions checks only and no Cloudflare Workers Builds check. This is evidence that those heads did not produce a GitHub-integrated Worker build; it is **not** proof that no manual or external publisher exists.
- The latest monorepo feature commit `9782263119e13ceadb97672726b8d9e4c29a5f3b` has GitHub Actions checks but no visible Cloudflare Workers Builds check. Do not infer a successful IMA/Raindrop production cutover from source merges alone.

## 5. Retirement status

No old repository is archived by this ticket while a required gate remains incomplete. Keeping the old repositories available is the rollback path, not an indication that dual publishing is acceptable.

| Previous repository / publisher | Current repository state | Retirement decision |
| --- | --- | --- |
| `lirtual/weread-mcp-worker` | private, unarchived | **Keep.** WeRead production is currently 404 and the #23 `workers_dev:true` correction still needs deployment + Portal verification. Both old-repo and monorepo Workers Builds have historically targeted this Worker, so confirm a single active publisher before retirement. The repository also has no root `LICENSE` and no `license` field in `package.json`; provenance/license disposition must be resolved before archival. |
| `lirtual/ima-mcp-worker` | private, unarchived | **Keep.** The current live download-path behavior matches this old repository rather than the latest monorepo signed-download implementation, and the current old-repo head has a same-day successful production Workers Build. Cutover and final Portal/log checks remain. |
| `lirtual/raindrop-mcp-worker` | private, unarchived | **Keep for now.** Its latest head has no Cloudflare Workers Builds check, but that alone cannot exclude an external/manual publisher. The actual production repository is `lirtual/raindrop-mcp`. |
| `lirtual/raindrop-mcp` | public, unarchived; confirmed recent production Git source | **Keep.** The current live 401 behavior exactly matches this repository's old `MCP_ORIGIN_TOKEN` Worker implementation, and its current head has a same-day successful `Workers Builds: raindrop-mcp` production build. Disable the old automatic publisher only as part of a controlled cutover. |
| `lirtual/openlist-mcp-worker` | private, unarchived | **Keep for now.** Its latest head has no Cloudflare Workers Builds check and current production is the independent Tunnel/local topology. Source migration is valid, but license/provenance remains unresolved: no root `LICENSE` and no `license` field in `package.json`. |
| `lirtual/instapaper-mcp-worker` | private, unarchived | **Eligible only after confirming there is no manual/external publisher tied to it.** Its latest head has no Cloudflare Workers Builds check and no production target was established. |
| `lirtual/database-mcp-worker` | private, unarchived | **Eligible only after confirming there is no manual/external publisher tied to it.** Its latest head has no Cloudflare Workers Builds check and no production target was established. |

## 6. Remaining account-level actions

The Cloudflare account and MCP Portal connectors are not exposed in the current execution surface. Public runtime fingerprints and GitHub check-runs confirm old-code/runtime and recent old-repository Build evidence for IMA and Raindrop, but the following account-level facts still require direct verification:

- current Cloudflare Builds production-branch/root/watch-path settings for WeRead, IMA and Raindrop;
- whether each old source repository is still enabled as an automatic publisher **now**, rather than merely having produced a recent successful build;
- the post-cutover deployed commit/version for WeRead, IMA and Raindrop;
- current Portal discovery/tool-call results after those cutovers;
- Cloudflare runtime logs after cutover;
- whether Instapaper, Database or `raindrop-mcp-worker` has any manual/external publisher that would not appear as a GitHub Workers Builds check.

These are the remaining blockers for declaring the production migrations complete and retiring their rollback repositories.

## 7. Cutover order when Cloudflare/Portal access is available

Keep the changes independent and reversible:

1. **WeRead** — deploy the #23 `workers_dev:true` source from the monorepo; verify `/health`, the 10-tool Portal contract, and a safe read call. The already accepted upstream platform error does not block migration if routing/auth/contract are correct. Confirm the old repository can no longer publish automatically to the same Worker.
2. **IMA** — make the monorepo the single active publisher; verify the signed-download route behavior, `/health`, 16-tool Portal discovery, a safe notebook/list call, auth, and logs. Confirm the recent old-repo Workers Build source is disabled before retirement.
3. **Raindrop** — preserve Worker identity `raindrop-mcp` and its custom domain; switch the publisher to the monorepo without renaming the Worker; verify the Portal-only auth envelope, `/health`, 17-tool discovery, a safe read call that does not mutate user data, and logs. Preserve the pre-existing `collection_list` `-32602` classification unless separately fixed. Confirm `lirtual/raindrop-mcp` can no longer auto-publish to production before retirement.
4. **OpenList** — no Worker cutover. Re-verify the existing Tunnel-backed Portal call only, then resolve the old Worker repo's license/provenance disposition.
5. **Instapaper / Database** — confirm no manual/external publisher is attached to the old source repos. Since no production target was established, do not create one merely to satisfy a migration checklist.

Only after the corresponding row is green should its old source/publisher be retired.
