# Remote Control Browser Automation — Specification Draft

**Status:** Specification synthesis from the approved Grill With Docs decisions Q1–Q52 and post-convergence feasibility review. **Draft documentation only; NOT implementation-ready, not an Issue/Ticket, not labeled `ready-for-agent`, and not authorization to code, run CI, merge or deploy.**

**Source of truth:** Existing Remote Control Domain Context, browser-design decision tree and ADR-0021–0030. A proposal below must not override those owner-approved decisions. The attached feasibility-review findings are *unverified evidence requirements*, not already accepted implementation detail.

## Problem Statement

As an owner of paired remote devices, I want to ask ChatGPT to inspect and operate a **specifically selected browser** running on a paired Linux, WSL2 or native Windows Agent. Existing Remote Control tools can access files and managed processes but do not expose a verified, safely scoped, ordinary browser workflow. I should not have to set up another MCP Worker, expose a CDP port, hand over my everyday Chrome/Edge profile, manage a new approval website, or repeatedly configure a second filesystem/identity system. Browser actions can touch sensitive page data and cause irreversible external effects, so successful browser dispatch, genuine owner consent and website-side business completion must remain distinct.

## Solution

Extend the existing **Remote Control MCP → authenticated device routing → Agent** path with a curated set of **single-purpose browser tools**. The Agent uses a Playwright-compatible Chromium installation and a **dedicated, persistent Agent-local Automation Browser Profile**, with at most one active Browser Session per Profile and multiple explicitly identified tabs. It reuses pairing, device ownership, Agent OS permissions, managed local files and durable Operation ID/Receipt concepts. It **does not** become a remote desktop, general-purpose browser scripting service or an open CDP endpoint.

Every tool targets an explicit device and, as applicable, session and tab. Normal observation is semantic/accessibility-first with bounded results; screenshots are explicit and can expose sensitive information. Element actions require unique, fresh targets. Low-impact behavior must be affirmatively established; consequential or uncertain external effects are **not** executed on a model's assertion or an unverified chat “yes.” Any high-impact action requires a genuinely verifiable, short-lived, one-use, exact-operation owner confirmation, else it remains disabled.

A browser tool being **documented**, **implemented**, **accepted for a specific platform** and **currently enabled** are separate facts. The initial supported subset may be smaller than the overall intended ordinary browser workflow. Actual platform rollout is independently gated and separately owner-authorized.

## User Stories

### Pairing, targeting and lifecycle

1. As a device owner, I want to select a paired device by its exact identity, so that browser work never silently targets a similarly named device.
2. As a device owner, I want to start an isolated browser session on my chosen device, so that automation does not take control of my daily Chrome/Edge.
3. As a device owner, I want a consistent session ID for successive calls, so that I can resume the same workflow without opening duplicate browsers.
4. As a device owner, I want a stable tab ID that survives navigation but expires on tab closure, so that subsequent actions affect the intended page.
5. As a device owner, I want to list, create and close browser tabs, so that multi-page research does not require a new session for each tab.
6. As a device owner, I want my automation login state retained locally in its dedicated Profile, so that routine visits do not require logging in again.
7. As a device owner, I want the Agent to allow at most one active session per Profile, so that concurrent browser launches do not corrupt Profile data.
8. As a device owner, I want normal sessions to be headless unless I choose a headed browser and the device has a usable GUI, so that no desktop GUI is assumed.
9. As a device owner, I want a session eligible for closing after 30 minutes of inactivity without erasing my Profile, so that forgotten processes do not run indefinitely.
10. As a device owner, I want a transport disconnect to preserve inspectable session state, so that a network glitch does not cause hidden action replay.
11. As a device owner, I want deliberate Profile clearing only when there are no active sessions or unresolved operations, so that identity and receipts are not destroyed prematurely.
12. As a device owner, I want safe Agent/browser crash recovery or a clear conflict instead of forced Profile-lock deletion, so that persistent browser data survives uncertain conditions.

### Page observation and interaction

