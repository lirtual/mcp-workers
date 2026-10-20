# Remote Control Browser — minimal trusted-device backend PoC (2026-10-20)

**Historical PoC record — NOT the current backend decision.** The original Windows CLI experiment passed; subsequent Agent Draft PRs #15/#19 and Worker Draft #143 contain source-stage prototypes, but no browser-specific tool is enabled or deployed. See the [current phase-one architecture review](./BROWSER-ARCHITECTURE-REVIEW-20261020.md) for the current preferred direct-Playwright design and P0 selection gate.

## 1. Historical phase-one scope decision (later backend choice superseded)

**Goal A — trusted, owner-paired personal devices:** Reuse existing ChatGPT → Remote Control MCP Worker/Portal → paired Agent connection, authorization and local operation receipts. Delegate page automation to **one** Agent-local backend; direct `playwright-core` is now preferred only after P0 validation, rather than treating a CLI PoC as a backend decision. Maintain a separate disposable/dedicated automation Profile, explicit device/session/tab targeting, bounded observations, safe process ownership and cleanup, and user confirmation for high-impact effects.

**Not phase one / Goal B — untrusted execution:** Do not claim browser-wide enforcement of private-network/metadata egress, a sealed hostile-webpage sandbox, or adversarial Agent isolation. Pause **MXC / ProcessContainer + WFP + permanent proxy** compatibility work. Historical positive and negative tests in `BROWSER-P0-FEASIBILITY-RESEARCH.md` remain intact as evidence. The earlier strict-network-egress P0 is **DEFERRED, NOT PASSED**. Any later untrusted-agent/hostile-content product expansion requires a separate threat model, OS/VM isolation acceptance and explicit owner decision; a CLI URL filter is not a substitute.

Prior rounds Q1–Q52 remain **historical decisions for the broader design**. The current phase-one architecture review supersedes this document's former CLI-first choice. Earlier strict MXC Chromium-in-container acceptance is not silently treated as passed or necessary for the personal paired-device first phase. This is a deliberate **change in applicable threat model and launch gates**, not a claim that older P0 tests passed.

## 2. Original PoC sources and historical selection

