# Browser architecture: current phase-one decision (2026-10-20)

**Status: owner-approved architectural direction for a P0 test; NOT a passed feasibility gate or authorization to implement, merge, release or deploy.** This review is the **latest applicable phase-one backend decision** and supersedes CLI-first guidance in the earlier browser PoC, specification, decision-tree prefaces and ADR-0022. All Q1–Q52 history and positive/negative MXC, WFP, Windows CLI and Playwright tests remain as historical evidence, not current platform acceptance.

## Product boundary and choice

Extend the **existing Remote Control Agent**, not a new Agent/Worker/MCP service, to control an independent automation browser on an explicitly selected, already paired device. Reuse MCP Portal auth, Worker/DO device routing, signed WSS, existing SQLite Operation IDs/receipts, Agent management and existing packaging/rollback. No second cloud session store, browser proxy, custom DOM Ref registry, general CLI/JS/CDP tool or personal Chrome/Edge Profile attachment.

**First choice, pending P0:** integrate `playwright-core@1.64.1` **directly in the Agent** using one small `BrowserManager`. The official Playwright page API provides `page.ariaSnapshot({ mode: "ai" })` with element refs and `page.getByRef(ref)` (documented since v1.64). Use a separate local Automation Profile, existing operation-scoped authorization and curated MCP methods. Test snapshot/Ref semantics before taking this capability as working; do not implement a custom Ref registry by default.

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

## Gates after P0 (not authorized yet)

- **P1** — one `BrowserManager` and only required MCP tools. Selectively carry over PR #15's Playwright code and PR #19's backend-independent WSS/SQLite receipt logic; keep PR #143 disabled until acceptance. Do not add new auth, job, state or deployment entities.
- **P2** — authenticated **real** ChatGPT/MCP → Worker/DO → Agent → browser on a controlled site, including explicit device/session/tab, unknown outcome/non-replay, refusal, disconnect, restart/revocation, cleanup and existing shell/file regression checks. Browser click completion ≠ website-side business completion.
- **P3** — per-platform installation, dependency provenance, update/rollback and teardown acceptance, then a separate owner enablement decision. macOS stays unverified until tested on macOS.

**Security boundaries:** trusted paired device ≠ trustworthy page. Navigation can have external effects. Do not publish arbitrary JS/CDP, personal profile access or consequential/ambiguous actions. Exact Agent-verifiable, one-use owner confirmation is **unverified**; high-impact actions stay disabled. Browser-wide hostile-execution/MXC/WFP isolation remains **DEFERRED/UNPASSED** rather than fulfilled by URL checks or normal Chrome startup.

## Project-independent behavior check

Apply [Engineering decision guardrails](../agents/engineering-decision-guardrails.md): define the problem first; demand evidence for each new component; return to the selection gate rather than adding layers to rescue a failing approach. Separate historical evidence, current decision, source, mock, real-device tests and actual installed/enabled acceptance.

API reference: https://playwright.dev/docs/api/class-page (`ariaSnapshot`, `getByRef` v1.64).