13. As a device owner, I want to navigate to an explicitly chosen HTTP(S) destination, so that I can inspect a public webpage or an appropriately authorized internal webpage.
14. As a device owner, I want sensitive destinations checked after redirects and address changes, so that the browser cannot silently move from a benign URL to an unapproved metadata or internal endpoint.
15. As a device owner, I want a focused semantic snapshot, so that ChatGPT can identify page controls without always sending whole DOM trees.
16. As a device owner, I want a clear indication when a semantic snapshot is truncated, so that I can request a focused continuation rather than relying on missing details.
17. As a device owner, I want an on-demand screenshot of the chosen tab, so that visual-only interfaces can be inspected when semantics are insufficient.
18. As a device owner, I want semantic locators to uniquely identify their current target, so that duplicated labels or old page state do not cause unintended actions.
19. As a device owner, I want stale screenshot coordinates to be rejected after page or viewport changes, so that a click cannot accidentally strike a new element.
20. As a device owner, I want independently scoped click, fill, select and keyboard operations when they are actually permitted, so that common browser workflows remain expressive without arbitrary script execution.
21. As a device owner, I want to understand whether ordinary browser workflows need a wait, dialog, scrolling, navigation-history or popup primitive, so that necessary interactions are supported without mirroring Playwright's entire API.
22. As a device owner, I want untrusted page text treated as observations rather than instructions, so that a website cannot authorize tools or override my workflow.

### Authorization, effects and resilience

23. As a device owner, I want genuinely low-impact browsing available without redundant prompts where safely established, so that common reads remain usable.
24. As a device owner, I want a consequential or uncertain-effect action rejected unless it meets the verified approval requirement, so that labels such as “Continue” cannot silently authorize purchases or deletions.
25. As a device owner, I want to inspect a proposed high-impact action before it executes, so that I know the exact device, tab, operation and significant parameters.
26. As a device owner, I want my authorization short-lived and single-use, so that changing targets, replaying calls or restarting Agents cannot silently reuse consent.
27. As a device owner, I want high-impact actions disabled if the current client cannot provide valid Agent-verifiable approval, so that missing consent infrastructure cannot be bypassed.
28. As a device owner, I want potentially effectful browser operations associated with stable Operation IDs and Agent-local receipts, so that I can query status after a timeout without issuing the effect again.
29. As a device owner, I want browser execution status distinguished from confirmation of a website-side transaction, so that a click returning success is never misreported as an order or message definitely committed.
30. As a device owner, I want failed, disabled, unaccepted, uninstalled and unauthorized capabilities reported truthfully, so that ChatGPT does not claim unsupported browser actions succeeded.

### Files, privacy and platform delivery

31. As a device owner, I want browser uploads to name an explicit Agent-local source and destination origin, so that filesystem readability alone cannot silently authorize external exfiltration.
32. As a device owner, I want downloads saved in a dedicated local directory using non-overwriting safe filenames, so that webpages cannot replace files outside the managed area.
33. As a device owner, I want downloads available through existing Remote Control file operations, so that I do not need another file manager.
34. As a device owner, I want unreferenced downloads eligible for removal after seven days but referenced or unresolved files retained, so that disk usage stays controlled without losing pending work.
35. As a device owner, I want sensitive page contents and screenshots excluded from routine operation logs, so that my local/browser secrets are not routinely preserved in Worker telemetry or Agent receipts.
36. As a device owner, I want compatible Chromium installed on demand from a source with verified provenance, so that automation does not depend on my personal browser or arbitrary binaries.
37. As a device owner, I want separately evidenced Linux, WSL2 and native Windows acceptance, so that an accepted Linux run is not mistaken for Windows compatibility.
38. As a device owner, I want previously valid unchanged tests reused when applicable, so that rollout evidence is credible without endless repeated verification.
39. As a device owner, I want independently gated safe capability enablement rather than an all-platform, all-feature release requirement, so that verified functionality can progress without weakening consequential-action safeguards.
40. As a device owner, I want design acceptance separate from implementation, issue creation, PR merge and deployment approval, so that the documentation review cannot silently authorize production changes.

## Implementation Decisions

