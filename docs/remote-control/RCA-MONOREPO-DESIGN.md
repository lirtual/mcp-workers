# RCA Monorepo consolidation — Grill With Docs

**Status:** Design in progress, simplified direction updated 2026-11-10. Q1–Q4 accepted in earlier rounds; Owner has superseded the earlier Q5/Q6/Q8 recommendations by explicitly rejecting legacy compatibility, pinned tag/commit/repository maps, and incremental cutover. Q7 and device-disruption policy remain to be settled. **This is a design record only.** No code, CI/release workflow, device, production Worker, GitHub repository administration, or published asset is changed or authorized by this document.

## Objective

Manage the RCA Worker and all five native Agent targets inside `lirtual/mcp-workers`, with one source tree and one GitHub Release origin. Installers resolve the **latest published stable Agent Release** from that repository at install/upgrade time. Perform one deliberate cutover; do not build a compatibility layer for old Agent releases or old repository source paths.

## Verified current baseline

- Current Worker source: `apps/remote-control-mcp-worker/` and its existing public installer endpoints on `rca.lirtual.dpdns.org`.
- Current Agent source: separate `lirtual/remote-control-agent/apps/remote-control-agent/`, with Linux x64/ARM64, Windows x64, macOS ARM64/x64 artifacts and native CI.
- Current Worker CI fetches a pinned Agent commit into `apps/remote-control-agent/`; current Linux/Windows/macOS installer, native verifier and release archive internals encode `lirtual/remote-control-agent` and/or `apps/remote-control-agent`.
- The existing Agent `v0.1.51` is a published immutable **prerelease** in the old repository. `mcp-workers` currently has **no latest stable Release**: its `/releases/latest` endpoint returned 404 on 2026-11-10.
- GitHub's `GET /repos/{owner}/{repo}/releases/latest` returns a published **non-prerelease, non-draft** Release, not prereleases. Publishing a draft/prerelease alone cannot satisfy a latest-based installer. The latest release is determined by GitHub, including its latest designation; do not improvise sorting by version strings.

## Accepted decisions

### Q1 — One source-management repository: A

Move Agent source, tests and release workflows into `mcp-workers`. Worker and Agent still run separately, and Agent Release, Worker production publication and real-device upgrades remain distinct kinds of action. No extra Worker, service, updater or deployment environment.

### Q2 — Nested Agent source: B

Use `apps/remote-control-mcp-worker/agent/` for the native Agent, beside Worker `src/` and `tests/`. Explicitly add the nested Agent package to pnpm workspace. Keep only one lockfile. Scope native CI and Worker compatibility checks to affected code, without making unrelated Worker changes rebuild five native targets.

### Q3 — New Agent Release origin: A

New Agent packages publish **only** as GitHub Releases of `lirtual/mcp-workers`. The Worker installer never falls back to `lirtual/remote-control-agent`. The old repository may remain available as historical GitHub evidence, but its source, releases and URLs are outside the supported new installation/upgrade path. Repository archive/deletion is a separate later administrative decision, not part of design documentation.

### Q4 — Source snapshot only: A

Import a reviewed current Agent source snapshot, not the old Git history. A source-revision reference in design/PR evidence is useful for audit, **not a runtime/Release pin**. No source-SHA mapping table, repository compatibility routing, submodule, or sync bot.

### Q5 — No legacy compatibility layer: Owner's new direction

Replace all active old-repository URLs, origin allowlists, test/build paths and package assumptions needed by the new Agent distribution and installer. No requirement to preserve historical Agent binary layouts, old repo installer scripts, upgrade path from old repo packages, or old protocol compatibility solely to enable migration.

**Boundary to settle:** This does not automatically mean delete existing owner credentials, identities or receipts. A source/archive break is different from destroying a paired device's local state. Whether existing devices must be reinstalled/re-paired is an explicit future decision (Q9).

Keep `https://rca.lirtual.dpdns.org/install.sh`, `/install.ps1`, and `/install-macos.sh` as the proposed *new* stable user-facing entrypoints because their URLs do not inherently require a legacy GitHub origin. These endpoints should not implement old-version fallback.

### Q6 — Dynamic latest stable Release; no tag/commit pins: Owner's new direction

At each explicitly initiated installation/upgrade, resolve `GET https://api.github.com/repos/lirtual/mcp-workers/releases/latest` **once**. Require a published stable Release and the expected platform asset (Linux x64/ARM64, Windows x64, macOS ARM64/x64). Use that single response's asset information for the whole operation. Do **not** require a configured version, pinned tag, source commit, Git tag-to-commit match, or standalone origin/version map. Avoid a second `latest` lookup in the same operation that could race a new publication.

