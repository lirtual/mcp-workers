# Browser MCP public download page — agreed design (2026-10-31)

Status: **Design consensus (Q1–Q6=A); implementation tracked in Spec #609. Production publication remains separately authorized and unverified.** Existing production installation instructions in [INSTALL.md](INSTALL.md) remain authoritative until independently verified publication.

## Problem and agreed scope

The released Chrome/Edge MV3 extension is obtained through an expiring GitHub Actions artifact and nested ZIP extraction. Make initial installation and future manual updates as discoverable as the existing RCA public installer without changing Browser MCP control or identity semantics.

- Q1=A: public anonymous download, **not** public browser control.
- Q2=A: one minimal, English, responsive page with Vercel-like visual restraint and automatic light/dark theme. Show Download, Chrome/Edge installation steps, version, SHA-256, and existing documentation. No dashboard or account features.
- Q3=A: manual updates; no extension-store listing, auto-update service or background updater.
- Q4=A: package the reviewed Chrome/Edge ZIP into the **existing Browser Worker Static Assets** during the **existing, separately authorized GitHub Actions manual release**. Do not serve directly from ephemeral Actions artifacts or add Releases/R2/KV/Pages.
- Q5=A: a stable entry point must resolve to the current **compatible** published, versioned ZIP. Displayed version/hash, downloadable bytes and Worker protocol/source must be checked together.
- Q6=A: preserve extension identity by updating files in the same stable unpacked directory and reloading in the same browser Profile; check actual Endpoint continuity instead of assuming it.

## Routes, trust, and minimum UI

| Public route | Behavior |
| --- | --- |
| GET / | Minimal install landing page (no login); display *published* version and verified SHA-256, not a source-tree guess. |
| GET /download | Stable download entry, redirects with a **non-cacheable** response to the current immutable versioned ZIP path. |
| GET /downloads/browser-mcp-extension-v<VERSION>-<SHA256>.zip | Immutable reviewed ZIP; include the complete content SHA-256 in its asset name, correct ZIP type and download filename. Every different ZIP byte sequence receives a different URL even when the manifest version is unchanged. |

Allow HEAD where appropriate; reject unsupported methods. The only public resources are an explicit allowlist of landing-page files and the selected reviewed ZIP. Keep the page static and self-contained where practical (no runtime JavaScript framework, external fonts or third-party analytics); render a short install sequence: download, extract to a **stable** directory, open chrome://extensions or edge://extensions, enable Developer Mode, Load unpacked, pin icon, click to start Access verification. State clearly that a ZIP download **does not install or activate** an extension. A browser-installed extension requires Chromium 137+.

**Authorization and routing:** Existing /mcp, /extension/*, /activate/*, /owner/* and WebSocket semantics are unchanged. Configure Static Assets with a runtime binding and **Worker-first routing** so an asset file/path collision never bypasses existing authentication and restricted-origin processing. In the Worker, explicitly handle the public paths only and delegate eligible files through the asset binding. Do **not** enable SPA fallback, wildcard asset exposure, redirects onto Owner endpoints, or a second public host. Unknown paths remain Not found. Never make Access verification, Owner-review pages, Profile credentials, JWTs, signing materials, logs or server configuration into public static files. Publicly shipping the manifest **public** key and fixed service origin is intentional, but neither authenticates control nor attests extension code.

**Caching:** Revalidate the landing page and prevent caching /download (e.g., no-store); make uniquely named reviewed ZIP assets safely cacheable as immutable. The stable entry must never remain pinned to an obsolete version by a browser/CDN cache. If the current published ZIP is unavailable, fail visibly rather than silently linking an old version or an expiring GitHub Artifact.

## Provenance and compatible release

Use the already-reviewed deterministic build script `scripts/build-browser-extension.py` and its ZIP, SHA-256 and source manifest checks. Enhance the *existing* release job to stage **only explicitly allowlisted public files** (the landing page and reviewed current ZIP) into the asset directory before the existing Wrangler deploy. Derive visible version and SHA-256 from verified build metadata at publication time; keep the full provenance and metadata sidecars as private CI artifacts, **not publicly served assets**. Do not store generated packages in source control. Release checks must bind together:

1. Production Worker package version, WSS protocol, extension manifest version, pinned manifest-key-derived extension ID, and production service origin.
2. Artifact provenance: reviewed source revision, deterministic ZIP SHA-256, CI-only metadata and actual staged/uploaded bytes. No dirty/unreviewed build. Since the packaged ZIP includes the extension's copy of `INSTALL.md`, a documentation-only change can alter ZIP bytes **without** changing its manifest version; the content-hash URL prevents overwriting a previously published ZIP.
3. The single version/full content hash on the page and /download target, the staged file, and the Worker release candidate. Derive the ZIP filename from build outputs rather than a hard-coded `v0.2.1` path in the current manual-release workflow. Verify versioned filename, exact bytes, pinned key/extension ID, service origin and WSS compatibility; reject missing, unexpected, wrong-hash or extra public files **before deployment**. Runtime or handshake protocol changes must carry a compatible extension/Worker version update; a documentation-only change may retain the manifest version but receives a new content-hash URL.
4. Files within Cloudflare Static Assets limits (25 MiB each as currently documented); the current package is much smaller. Do not add a new cache/database/release registry.

Retain any existing artifact/audit upload as evidence but never make that expiring attachment the public distribution source. GitHub Actions remains the **only** authorized production publisher. Worker + static assets ship as one Cloudflare Worker version; a failed preflight leaves the prior production version intact. Source changes alone do not update public downloads.

A Worker rollback can restore its bundled page and ZIP but **does not uninstall, downgrade or reconnect existing browser Profiles**. A rollback to an incompatible WSS/extension revision requires its own compatibility/safety decision; fail closed, never restore deprecated pairing, resume or per-operation approval paths. Old content-hash URLs may persist in third-party caches or bookmarks; they do **not** define the active release. The uncached **/download** and freshly revalidated landing page must resolve to the exact ZIP packaged with the *currently active* Worker version, including after an authorized rollback (which may intentionally select an older compatible version). Do not automatically select the numerically highest version or redirect to an incompatible cached package.

