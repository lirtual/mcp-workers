# RCA Monorepo consolidation — Grill With Docs decision record

**Status:** Design in progress (2026-11-10). Q1–Q4 accepted. Q5–Q8 and any dependent acceptance details are open. **Design/documentation only:** no code migration, PR merge, Agent Release, Worker deployment, device upgrade, pairing, runtime configuration, or credential change is authorized.

## Objective and verified baseline

Consolidate RCA Worker and native Agent source under the existing `lirtual/mcp-workers` monorepo, following Browser MCP's source-management precedent without coupling runtimes or deployment authority.

- `mcp-workers/apps/remote-control-mcp-worker` owns the existing Cloudflare Worker, Portal ingress, device coordinator, signed-WSS pairing and public `/install.sh`, `/install.ps1`, `/install-macos.sh` endpoints.
- The public `lirtual/remote-control-agent` repository owns the Agent source, five-platform candidate CI, reviewed release pins and immutable GitHub Releases. The verified historical `v0.1.51` Release has five native assets plus `SHA256SUMS.txt`.
- Current Worker CI and manual Worker release invoke `scripts/stage-public-remote-control-agent.sh`, fetching a pinned Agent repository commit into a temporary `apps/remote-control-agent` package. The Worker compatibility fixture SHA and the public installer Release source SHA have different purposes and must not be conflated.
- Browser MCP keeps the extension source under `apps/browser-mcp-worker/extension` and packages its distribution in the Worker repo. RCA's native binaries and owner-controlled upgrades remain a distinct artifact boundary.
- Existing device IDs, grants, signed-WSS authentication, local receipts, Unknown/no-blind-replay rules, STOP/Resume and rollback controls must stay valid.

## Accepted design decisions

### Q1 — Source-management consolidation: **A**

Put Agent source and related engineering management in `mcp-workers`. Retain independent Agent and Worker execution, verification, versioning, release authorization and device-upgrade authority. No lockstep versions, automatic updates, extra service or orchestrator.

### Q2 — Directory structure: **B**

Nest the **source** of the Agent under the existing Worker context at:

```text
mcp-workers/
  apps/
    remote-control-mcp-worker/
      agent/
        package.json
        src/
        scripts/
        tests/
      src/
      tests/
      wrangler.jsonc
  .github/workflows/
  pnpm-workspace.yaml
```

The `agent/` package remains a separately testable/native-buildable package despite nesting. Prefer an explicit pnpm workspace include for that exact package over a broad recursive glob. Update affected-app selection and the Worker check dependency deliberately; do not accidentally run native five-platform builds for unrelated Worker changes or allow Agent changes to escape compatibility CI.

**Crucial distinction:** source directory layout is NOT the deployed Agent archive layout. The existing builders, Linux Python/bootstrap and JS validators, Windows PowerShell installer, system service/task launchers, installed program paths, and tar/zip entry allowlists refer to `apps/remote-control-agent/` inside release bundles. Unless a separate requirement makes it impossible, keep the legacy **internal archive layout** and local installed runtime paths unchanged by copying from the new source path into the existing archive structure. No on-device migration is an intended outcome of a repo move.

### Q3 — Future GitHub Release ownership: **A**

New Agent Release tags and verified native assets will be published to `lirtual/mcp-workers`, independently from Cloudflare Worker deployment. Old tags and immutable release assets remain at their original `lirtual/remote-control-agent` URLs and must not be modified, copied over, or silently treated as new-repository tags. New repo's Release must pass the existing immutable/tag/commit/asset digest and cross-platform candidate verification contract. All new source commit SHAs are rooted in `mcp-workers`; historical source SHAs continue to identify old-repository history.

### Q4 — Source history migration: **A**

Import only the current reviewed Agent source snapshot with clear source-repository URL and exact old commit provenance; do not graft/rewrite the full Git history. Preserve the former repository and its Issues, tags, released artifacts and evidence links as historical references. Archiving or other repository-administration changes are **not** part of the design-only stage or authorized automatically.

