# RCA Monorepo consolidation — final Grill With Docs design

**Status: Accepted design consensus, 2026-11-10 (Q1=A, Q2=B, Q3=A, Q4=A, Q7=A, Q9=A, Q10=A; Q5/Q6/Q8 superseded by Owner's simplified cutover). Not implemented, merged, released, deployed, or verified on a migrated device.** See [ADR-0024](./adr/0024-rca-monorepo-latest-agent-releases.md).

**Authorization boundary:** This branch is for design/docs only. Neither this acceptance nor creating an ADR authorizes implementation changes, a PR merge, a GitHub Release, a Worker deployment, repository archive/deletion, device upgrade, credentials, access policy or live data changes.

## Outcome

Move the five-platform RCA Agent **source** inside `lirtual/mcp-workers/apps/remote-control-mcp-worker/agent/`, sharing the existing repo and pnpm workspace with its Worker. Retain two different execution and publication units: native Agent packages and the Cloudflare Worker. Use **one** GitHub distribution origin, the **latest stable** `lirtual/mcp-workers` Agent Release, selected only when an owner starts an installation or authorizes an upgrade. No legacy GitHub-repo fallback, source-SHA/tag/version pin tables, cross-repository fixture downloader, submodules, sync bots, auto-updater, new Worker, additional database, or extra deployment environment.

```text
lirtual/mcp-workers/
  apps/
    remote-control-mcp-worker/
      agent/              # native Agent, its own package/scripts/tests
        src/
        scripts/
        tests/
        package.json
      src/                # existing Cloudflare Worker
      tests/
      wrangler.jsonc
    browser-mcp-worker/   # unchanged Browser MCP
    ...                   # other Workers unchanged
  .github/workflows/
    ci.yml                # ordinary CI, no publishing
    release.yml           # existing manual Worker production release
    agent-release.yml     # manual native Agent Release (name illustrative)
  pnpm-workspace.yaml
  pnpm-lock.yaml
```

Stable user-facing URLs remain `https://rca.lirtual.dpdns.org/install.sh`, `/install.ps1` and `/install-macos.sh`. Only their internals switch to the new GitHub origin. Installation, pairing, online state, and completed device upgrade remain separate facts.

## Decisions and accepted trade-offs

| Decision | Result |
| --- | --- |
| Q1 | **A:** One source-management monorepo, independent native/Worker runtimes and release authority |
| Q2 | **B:** Agent is nested under `apps/remote-control-mcp-worker/agent/`, not a peer app |
| Q3 | **A:** New native Releases are published only in `lirtual/mcp-workers` |
| Q4 | **A:** Import current reviewed Agent source snapshot only; preserve historical Git commits in the old repo without grafting |
| Q5 | **Superseded:** No old-repository installer/asset/upgrade compatibility layer; keep existing public Worker installation URLs |
| Q6 | **Superseded:** Dynamically resolve latest stable Release; no configured tag, commit, source SHA or repository pin |
| Q7 | **A:** PR/main CI never publishes; manually authorized Agent Release and independently manually authorized Worker production release |
| Q8 | **Superseded:** One coordinated cutover window after non-production preparation; no long-lived dual-track migration |
| Q9 | **A:** Preserve current device identities, keys, server grants, intentional STOP, receipts/Unknown and no-blind-replay; don't silently re-pair |
| Q10 | **A:** Latest is consulted only for an explicitly initiated install/authorized upgrade; no unattended polling, restart or forced upgrade |

**Deliberate simplification vs historical ADR-0020:** ADR-0020 chose a separate public Agent repository when `mcp-workers` was private and anonymous Release downloads failed. Both repositories are now public; the old rationale no longer applies. ADR-0024 supersedes ADR-0020 **only as the future source/distribution ownership decision**. Its historical facts and acceptance evidence remain historical, not retroactively erased. ADR-0019's standalone prebuilt distribution and ADR-0007/0016/0023's identity/receipt/authorization safety remain intact.

## Native artifact and local-state boundaries

- **Source layout is not an on-device format.** The existing native archive entries, Linux/Windows/macOS bootstraps, user service/task paths, supervisor and package validators include `apps/remote-control-agent/`. Prefer **keeping those internal bundle paths and the installed executable layout unchanged**, while building from the new nested source path. This is a packaging choice to reduce edits and protect Q9; it is **not** a dual-repository compatibility layer. If a specific implementation genuinely requires a layout change, provide one tested owner-local in-place switch preserving state and rollback, not multiple compatibility protocols.
- Import tracked, reviewed source/scripts/tests only. Explicitly exclude `.git`, `node_modules`, build output, personal keys, device databases, receipts, local environment files, tokens and credentials. Existing cloud Durable Object/state bindings and device-generated Ed25519 keys are **not** repository assets to migrate.
- The existing `pnpm-workspace.yaml` matches `apps/*` and `packages/*`. Add only the explicit nested Agent package path; keep one lockfile. Update TypeScript/project paths and affected-app selection. Test Agent changes against Worker compatibility; avoid triggering full five-platform native builds on every unrelated Worker change. Worker deployment must not bundle Node/native binaries.
- Do not relax protected file/Shell/managed-session boundaries, pairing approval, signed WSS, STOP/Resume, idle-grant authorization, receipt schemas, Unknown recovery and no-replay. Source move is not a reason to reset a user identity or alter Owner/grant scope.
- Existing installed versions may remain on disk as **local verified recovery candidates**, but no new installation or upgrade should query or fall back to the legacy GitHub repository. **One-time crossing of the repository boundary is mandatory for existing `v0.1.51` paired devices:** old Windows/Linux/macOS upgrade launchers and installed validators may still demand old Worker pin arguments, tag/commit or macOS `source_commit`. Drive the authorized transition through the **new Worker-served installer/upgrade entrypoint**, adapting its local upgrade handshake only as necessary to preserve existing service ownership, keys, STOP, receipts and rollback; remove remote source-repository pin requirements without removing local operation freeze, version ordering, integrity checks or no-replay. Test this exact old-installed-to-new-Release path without a permanent old-repo compatibility or auto-repair system. If a particular device cannot preserve state safely, **stop that device's migration and report an explicit exception**; do not silently reset identity, delete receipts or count that device as Pass. There is no requirement to make all historical Agent versions installable.

## Release channel and minimal download verification

**One GitHub Release channel in `mcp-workers` is dedicated to Agent.** Browser extension distribution remains in the existing Browser Worker static-assets mechanism; other products must not publish competing **stable** GitHub Releases in this repository without revisiting this decision. The GitHub `/releases/latest` API is repository-wide, not component-scoped, so a separate product's later stable Release could otherwise break Agent installation.

1. The existing trusted Worker installer entrypoint fetches `GET https://api.github.com/repos/lirtual/mcp-workers/releases/latest` **once for one installation attempt** (or its bootstrap can do so without a second racing latest lookup). Require HTTP 200, `draft=false`, `prerelease=false`, `immutable=true`, a recognized Agent Release/manifest, and all five platform artifacts in that **one** Release. A 404, wrong product or incomplete manifest is an error; no automatic prior-version, prerelease, source-repository or `latest` retry fallback.
2. Select exactly the named artifact matching the detected supported platform/architecture from that single Release response. GitHub Release still necessarily has a **tag as an artifact name/version identifier**, but it is not separately pinned or used in a tag-to-commit/source mapping. Reject duplicates, unsupported host/ABI/CPU, missing or unuploaded assets.
3. Require a sane GitHub-provided `sha256:...` asset digest/declared byte size, download only from the official GitHub HTTPS asset endpoint through allowlisted GitHub CDN redirects, and recompute SHA-256 over the complete bytes before installation. Check archive layout, traversal/symlinks/permissions, expected Node/native payload and local owner-only staging; switch only after validation. No anonymous shell from `raw.githubusercontent.com` and no relaxing source validation merely to make latest easier.
4. **Trust trade-off:** SHA-256 fetched from the same GitHub release metadata verifies consistency of delivered bytes, **not independent publisher identity** if the GitHub account or Release itself is compromised. Accept this narrower provenance model to avoid runtime tag/commit pin complexity. Retain manual publishing permissions and reviewed source/CI. Require GitHub Release immutability to be enabled **before** the first new Release (a separately authorized repository-setting change if needed); stage all assets on a draft, then publish once and require `immutable=true` in readback. This is a GitHub-native safeguard, not an additional pin registry.
5. GitHub supports an explicit `make_latest=true` setting on published non-draft, non-prerelease Releases; `legacy` selection instead considers Release chronology/version, including the target commit's `created_at`. **Do not assume publishing a Release proves it is the value of `/releases/latest`**. The manual publisher must explicitly mark the complete reviewed Release as Latest and independently read back `/releases/latest` to verify its identity before installer cutover. A mismatch blocks cutover. No custom tag/commit mapping, version registry or semantic-version scanner. Changing the Latest marker remains possible even for immutable Releases; it is a separately authorized distribution change, never an automatic downgrade of running Agents.

**Stable Release requirement:** The previous public Agent `v0.1.51` is an immutable **prerelease**, and `mcp-workers` currently returns 404 for `/releases/latest` (verified 2026-11-10). The first new-repository Release must be non-draft and **non-prerelease**, complete for all five targets, and independently verified **before** the revised Worker installer goes live. Merely uploading an artifact, creating a draft or passing CI does not satisfy this gate.

## CI and publishing (smallest existing-tool adaptation)

- Preserve existing `mcp-workers` PR/main CI as checks only. Fix path selection so native changes run relevant native and Worker integration checks. Five-platform native candidate jobs run on native supported runners with Node 24, native helper verification, package-archive smoke and declared host/ABI gates, without GitHub Release publication.
- Add a **manual-only** Agent publishing entrypoint using existing GitHub Actions and Release assets. Remove the old Agent job's `push`/`.github/release-pins/*.json` publishing trigger rather than copying it. Publish only after reviewed CI/candidate checks on the intended current code and an explicit owner-approved publication. Use GitHub's intrinsic release tag and build-run evidence, but **no long-lived pin-file mapping or installer source-SHA lookup**.
- During publishing, check no conflicting tag/Release and verify **all five candidates belong to the same reviewed source revision and successful native CI run** (using the existing candidate/CI evidence, not an installer-side source pin); verify platform manifests and hashes. Publish the complete immutable/stable Release from its complete draft, mark it Latest, then require `immutable=true` and download/re-hash/read back **all five** official assets and the actual `latest` response. A Release/latest mismatch or partial publication blocks Worker installer cutover; never overwrite an immutable Release blindly.
- The current Worker `release.yml` continues **manual** `workflow_dispatch` with protected production approval. Do not couple it to Agent publication or `main`. Ordinary Git merges, CI completion, Agent candidate generation and GitHub Release publication must **not** automatically deploy Worker or upgrade a device.

## One coordinated cutover — stages are sequencing, not dual-track compatibility

**Before any production authorization:** One implementation PR can complete the source import, pnpm/TypeScript/build paths, native CI, new manual publishing workflow, Worker installer latest logic, current-origin removal, unit/integration tests, docs and necessary test corrections. The former `stage-public-remote-control-agent.sh` cross-repository fixture should be retired after local checkout tests pass. Run end-to-end on unpublished artifacts and offline fake GitHub latest/asset responses (404, other product, missing/duplicate asset, changed latest mid-process, bad digest, invalid archive, wrong platform, **API 403/429 rate limit**, failed stage/rollback), plus the `v0.1.51` old-installed-to-new-Release transition. API calls should be limited to the one needed Latest lookup per explicit operation; on 403/429 show a clear limit/error and stop without unbounded retries or device mutation. Do not add KV/cache/cron/token distribution just for a small fleet; GitHub's unauthenticated REST limit is generally 60 requests per originating IP per hour, with other/secondary limits also possible. All non-production checks must pass first.

**At a separately explicitly authorized real cutover:**

1. Freeze the exact implementation and confirm unchanged app/grant/DO/Portal permission contracts, all necessary CI and native candidate builds green, no unreviewed source or Release drift, and a compatible device state migration/rollback plan. Avoid introducing production data or credential changes.
2. Manually publish **one** complete new stable GitHub Agent Release to `mcp-workers`. Independently read back the actual `latest` identity, five native artifacts, sizes, SHA-256 and reviewed release completion. **Stop if any fail.**
3. Separately authorize the existing Worker manual production release to switch installation entrypoints to the **single new** GitHub origin/latest logic; check actual HTTP endpoint behavior and Worker version/readback. No automatic device upgrade occurs.
4. On a separately authorized owner-controlled **already installed `v0.1.51` device**, verify the real cross-repository **upgrade** path (a fresh install alone is insufficient), including signed-WSS reconnect. Read back the **same** device ID/key fingerprint, grant, intentional STOP (never start an owner-stopped service), receipt/Unknown continuity and owned-process semantics. For other available real target platforms repeat proportionately; never label CI emulation as physical verification.
5. Only after observed Pass close migration delivery. Keep the old repo as historical evidence; optional archive/retirement requires its own scope and authorization, not a hidden cutover side effect.

**Rollback and failure rules:** Before Worker publication, stop with current production unchanged if the first stable Release/latest gate fails. After Worker publication, a bad `latest` or invalid asset **fails closed** rather than silently installing from the old repo or an older version. For a **separately authorized** correction, either explicitly mark a **previously verified stable Agent Release in `mcp-workers`** as Latest and re-read/verify the complete five-asset result, or publish a corrected new stable Release and mark/verify it Latest; adjust the Worker only if necessary. This only changes **future installations/upgrade selections** and never automatically downgrades an already installed device. If no safe current-repository candidate exists, remain blocked. On-device upgrade failures restore a **locally verified** previous program where safe while keeping the same owner identity, STOP and receipt state. Do not destructively revert external file/Shell effects, replay Unknown, overwrite immutable assets or authorize an unreviewed production revert.

## Acceptance matrix and stop conditions

| Area | Required evidence | Stop/exception |
| --- | --- | --- |
| Monorepo source | Exactly one tracked Agent source, explicit nested workspace, one lockfile; original import reviewed for secrets | Duplicate source, credential/device-data import, broken builds |
| Non-prod CI | Agent/Worker typecheck/tests, native candidates for Linux x64/ARM64, Windows x64, macOS ARM64/x64; built artifacts validated on relevant native runners | Missing target, failing security/ABI/archive test |
| Publishing isolation | PR/main cannot publish Agent or Worker; manually approved Agent workflow independent from manual Worker workflow | Implicit `push` publish, deployment or automatic Agent upgrade |
| Distribution | `mcp-workers` public stable `latest` explicitly points to a reviewed Agent Release with five correct downloadable assets; SHA-256 and host/archive validation pass; 403/429 fails closed; no old repo fallback | 404/403/429, unrelated or mutable Release, prerelease, missing/bad asset, unsafe redirect |
| Worker release | Explicit prod authorization, correct existing Portal/DO/grants, correct installer HTTP routes, independent production readback | Unreviewed side effects or runtime drift |
| Existing owner devices | Actual installed `v0.1.51` to new-repo Release upgrade, per-device ID/key/STOP/grant and receipt metadata + representative Unknown record continuity, signed WSS, no duplicated effects; owned sessions checked | Fresh-install-only evidence, key/ID change, STOP violation, receipts erased or Unknown replay |
| Recovery | Inject pre-switch invalid package and post-stage failure; old **local** program still starts safely or fails closed; no automatic pairing | Unrecoverable lost identity or unintended service start |
| Physical scope | Real Windows x64, Linux/WSL2 x64, and macOS ARM64 when accessible; Linux ARM64/macOS x64 native CI is not a substitute for physical tests | Explicitly mark missing hardware cases Not performed/Waived, never Pass |

**Go/no-go:** The first real production step is blocked until the manual stable Agent Release can be proven selectable as latest. The Worker cutover is blocked until all five assets and the installer have verified matching behavior. A failed device state-continuity check stops **that device's** rollout without erasing state or retrying an indeterminate operation. No new persistent registry, long observation window, mirrored repo or extra CI gate is introduced solely for this consolidation.

## Completion status

**Design consensus closed, implementation not started.** All Q1–Q10 decisions are captured; Q5/Q6/Q8 have explicit superseding choices. Future work is implementation planning and separate live authorizations, not another architecture-choice round. This document and ADR must not be misread as the active deployed contract: current deployed state remains in `docs/remote-control/CONTEXT.md` until independently released/verified.
