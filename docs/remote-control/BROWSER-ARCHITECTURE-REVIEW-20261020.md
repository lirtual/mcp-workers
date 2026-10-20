# Browser architecture: current phase-one decision (2026-10-20)

**Status: direct-Playwright selection P0 verified on actual Windows + WSL devices (2026-10-20). This is NOT a packaged-Agent or real MCP E2E acceptance and does not authorize implementation, merge, release or deployment.** This review is the **latest applicable phase-one backend decision** and supersedes CLI-first guidance in the earlier browser PoC, specification, decision-tree prefaces and ADR-0022. All Q1–Q52 history and positive/negative MXC, WFP, Windows CLI and Playwright tests remain as historical evidence, not current platform acceptance.

## Product boundary and choice

Extend the **existing Remote Control Agent**, not a new Agent/Worker/MCP service, to control an independent automation browser on an explicitly selected, already paired device. Reuse MCP Portal auth, Worker/DO device routing, signed WSS, existing SQLite Operation IDs/receipts, Agent management and existing packaging/rollback. No second cloud session store, browser proxy, custom DOM Ref registry, general CLI/JS/CDP tool or personal Chrome/Edge Profile attachment.

**P0-supported first choice:** integrate `playwright-core@1.64.1` **directly in the Agent** using one small `BrowserManager`. The official Playwright page API provides `page.ariaSnapshot({ mode: "ai" })` with element refs and `page.getByRef(ref)` (documented since v1.64). Use a separate local Automation Profile, existing operation-scoped authorization and curated MCP methods. The observed snapshot/Ref API is working in the isolated P0 described below. Do not implement a custom Ref registry by default; require explicit device/session/tab/current-snapshot scoping at the Agent tool boundary.

Direct Playwright still launches an external browser and requires compatible platform binaries/libraries. Check installed Chrome compatibility first in a disposable test; use version-matched Chromium via the **existing** Agent packaging method if needed. Windows + Linux/WSL are P0 targets; macOS retains the same planned interface but is not accepted without its own Agent and browser test.

## Code evidence and salvage plan