**Retain minimal safety checks, not an extra pinning system:** verify the selected artifact's GitHub-reported SHA-256 digest against downloaded bytes, expected architecture/package type and archive boundaries before extracting/executing; reject absent or invalid digest, incomplete asset or unexpected redirect. Serve bootstrap scripts from the reviewed existing RCA Worker entrypoint rather than dynamically executing unchecked old-repository raw source. Release metadata plus matching digest provides transport/artifact integrity, **not independent proof of trusted source provenance**; publishing a malicious latest Release under a compromised account is an accepted residual risk of this simplified design unless later revisited. No `latest` fallback to prerelease or old repo.

This is a dynamic *installation-time* latest selection, **not** an instruction to silently auto-upgrade already paired devices or bypass owner upgrade authorization.

### Q8 — Single cutover, no dual-track compatibility: Owner's new direction

Prepare a single implementation set that imports Agent source, updates workspace/build/CI paths and archive/installer expectations, replaces the old origin logic, and adds independent native Release publication. Validate unpublished five-platform candidates and Worker/Agent integration before release. At a separately authorized execution window, **publish the first stable Agent Release to `mcp-workers` before enabling the latest-based Worker installer**; verify latest resolves all expected assets and digests; then publish the revised Worker and verify installer downloads and real device operation. No long-lived parallel source or distribution systems and no staged old-repo compatibility window.

**Failure behavior:** If the new stable Release is missing or an asset/verification fails, halt the affected cutover before deploying a broken installer; once switched, fail closed rather than quietly downloading old versions. For recovery, fix and publish a new good stable Release (which becomes latest) or restore an already-local validated installation where independently safe. No runtime lookup of a legacy version or destructive rollback of receipt/identity data.

## Pending decisions (next Grill frontier)

### Q7 — Agent Release publishing trigger

- **A (recommended):** Retain ordinary CI on PR/main, and deliberately create release candidates; only an explicitly manually dispatched release workflow publishes a new stable Agent Release. A normal merge to main cannot publish Agent or Worker.
- **B:** Allow merges that change a special release metadata file to automatically publish the next stable Agent Release. Simpler for a release author, but creates a production distribution side effect from a normal merge.

### Q9 — Existing paired device impact

- **A (recommended):** No legacy distribution compatibility, but preserve existing device identity, owner grants, STOP state and receipts where feasible via one-time reviewed local migration/reinstall. If a particular device cannot safely preserve state, report it as an exception rather than silently re-pairing or deleting receipts.
- **B:** Treat existing native installations as disposable; allow one-time uninstall/reinstall and fresh pairing, while explicitly accepting loss of prior identity continuity and possible local receipt history, subject to a later specific authorization for each destructive device action.

### Q10 — Automatic upgrades

- **A (recommended):** `latest` is selected only on a user/Owner-initiated install or authorized upgrade. No unattended latest polling or automatic restart.
- **B:** Automatically upgrade existing paired devices when a new stable Release becomes latest, requiring additional update/rollback controls.

Q7 and Q9 remain materially consequential decisions. Q10 is included to ensure 'use latest' is not silently interpreted as permission for unattended device mutations. Once these are decided, finalize source/package acceptance, first release proof, cutover rollback and relevant ADR.

## Validation expectations for a future implementation

- A non-production checkout builds/types/tests both Worker and nested Agent under one workspace and one lockfile, and validates five unpublished native assets.
- Agent release uses its own explicit publishing authority independent of Worker deployment. Publish a **stable** Release so GitHub latest succeeds, then independently read back the five assets and verify each downloaded SHA-256. Capture Release tag and run in the acceptance record for observability, **not** installer pinning.
- The Worker installer uses only `mcp-workers` latest stable metadata and never fetches `remote-control-agent` legacy GitHub URLs; each OS gets a verified correct artifact. No additional service or permanent release registry.
- Validate one authorized real device upgrade/first install, checking signed WSS, intentional STOP behavior, identity/receipt outcomes consistent with Q9, no blind replay and failure recovery. Distinguish CI pass, Release published, Worker deployed, and physical device pass.
- Current physical devices are **not** affected by this design-only document.

## Design-only constraint

The `docs/rca-monorepo-grill` branch contains only a design record. No implementation commits, CI trigger changes, PR merge, publication, old-repository deletion/archive, production configuration edits or device operations may occur under this round.