## Local update and recovery

Use the supported existing unpacked installation in the same Profile/directory; stop local control first, note the Endpoint ID and any Unknown receipts (never secrets), verify the newly downloaded SHA-256, replace the **contents** of the existing unpacked directory and Reload the installed extension. Keep the pinned public manifest key, resulting extension ID (`jhifaghneomgcfollcdbncjkcloedfem`), production origin and Profile identity. Verify the extension version and the Endpoint ID again; if identity or readiness changes unexpectedly, stop and investigate rather than silently re-pairing or reverting to a legacy protocol. A permanent grant is **intended** to persist but must be read back; temporary grants are invalidated by reload/update and require fresh local activation. Local ON remains an Owner gesture backed by Access SSO or OTP when demanded; downloading grants no permission.

## Required validation — risk-scoped, no duplicate suites

- **Preflight (offline/CI):** deterministic ZIP and metadata check, version/protocol/key/source correspondence, derived filename (remove current hard-coded version from release workflow), public-asset allowlist and absence of CI-only metadata, correct headers/cache behavior, blocked deployment on mismatch/missing bytes; reuse existing build/test gates.
- **Local Worker tests:** anonymous landing and download permitted; existing protected dynamic routes cannot be shadowed or accessed anonymously; unknown paths 404; unsupported methods rejected; no SPA fallback.
- **Native Chrome and Edge checks (matching produced ZIP):** one installation and safe same-directory update, confirm fixed extension ID and actual Endpoint continuity or explicit failure handling, permanent/temporary pairing behavior affected by reload. Do not rerun unrelated #418 tests without a newly identified risk.
- **After separately authorized production publication:** independently read live /, /download and versioned ZIP, compare downloaded SHA-256 and version with the released worker, and check read-only authorization boundaries. Confirm the published release version and relevant native browser readback separately; CI success or a deployed page is not proof of actual update success.

## Out of scope and future operator work

No additional Worker, Pages, R2, KV, D1, npm service, extension store, installation executable, automatic updater, second CI, release registry, owner portal, new access flows, or broad full-browser regression. No changes to MCP APIs, activation, WSS, control, Unknown receipts, credentials, or current paired Profiles.

**Original design-only PR #606 did not modify `INSTALL.md`; the separately scoped Spec #609 implementation now updates it.** The earlier design PR deliberately avoided changing that file: it is copied into released ZIP files, so even a pre-implementation note there would change package bytes and invalidate the presently documented SHA-256. The implementation publishes updated instructions inside its new content-hash-addressed ZIP only after an independently authorized production release. Code review or CI alone does not establish a live page. The current official installation method is still the [existing GitHub Actions artifact](INSTALL.md).

## Sources and rationale

- Current Browser MCP implementation and release: [Browser MCP README](../../apps/browser-mcp-worker/README.md), [context](../../apps/browser-mcp-worker/CONTEXT.md), [#418](https://github.com/lirtual/mcp-workers/issues/418), [#531](https://github.com/lirtual/mcp-workers/issues/531).
- Cloudflare: [Worker Static Assets](https://developers.cloudflare.com/workers/static-assets/), [configuration and Worker-first routing](https://developers.cloudflare.com/workers/static-assets/binding/), [asset size limit](https://developers.cloudflare.com/workers/platform/limits/).
- Decision record belongs in the existing Browser MCP Context, **not** a new bounded context. No ADR is required: the public URL contract is stable, but its underlying hosting can later be switched without changing Profile control semantics; this choice does not satisfy the domain-modeling skill's hard-to-reverse threshold.