| Source | Useful evidence/code | Gap / decision |
| --- | --- | --- |
| [Agent Draft #15](https://github.com/lirtual/remote-control-agent/pull/15) | Playwright v1.64.1 dependency, injected Chromium driver, isolated Profile, offline ARIA Snapshot, tested optional browser candidate | Its fixed `offline: true`, disabled JavaScript and HTTP/WebSocket denial are **not** an ordinary networked browser. Reuse selectively, do not merge as a finished navigator. |
| [Agent Draft #19](https://github.com/lirtual/remote-control-agent/pull/19) | Typed WSS dispatch, existing SQLite receipts/operation non-replay, timeout, revocation evidence; real Windows CLI/native EXE tests | CLI adapter and separate EXE packaging are **historical prototype/fallback**, not the preferred final backend. Browser not injected into production Agent startup. Reuse receipts/transport, not an extra CLI. |
| [Worker Draft #143](https://github.com/lirtual/mcp-workers/pull/143) | Five atomic browser tool contracts on existing device DO route | Browser `tools/list`/`tools/call` remain disabled; align with validated Agent API. |
| [Windows CLI comparison](./BROWSER-BACKEND-POC-20261020.md) | Both external CLIs ran real TodoMVC and closed cleanly on the paired host | Does **not** compare the *direct Playwright API* or certify real MCP feature/installed Agent, so it is not an architectural winner. |

**Do not merge PR #15 and #19 wholesale:** they overlap in CI, browser modules and Windows build logic. An eventual single implementation branch should selectively reuse verified logic. Keep `agent-browser` as a tested fallback only **if an actual Playwright limitation is demonstrated**; no simultaneous second backend or fallback framework.

## P0: minimum falsifiable selection test — no project code changes

1. On already paired Windows and WSL/Linux devices, use temporary isolated workspaces with a verified fixed `playwright-core@1.64.1`, dedicated Automation Profile and a controlled, non-sensitive website. Preserve existing installed Agents and personal browser Profiles.
2. Verify Chromium launch and navigation, `page.ariaSnapshot({mode:"ai"})`, `page.getByRef()` click/fill, new Snapshot after a page change, stale/ambiguous Ref rejection, bounded output, iframe scoping and normal/abnormal process cleanup. Record browser build, dependencies, command/result evidence and teardown.
3. Decide from evidence whether a compatible existing Chrome is sufficient; otherwise evaluate the already-proven version-matched Playwright Chromium package. Do not create another installer, browser-worker service or Ref registry to compensate for an unverified assumption.
4. **GO** if both target platforms pass critical behaviors and a feasible compatible browser/Agent packaging path exists. **RECONSIDER** if direct Playwright has a reproducible blocking API or runtime limitation that cannot be resolved within the existing minimal boundary. Compare that *specific* blocker with the earlier agent-browser candidate before changing direction.

P0 success permits planning P1; it is **not** E2E or publication acceptance.

## P0 real-device evidence — PASS for backend selection, not installed product

The **same isolated CommonJS test script** was executed directly through existing authorized Remote Control Shell, without modifying source repositories, installing a new Agent or opening any browser-specific MCP tools. It used `playwright-core@1.64.1` installed in a dedicated disposable directory with `--ignore-scripts`, and separate test-only automation Profiles. Only controlled synthetic HTML and the public Playwright TodoMVC demo were accessed (no real account/credential or external high-impact operation).

| Actual check | Windows native (paired device) | WSL2 Ubuntu (paired device) |
| --- | --- | --- |
| Node + Chromium | Node 24.12.0, preinstalled Chrome 155.0.8059.85 | Bundled Agent Node **24.21.0** (also independently Node 22.21.0), pinned Chromium Headless Shell **156.0.8078.4**, revision 1248 |
| Separate Chromium Profile + `page.goto(data:)` | PASS | PASS |
| `page.ariaSnapshot({ mode: "ai" })` yields `[ref=...]` | PASS, 165-char synthetic snapshot | PASS, same 165-char snapshot |
| `page.getByRef()` button click and textbox fill | PASS | PASS |
| Old Ref rejected after document replacement | PASS | PASS |
| iframe Ref `f1e2` click | PASS | PASS |
| Ambiguous locator refuses same-name buttons | PASS | PASS |
| Large semantic snapshot bounded to 8,000 characters by caller | PASS, 32,829 original chars | PASS, same 32,829 original chars |
| Controlled HTTPS TodoMVC navigation and Ref fill | PASS | PASS |
| Profile-owned Chrome processes remaining after normal `context.close()` | **0** | **0** |

Additional check: after generating **a new** snapshot for a different document, the old `e2` Ref failed and new target used `e4` on **both** devices. Playwright refs are resolved against the *latest snapshot in their frame*. Do not assume a bare Ref alone authenticates the originating MCP observation; a future Agent implementation must check user/tool-provided session, tab and snapshot generation before every effect. The test does **not** certify Ref behavior for every SPA mutation, cross-origin iframe or OOPIF.

**Observed browser-dependency trap and minimal resolution:** WSL originally had cached Chromium revisions 1200/1208 but Playwright 1.64.1 requires revision **1248**. Initial launch refused the missing matching executable. An exact-matching headless shell was installed **only within the disposable P0 directory**, without host package-manager changes; the same script then passed with the Agent's bundled Node 24.21.0. The sandbox-local matching-browser download occupied approximately **278 MB** including the supplied ffmpeg dependency; this is a real packaging cost, not a claim that direct Playwright eliminates browser binaries. Windows passed with its existing Chrome; this version pairing needs continued regression monitoring or the established pinned Chromium packaging.

**Selection conclusion: GO for a single direct-Playwright design / P1 proposal**; no extra agent-browser executable, JS wrapper, custom Ref registry, second Worker, service or database justified by the tested use case. Keep the former CLI candidate as historical fallback **only** if a reproducible direct-API blocker appears.

**NOT yet proven:** installed/upgraded Agent can resolve the library/browser; package manifests/licensing and platform rollback; abnormal Agent crash/kill + process cleanup; full browser-specific MCP→DO→Agent round trip; reconnect/revocation and website side effects; cross-origin/hostile redirect security; exact single-use owner confirmation; macOS. These are distinct P1–P3 acceptance gates. Do not turn a unit/PoC success into a deployed-capability claim.

## Gates after P0 (not authorized yet)

- **P1** — one `BrowserManager` and only required MCP tools. Selectively carry over PR #15's Playwright code and PR #19's backend-independent WSS/SQLite receipt logic; keep PR #143 disabled until acceptance. Do not add new auth, job, state or deployment entities.
- **P2** — authenticated **real** ChatGPT/MCP → Worker/DO → Agent → browser on a controlled site, including explicit device/session/tab, unknown outcome/non-replay, refusal, disconnect, restart/revocation, cleanup and existing shell/file regression checks. Browser click completion ≠ website-side business completion.
- **P3** — per-platform installation, dependency provenance, update/rollback and teardown acceptance, then a separate owner enablement decision. macOS stays unverified until tested on macOS.

**Security boundaries:** trusted paired device ≠ trustworthy page. Navigation can have external effects. Do not publish arbitrary JS/CDP, personal profile access or consequential/ambiguous actions. Exact Agent-verifiable, one-use owner confirmation is **unverified**; high-impact actions stay disabled. Browser-wide hostile-execution/MXC/WFP isolation remains **DEFERRED/UNPASSED** rather than fulfilled by URL checks or normal Chrome startup.

## Project-independent behavior check

Apply [Engineering decision guardrails](../agents/engineering-decision-guardrails.md): define the problem first; demand evidence for each new component; return to the selection gate rather than adding layers to rescue a failing approach. Separate historical evidence, current decision, source, mock, real-device tests and actual installed/enabled acceptance.

API reference: https://playwright.dev/docs/api/class-page (`ariaSnapshot`, `getByRef` v1.64).