## Verified integration constraints (not new decisions)

1. **Workspace:** The present `pnpm-workspace.yaml` includes `apps/*` and `packages/*`, not `apps/remote-control-mcp-worker/agent`. The new Agent package needs an explicit include and a single reviewed lockfile; avoid the old secondary root workspace.
2. **Native artifact fidelity:** `apps/remote-control-agent/scripts/build-v2-release.mjs`, `scripts/bootstrap-v2.py`, `scripts/verify-v2-release.mjs`, Windows `install.ps1`, and other platform paths encode the established artifact layout. Build from nested source but keep the installation contract stable. Scope the necessary build-path edits and test a real produced archive without changing device state.
3. **Published origin:** Worker `src/install-bootstrap.ts` generates Linux, Windows and macOS installers using `lirtual/remote-control-agent` Release/source URLs. Native verifier and Windows bootstrap also enforce old repo origin. Switching to a new repo requires an explicit reviewed origin/pin contract, not a broad redirect allowance or `latest` lookup.
4. **Provenance:** Old `v0.1.51` immutable tag points at an Agent-repository commit; a new Monorepo source commit has a different SHA. Preserve a one-time old-source/new-source migration map and check every *new* candidate against its *new* repo tag, exact source SHA, native build run and SHA-256 manifests. Never rewrite historical release-pins to claim different source origins.
5. **CI and release:** Current Agent `.github/workflows/publish-agent-release.yml` can publish on main pushes changing `.github/release-pins/*.json`. Worker release is separately manual via `workflow_dispatch`. If the Owner requires no publish from a routine main merge in the destination, the migrated Agent publication trigger must be explicitly manual and separately authorized. CI candidate builds are not publication.
6. **Compatibility:** A passing same-commit Agent/Worker build is not sufficient evidence about already-installed older Agents. Preserve the existing relevant protocol/receipt tests and independently verify real-device identity and signed-WSS behavior after a separately authorized future release.

## Third-round decision frontier (OPEN — owner selection required)

- **Q5 — Historical entrypoints:** A (recommended): keep the current public `rca.lirtual.dpdns.org` installer URLs unchanged; leave all old GitHub tags/assets on the legacy repository; switch only the explicitly reviewed new-release pins and origin after testing. B: new versioned public installer URLs or source URLs with an explicit user-facing migration.
- **Q6 — Release provenance:** A (recommended): store or embed the reviewed Release repository/origin as part of each immutable pin; validate exact repo, tag-to-source SHA, published immutable release, asset identity/digest, platform and installer-source SHA before execution, with no silent legacy/new fallback. B: accept either repository based on opportunistic fallback/lookup.
- **Q7 — Agent publication trigger:** A (recommended): native PR/main CI is read-only/non-publishing, candidate artifact generation is deliberate and does not publish, and a separate manually approved workflow publishes only a reviewed Agent pin. Worker retains its independent manually approved production release. B: retain old automatic publication on pin-file main push.
- **Q8 — Cutover and rollback:** A (recommended): stage the source/CI migration first, then separately review and publish the *first* new-repository Agent Release, then separately authorize the Worker installer-pin cutover; keep the old release and old Worker version as rollback choices; do not change devices as part of the migration. B: switch source, Release and Worker installer pin together as one cutover.

The third-round answers unblock the detailed dry-run matrix, tag collision/rollback behavior, installed older-Agent compatibility tests, follow-on repository disposition and precise go/no-go acceptance plan.

## Design-phase boundaries

All edits during Grill With Docs are limited to draft design documents on `docs/rca-monorepo-grill`. No implementation edits, CI/Workflow trigger changes, Release publication, production rollout, GitHub repository archive/delete, credential or device operations, or merge. An ADR is warranted only when the final irreversible repository/release provenance trade-off is settled; do not create extra glossary terms for file layout.