These are **accepted architecture/product constraints**, not precise unchecked code/interface commitments:

1. **Ownership seam:** use existing paired Remote Control MCP routing, device authentication and Agent-local executor. No new standalone Browser MCP Worker, publicly reachable CDP, nested Playwright MCP server or remote desktop.
2. **Runtime seam:** encapsulate direct Playwright library usage behind a small Agent browser capability adapter; launch compatible Chromium against the dedicated managed Profile. Avoid exposing generic page JS, arbitrary Playwright code or unbounded action routers.
3. **Single Profile/session rule:** initially one persistent automation Profile per paired device and one active browser session per Profile, with multiple tabs; preserve the Profile through session idle cleanup and disconnect.
4. **Identity:** require explicit `device_id`; require `session_id` and `tab_id` only for operations that target them. Reuse existing device/session error handling rather than creating a new global capability registry.
5. **Tool surface:** initial feature coverage comprises session lifecycle/status, tab lifecycle/list, navigate, semantic snapshot, screenshot, click/fill/select/keyboard and browser-scoped upload/download result access; exact atomic names and additional truly necessary UI primitives need a separate focused interface check.
6. **Selectors:** semantics/accessibility and unique targeting before effects. Visual fallback uses a recent screenshot bound to actual tab/page/viewport/scroll/layout state; fail and refresh on ambiguity or freshness loss.
7. **Observation:** bounded, task-relevant snapshots with an initial ~8,000-character default, explicit truncation and follow-up focused reads; initial screenshots are explicitly requested one at a time. Actual byte budgets, crop/format and privacy semantics remain technical contracts to verify.
8. **Authorization:** pairing and user identity do not alone authorize sensitive browser effects. Every high-impact external change needs an exact-action, short-lived, single-use owner confirmation provably available and checked through the real ChatGPT/MCP/Worker/Agent path. No such path is established by this specification; deny if unavailable.
9. **Low-impact scope:** status/listing, bounded observation and requested screenshots are only *candidate* low-impact capabilities; navigation requires network/effect assessment. Generic click/fill/select/keyboard are not automatically low-impact due to tool name or webpage label.
10. **Network:** normal navigation targets HTTP(S), not `javascript:`/`file:`; changed effective redirect/DNS targets must be revalidated, while internal/loopback/link-local/metadata endpoints require distinct authorization and safety review. A top-level URL check is insufficient proof of browser-wide egress security.
11. **Effect receipts:** extend the existing durable Agent Operation ID/Receipt contract for browser effects, with unknown outcomes and no blind replay. Browser action receipts do not certify website-side business success; separately read-only website evidence can be recorded when reliable.
12. **Files:** uploads use explicitly selected Agent-local source paths and consequential target origins under existing OS and Remote Control authorization. Downloads stay in a dedicated local directory with collision-safe no-overwrite creation and traversal/symlink protections. Normal owner-directed file changes reuse existing tools.
13. **Retention:** Agent-local downloads are eligible for cleanup after seven days only if positively unreferenced, respecting active sessions/unresolved receipts. Profile clear requires safe state and deliberate owner request.
14. **Privacy:** avoid routine collection/log persistence of whole DOM, screenshots, passwords, cookies, tokens and secret-bearing tool arguments. On-demand browser results may still contain sensitive data and must never be treated as trusted instructions.
15. **Supply chain:** prefer Playwright's version-compatible on-demand Chromium installation/cache, subject to real artifact provenance and platform dependency evidence; no custom browser CDN/registry by default.
16. **Availability:** distinguish documented, source-implemented, platform-accepted and enabled capabilities; enforce status and authorization at execution, not merely through UI tool advertisements.
17. **Scope discipline:** defer personal Chrome/Edge Profile attachment and macOS. Do not add a general workflow orchestrator, new durable website transaction ledger, approval portal, second file manager or cloud media repository unless a genuine unresolvable requirement is reviewed and separately accepted.
18. **Release governance:** implementation, development issue/Ticket publication, acceptance execution, CI changes, merges and platform deployment each require separately scoped approval. The current Draft PR and this draft spec do not constitute that approval.