- [agent-browser](https://github.com/vercel-labs/agent-browser) CLI: native Windows browser lifecycle, semantic/interactive `snapshot -i` with `@eN` refs, named sessions and profiles, process ownership. Documentation: [Windows installation/process ownership](https://github.com/vercel-labs/agent-browser/blob/main/docs/src/app/installation/page.mdx), [sessions](https://github.com/vercel-labs/agent-browser/blob/main/docs/src/app/sessions/page.mdx).
- [Microsoft Playwright CLI](https://github.com/microsoft/playwright/blob/main/docs/src/getting-started-cli.md): `snapshot` with `eN` refs, named sessions, Profile, standard click/fill/press and cleanup. No nested Playwright MCP required.
- ego-lite: potential later reference for user takeover/Task Space UX, **not** a phase-one browser backend.

Original PoC-time first candidate (**superseded**): **agent-browser**. The Windows PoC shows parity on the requested basic actions; the more compact interactive snapshot and native Windows process management are useful for this existing device-Shell boundary. **Do not install both permanently, implement a dual-backend selection layer, launch a new Browser Worker or expose unrestricted arbitrary CLI invocation.** Keep Playwright CLI as a recorded comparison/fallback only if a specific integration blocker is demonstrated. Any implementation should package/pin one audited backend and expose **curated atomic MCP tools**, not a general Shell or script pass-through.

No need for extra D1 table, cloud session manager, new Remote Control identity system, generic CDP driver or independent approvals database.

## 3. Actual authorized Windows PoC

Target: already-paired Windows device `71b4b4d8-6496-4898-9b80-1ea3a03f6ccd`, directly through existing Remote Control `run_command`/Shell. Windows `Win32NT`, Node `v24.12.0`, npm `11.6.2`; preinstalled local Google Chrome was used as browser executable, **not** a previously unproven browser inside MXC. Packages installed in a uniquely named local TEMP folder only: `agent-browser@0.39.1`, `@playwright/cli@0.1.22`. Distinct local Profiles and named sessions: `rca-poc-ab-20261020` / `rca-poc-pw-20261020`. Existing personal Chrome/Edge Profiles and cookies were **not** selected. No test account/credentials were used.

| Observable test (on the real paired Windows host) | agent-browser | Playwright CLI |
| --- | --- | --- |
| Start isolated Chrome process and open `https://example.com/` | PASS, `Example Domain` | PASS, `Example Domain` |
| Read accessibility/semantic snapshot with an element Ref | PASS, `e1` link | PASS, `e13` link |
| Navigate to `https://demo.playwright.dev/todomvc/` | PASS | PASS |
| Locate TodoMVC textbox | PASS, `e4` | PASS, `f1e8` |
| Fill local demo todo and press Enter | PASS | PASS |
| Click resulting `Toggle Todo` checkbox via Ref | PASS, `e8` | PASS, `f1e21` |
| Observe `checked` on fresh snapshot | PASS | PASS |
| Close owned browser session | PASS | PASS |
| Inspect tagged Chrome process command lines two seconds after close | 0 left across both sessions | 0 left across both sessions |

PoC execution was **via the already-authorized Remote Control Shell**, **not** through newly implemented/browser-specific MCP tools. This proves **basic real-device CLI feasibility**, not end-to-end browser-specific MCP transport, production startup/upgrade/rollback, arbitrary site compatibility, idle-reaping, crash/forced-kill cleanup, screenshot transfer or one-use high-impact approval. The synthetic TodoMVC interactions only modify the disposable browser session's demo state.

**Cleanup confirmation:** both named browser sessions reported closed; agent-browser subsequently reported no active sessions and Playwright CLI listed no browsers. All tagged Chrome processes were gone. The isolated TEMP package directory/Profiles and five specifically identified test output files were deleted; no personal browser Profile was selected or altered. No browser CLI package was retained as a permanent Agent dependency.

The preexisting `playwright-core@1.64.1` Agent Draft PR #15 is an **offline-only** prototype; review it for reusable code, not as a ready-made navigator. Playwright v1.64 includes built-in AI ARIA Snapshot refs and `getByRef`, reducing the reason to retain a separate browser CLI.

## 4. Revised illustrative shape (current preference; still pending P0)

```text
ChatGPT
  ↳ existing Remote Control MCP Worker / Portal (auth, paired device route)
     ↳ existing Remote Control Agent (authorization, session/operation receipts)
        ↳ one direct Playwright BrowserManager (P0 candidate; curated actions only)
           ↳ Chrome/Chromium + dedicated Automation Profile
```

Initial tool candidates only: browser session start/status/close, tab list/create/close when actually needed, navigation, bounded semantic snapshot, explicit screenshot, click/fill/select/keyboard, and existing local file tools for safely authorized files. Implement fewer on the first cut if scenario coverage allows. Reuse backend Ref handling; do **not** build a second custom DOM Ref registry. Ref freshness/ambiguity rejection, explicit session/tab scoping and output minimization are still required.

**Permissions:** Device pairing or Shell availability is not proof of action-specific owner approval. Maintain the existing trusted-device authority boundary, task-scoped tool authorization, non-replay receipts and a separate effect-classification gate. **Do not** make purchases, send messages, delete records, change permissions or perform ambiguous externally consequential actions unless genuine user confirmation can be verified through the actual client→Worker→Agent path for the exact operation. If it cannot, refuse. A prompt/model assertion or page text is not that proof. Controlled demo-site local-state testing is not approval of real-site effects.

**Security scope disclosure:** A browser-only network restriction does not constrain other authorized Agent tools, including Shell; likewise a dedicated Profile is session separation, **not** OS-level containment. Keep browser data and minimal receipts on-device, never log cookies/passwords/full pages by default, and do not access personal Chrome profiles in phase one.

## 5. Historical acceptance gates (current authoritative gate is in architecture review)

Phase-one trusted-device gate (must be newly tested at the integrated MCP boundary, not inferred from the CLI PoC):
1. Exact device identity, authorized session and tab: deny mismatch/stale Ref; no browser-to-Shell generic escape tool.
2. One supported backend packaged/pinned and repeatably started on Windows; session reuse, close, timeout and abnormal termination reclaim only owned processes; no personal browser Profile use.
3. Controlled-target page navigation/snapshot and intentionally safe interaction (navigation is not guaranteed side-effect-free) through actual ChatGPT → MCP → Worker → Agent → backend; bounded output and honest error/status.
4. Local operation IDs/receipts, disconnection/unknown outcome handling and explicit non-replay; confirmation transport for high-impact operations, **or those tools remain disabled**.
5. Browser authorization/privacy/file boundaries, dependencies/provenance, upgrades and actual platform-specific smoke verified before enablement. Any unsupported platform stays disabled rather than weakening its gates.

Explicitly **excluded from phase-one acceptance**: MXC Chromium success, WFP/proxy universal egress enforcement, DNS/rebinding/iframe/Service-Worker/WebSocket isolation in hostile execution, a new approval service or full multi-tenant sandbox. None of those tests is claimed PASS. Reopen them only if the target shifts to Goal B.

## 6. Historical decision checkpoint (superseded by architecture review)

- Real paired-device PoC: **PASS** for basic CLI interaction and normal close; **not yet an integrated MCP feature**.
- **Current preferred candidate: direct `playwright-core` inside Agent, conditional on P0 Windows/WSL real-device API verification.** The former agent-browser/Playwright CLI head-to-head results remain fallback and comparative evidence, not a second maintained production backend.
- **Pause** further MXC/ProcessContainer/WFP/Proxy-only/Chromium-in-container experimentation.
- Preserve existing historical research, negative findings, all previous Draft work, and previous Q1–Q52 as context; modify the current first-stage spec/ADR gates to remove contradictions.
- No new Ticket, Browser Worker, D1 table, new proxy, deployment, PR merge or Agent runtime change in this PoC.