**Recommended adapter/test seam, pending implementation-planning confirmation:** prefer **one highest useful end-to-end seam**: a named MCP tool call on a specifically paired device flows through the existing authenticated Worker/DO router to a bounded Agent browser adapter and a controlled test webpage; verify authorization, exact target, observable result and receipt/status behavior across that path. Add narrowly scoped unit/contract tests *only* where necessary for independently risky boundaries (address classification, screenshot size, file naming, one-use approval). Do not introduce a new test server/service architecture merely to exercise the design.

## Testing Decisions

Acceptance tests must assert **externally observable behavior and refusal/recovery**, not internal Playwright method calls or private class structure. Reuse existing paired-device transport and operation-receipt coverage as prior art; do not equate prior acceptance with browser acceptance.

1. **Target/identity:** ensure wrong or ambiguous device, session and stale tab identifiers cannot execute in another browser.
2. **Profile isolation:** verify automation never silently opens the owner's everyday personal browser Profile and does not create two active sessions for one Profile.
3. **Session lifecycle:** verify reuse, explicit close, approximately 30-minute idle eligibility and preservation of Profile data across cleanup.
4. **Disconnect/restart:** query unknown or interrupted operations after lost responses, never silently replay, and fail safely on unresolved Profile locks.
5. **Semantic observation:** validate focused snapshot limits, explicit truncation, unique locator resolution, ambiguous target rejection and output privacy.
6. **Visual observation:** validate screenshot round trip **Agent → DO/Worker → MCP → ChatGPT** within measured request/response constraints, with actual media type, oversize handling and no default secret-bearing logs.
7. **Visual target freshness:** reject stale screen targets after navigation, tab close, scrolling, resizing, layout changes and uncertain state.
8. **Browser-wide network safety:** test redirects, DNS changes/rebinding, loopback/private/link-local/metadata targets, frames, XHR/fetch, WebSockets and Service Workers; assert no false “blocked” claim based only on navigation URL parsing.
9. **Effectful classifications:** test benign-looking labels that commit actions and ensure undefined safety means denial rather than model judgment.
10. **Owner consent:** on a real supported ChatGPT client, validate prepared action, explicit owner intent, exact target/args binding, expiry, one-time consumption, replay denial, changed/absent proof rejection and disconnected/restarted status. If proof cannot be carried, high-impact capability is a non-releaseable feature.
11. **Receipts/business evidence:** browser-level completion is kept separate from a website-side success signal; uncertain outcomes remain unknown, never automated retried.
12. **Files:** reject path traversal, overwrite, symlink escape, unexpected sensitive source, changed upload destination and unsafe binary transfer; test seven-day cleanup protects referenced/unknown files.
13. **Normal browser workflows:** demonstrate selected login, search, form preparation, popup/dialog and download scenarios using actual available atomic tools; report genuine missing primitive rather than adding a generic dispatcher.
14. **Browser installer:** verify matching runtime browser artifact provenance/integrity and clear fail-closed behavior offline or on untrusted/mismatched download.
15. **Platform boundaries:** independently demonstrate relevant Linux, WSL2 and native Windows browser startup, interaction, filesystem, security denial, upgrade and rollback. Reuse unchanged prior evidence only when the relevant behavior did not change.
16. **Capability accuracy:** verify unsupported/uninstalled/unaccepted/disabled actions are not advertised or reported as usable, including errors on refusal.
17. **Release:** no production enablement without applicable real-platform evidence and separate owner approval; the existence of this draft spec does not pass any gate.

## Out of Scope

- Remote OS desktop, generalized GUI mouse/keyboard control, window manager or screen sharing.
- Public CDP/WebSocket browser-debugging listeners, arbitrary JavaScript evaluation or exposing an unrestricted Playwright gateway.
- New standalone browser MCP Worker, additional device fleet/identity system, approval portal, capability registry or website transaction ledger.
- Automatic connection to the owner's personal Chrome/Edge Profile or using its existing cookies (possible separately authorized future capability).
- Multiple automation Profiles per device, parallel browser sessions on a single Profile and generalized profile provisioning UI.
- macOS initial support.
- Silent browser OS-level privilege escalation, custom Chromium distribution platform or unverified binary fallbacks.
- Promising exactly-once external website effects or equating click success with a committed transaction.
- Global site allowlist configuration, unsupported claim of whole-browser network safety based on only top-level navigation filters.
- Bulk PDF/ZIP/image transfer from the Agent to ChatGPT without separately verified size/media/authorization contract.
- Persistent logging of arbitrary page content, screenshots or credentials by default.
- Automatically writing runtime code, development Tickets, CI changes, merging, deployment or publishing this spec to a tracker.

## Further Notes

**Post-research factual update (not implementation approval):** [P0 research](./BROWSER-P0-FEASIBILITY-RESEARCH.md) now includes a safe local ephemeral Playwright probe and read-only plugin discovery. The connected Remote Control tool surface did not expose browser actions or an approval-proof test. A synthetic loopback HTTP redirect test was **blocked by this sandbox's administrator policy before reaching the route callback** and is **inconclusive** for project network security; no Remote Control device command was run. Offline small-page screenshot generation (PNG 12,063 B; JPEG 10,553 B) is **not** an MCP image round-trip. Also, existing DO dispatch has a 5-second timeout, so browser reads/effects will need explicit operation lifetime/error handling rather than assuming current remote file-read semantics are sufficient. All P0 gates remain unverified.

**Owner-selected device readiness evidence (2026-10-20):** [P0 research §F–G](./BROWSER-P0-FEASIBILITY-RESEARCH.md#f-user-selected-paired-device-readiness--read-only-check-2026-10-20) documents exact-device `online` pairing status but failures of all attempted read-only OS/file/stat/session queries. This does **not** identify the OS or qualify the device as an isolated browser target. Follow the explicitly gated sequence: read-only platform/capability discovery ⇒ disposable controlled network fixtures and browser context ⇒ supported ChatGPT client-to-Agent synthetic action approval proof. Stage 0 is **BLOCKED**, stage 1 **NOT RUN**, stage 2 **NOT TESTABLE** with current browser-tool inventory. Retain fail-closed behavior; do not introduce Shell/proxy/approval implementation or new Tickets to bypass this gate.

**Critical feasibility gates before any affected capability may be activated:**

| Gate | Status at document creation | Required evidence |
| --- | --- | --- |
| Agent-verifiable owner approval | **Unverified** | Real supported client and MCP→Worker→Agent single-use owner intent validation; deny until proven |
| Browser-wide egress control | **Unverified** | Real request coverage beyond initial navigation, including redirects, DNS, internal targets and Service Worker |
| Screenshot MCP image transport | **Unverified** | Bounded binary/image round trip across existing message limits, including oversized results |
| End-to-end tool usability | **Unverified** | Controlled realistic workflows and exact tool inventory gap assessment |
| Upload/exfiltration permission | **Unverified** | Explicit source and destination intent with denial of unauthorized uploads |
| Binary download access | **Local-only direction accepted; remote delivery not proven** | Clearly report unsupported remote binary transfer until bounded authorization/media contract passes |
| Browser provenance/OS acceptance | **Unverified** | Genuine compatible browser artifacts plus independent Linux/WSL2/Windows evidence |

**Open technical contract work is not an invitation to invent a new product decision**: exact screenshot encoding/size, approval TTL and transport proof, final tool argument schemas, page freshness algorithm, safe network interception strategy and per-platform detailed test cases require evidence. A discovered irreconcilable product trade-off returns for owner decision before code. This spec does not silently choose those unknowns.

**Spec publication boundary:** The Matt Pocock `to-spec` workflow usually publishes a spec to an issue tracker with a `ready-for-agent` label. In this project, earlier explicit owner constraints prohibit creating development Tickets and authorize documentation-only Draft PR work. Therefore this artifact is deliberately a **reviewable spec draft within the existing Draft PR**, **not** a new Issue or agent-executable ticket. Publishing or applying `ready-for-agent` requires separate owner authorization.
