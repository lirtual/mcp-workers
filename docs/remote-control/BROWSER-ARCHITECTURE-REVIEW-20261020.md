# Browser architecture: current phase-one decision (2026-10-20)

## Windows browser handoff and default selection — new Grill With Docs round 1 (2026-10-21)

**Owner accepted H1–H4 (the new interview's Q1=A, Q2=A, Q3=A, Q4=B).** Use the H-prefix to distinguish this new round from historical browser-design Q1–Q52. This is a Windows Goal A design amendment, not evidence of implementation.

- **H1 / Q1=A — headed Windows browser.** Always use a visible Playwright automation window on native Windows, permitting unplanned human takeover. This supersedes ADR-0024's earlier headless-by-default choice only for the first-stage Windows scope; other platforms are unchanged. Visibility is not personal Profile attachment, desktop streaming or remote GUI control. Window focus, lock-screen and UI-session behavior remain unverified.
- **H2 / Q2=A — explicit two-way handoff.** Both Agent and owner may initiate a handoff. While human control is active, the Agent must not perform further browser operations. **Only explicit owner direction** returns control to the Agent. Handoff/resume is NOT independently verifiable, one-use approval for consequential website effects. Exact admission/cancellation of in-flight effects, control-state reconciliation after crashes, and client presentation remain open.
- **H3 / Q3=A — Windows system-default Chrome/Edge chosen at session start.** Re-evaluate the current Windows user's default browser only when opening a new automation session, using a single direct Playwright backend (Chrome channel chrome / Edge channel msedge). A running session keeps the browser it was launched with even if Windows changes its default. Chrome and Edge have **separate Agent-owned Automation Profile directories**, never the user's regular browser Profiles; do not live-migrate sessions or add another browser engine/service. This supersedes ADR-0023's historical one-Profile-per-device assumption for the two supported Windows browser families only, with no new concurrency guarantee. OS association lookup, mismatched HTTP/HTTPS settings, unsupported defaults and browser compatibility remain unresolved.
- **H4 / Q4=B — 30-minute idle limit still applies during human takeover.** Entering human-control state does not pause the existing 30-minute inactivity cleanup. Profile data persists when a session closes. What constitutes human activity, warning and expiration behavior, and reconnect/restart recovery remain open; do not assume Playwright observes user input automatically.

The existing Portal, Worker/DO, signed WSS, device pairing, Agent SQLite operation receipts and high-impact single-use approval requirements remain unchanged. No new CLI/backend, MCP server, approval service, proxy, database, or desktop-control tool. Current Agent PR #20 still hardcodes Chrome plus headless mode and has no handoff state; Worker browser tools remain disabled. The decisions do not authorize code, merge, release, production Agent upgrade or tool enablement. The next round must resolve the smallest set of downstream behavioral decisions.

### Grill With Docs Windows handoff — round 2, H5–H11 (2026-10-21)

**Owner explicitly accepted H5=A, H6=A, H7=A, H8=A, H9=A, H10=A and H11=A.** These extend H1–H4 of this new Windows interview, not the historical Q1–Q52 series.

- **H5=A — verified human browser activity refreshes inactivity accounting.** When a real user operates the *Agent-owned automation browser page*, positively detected interaction counts toward the same 30-minute idle limit as Agent activity. Do not mistake OS-global activity, mere window visibility, idle polling, untrusted page-generated events or an Agent assertion for verified human input. The exact detection source, event criteria, spoofing limits and protection of typed secrets remain **unresolved**.
- **H6=A — automatic idle cleanup.** At 30 minutes of actual inactivity, close the Agent-owned browser session even when Human Control is active; retain the browser-family-specific Automation Profile and its local authentication state. A new browser session is required to continue. This does not erase durable operation receipts or assert completion/cancellation of uncertain website effects. Warning/no-warning UX remains **undecided**; no approval prompt or indefinite hold is implied.
- **H7=A — owner resumes through ChatGPT / existing Remote Control MCP.** The owner explicitly issues an instruction such as “继续操作” through the existing client/tool route to return to Agent Control; no new Windows overlay or local control panel. An assistant-generated message, page content, pairing state or generic MCP bearer token alone must not be treated as independent proof of human approval for a consequential site action. Exact session binding and command authorization are **unresolved**.
- **H8=A — bounded in-flight operation handoff.** On handoff, stop admitting **new** Agent browser effects immediately. Let a previously admitted, owned action finish or hit its existing bounded timeout before declaring Human Control, then reconcile and surface completed/failed/unknown outcome without blind replay. Do not silently cancel an already-effectful command or claim a website side effect was reversed. Exact terminal-state semantics and human-visible waiting behavior are pending.
- **H9=A — only unambiguous Windows default Chrome/Edge.** Start a new automation session only when the effective current-user HTTP and HTTPS default associations **consistently** identify supported, launchable Chrome or Edge. Missing, contradictory, non-Chromium, unsupported or unreadable associations fail explicitly; do **not** guess or silently fall back to an arbitrary installed browser. A running session remains pinned to its chosen browser.
- **H10=A — one live automation browser session per paired device.** Chrome and Edge may retain **distinct Agent-owned Profiles**, but may not run concurrent automation sessions on the same device. Session/profile selection and start conflict must be serialized; no per-browser parallelism, new scheduler or generalized multi-session manager.
- **H11=A — no hidden headless fallback.** Windows headed automation requires an actual usable interactive desktop. If it is absent at start, return a clear unavailable result rather than silently switching to headless mode. Behavior when the desktop becomes locked, logs out, or is lost *during* an existing session is **not yet decided**.

**Unchanged security and scope:** single Node.js Agent, one direct Playwright backend, existing Portal/DO/signed WSS and SQLite Operation IDs/receipts, separate automation Profiles, conservative high-impact approval gate, residual SSRF exposure accepted only for personally paired Goal A. Handoff is not a high-impact approval; URL checks are not browser-wide network isolation. All current Draft browser tools remain disabled. This decision is **documentation only** and authorizes no implementation, build, merge, Release, deployment or installed-device changes.

### Grill With Docs round 3 — H12–H18 (2026-10-21)

**Owner accepted H12=A, H13=A, H14=A, H15=A, H16=A, H17=A and H18=A.** Applies to one headed Windows Chrome/Edge automation session, not implemented behavior.

- **H12=A — activity source:** Prefer positively observed Playwright page click, keyboard, scroll and user-originated navigation as human idle activity, **without logging input values, password content or raw keys**. No Windows-global input hooks. Address-bar/browser-chrome activity may not be observable, and page-script events do not prove human presence. Unobserved or untrusted events cannot automatically extend a session. Concrete event-integrity criteria still require acceptance evidence.
- **H13=A — expiry without popup:** At 30 minutes of actual inactivity, automatically close Agent-owned browser session even during Human Control; retain its family-specific Profile and existing operation receipts. Subsequent status must explain idle expiry. No special warning overlay; timeout does not prove website action cancellation.
- **H14=A — reobserve on resume:** On owner-directed return to Agent Control, all pre-Human-Control page snapshots and element references become stale regardless of unchanged URL. Require fresh page observation before new element-targeted effects. Resume does not authorize a high-impact website action.
- **H15=A — Unknown allows takeover:** A pre-handoff admitted action reaching its bounded timeout retains truthful Unknown Outcome; report it and permit human takeover, not indefinite waiting. Never replay, silently retry or assert external effect reversal. After owner resumes, reobserve before acting.
- **H16=A — Agent restart:** Do not automatically attach to leftover Chrome/Edge processes or Profiles. Verify owned process exited and Profile is safe before creating a new session; if ownership/lock is uncertain report conflict rather than deleting data, killing unrelated browsers or adding CDP reconnect mechanisms.
- **H17=A — Windows lock mid-session:** Suspend admission of new Agent page/browser actions when desktop becomes locked/unavailable; do not immediately terminate the current session or silently switch to headless. Continue 30-minute idle accounting; preserve bounded in-flight and Unknown receipts. Unlock behavior remains open.
- **H18=A — resume identity boundary:** Require explicit owner instruction in ChatGPT through existing authenticated Remote Control MCP, scoped to actual device/session, to restore ordinary Agent Control. No new approval service or local confirmation overlay. Existing MCP identity is **not independent proof of human presence**, and resume is **not** one-use high-impact website approval. Page content, model claims or generic bearer possession cannot authorize consequential/ambiguous effects; the existing fail-closed gate remains.

**Unchanged architecture and release constraints:** single Node.js Agent + one Playwright backend + existing Portal/DO/WSS/SQLite; separate private Chrome/Edge Profiles, one active session/device, no desktop-wide keylogger, second runtime, browser service, approval backend or database. All five browser MCP tools remain disabled; documentation only, with no merge/release/deployment/installed-Agent upgrade.


> **Current owner decision (P9, 2026-10-21):** Goal A (personally paired native Windows Chrome) is explicitly selected. The owner accepts residual public-page/redirect access to host loopback and LAN; **strict SSRF containment is NOT a Goal A release prerequisite and is NOT achieved**. Historical P6/P8 network hold/pending-choice language below is superseded *only on that point*. Existing confirmed high-impact action approval, browser MCP E2E, installed release and separate production enablement remain blocked. See [ADR-0030 P9 amendment](./adr/0030-browser-conservative-gating-consent-evidence-acceptance.md#p9--owner-approved-goal-a-risk-boundary-2026-10-21).

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


## P6 selection gate — redirect, private-network egress and owner approval (2026-10-21)

**Status: review finding and test plan; NOT a new accepted architectural decision, implementation, or release authorization.** This section supersedes any inference that P5 context routing provides browser-wide SSRF isolation. Evidence: [real Windows Chrome redirect failure](https://github.com/lirtual/remote-control-agent/actions/runs/39520350950) (public-looking 302 to loopback: attempted=1, blocked=0, local HTTP hits=1), followed by [corrected cross-platform CI](https://github.com/lirtual/remote-control-agent/actions/runs/39520949704) (direct local image denied). Agent Draft [#20](https://github.com/lirtual/remote-control-agent/pull/20) / Worker Draft [#143](https://github.com/lirtual/mcp-workers/pull/143) / docs Draft [#117](https://github.com/lirtual/mcp-workers/pull/117) remain unmerged. The five Worker browser MCP tools remain **disabled**.

### Problem, existing boundary and candidate selection

Goal A is **personal, paired-device browser control**, reusing Portal, signed WSS, existing Agent, SQLite receipts, private automation Profile and already-installed Windows Chrome. Goal B is **hostile-page / private-network egress containment**. A device trusted to execute authorized Shell commands is **not** equivalent to a website or redirected target being trusted. Do not relabel Goal B as achieved, nor silently weaken ADR-0030's Q37/Q41/Q49 effective-target requirements simply because Goal A uses a trusted host.

| Candidate | Existing capability | What it does NOT prove | Added complexity / decision |
| --- | --- | --- | --- |
| **A — current Playwright Context route + URL checks** | Blocks directly intercepted local first-hop/subresources; simple, no new dependency | Real 302 bypass **observed**; cannot pin DNS, cover all WebSockets or pre-hook Profile traffic | **Retain only as hygiene**; cannot unblock navigation |
| **B — Chrome Local Network Access (LNA)** | Chrome's built-in origin-to-local/loopback permission protection may add defense in depth | Browser/version, navigation/redirect and permission-state details matter; not process-level universal egress policy; cannot explain away the observed local hit | **Observe/test only**; no assumed release guarantee or required new Chrome policy |
| **C — CDP Fetch interception** | DevTools protocol documents redirect-related request-paused events | Still no proven resolved-IP binding, browser-wide WebSocket/non-HTTP coverage or earliest Profile startup egress | **Do not introduce now** merely to fix one failing 302 test; reconsider only after a bounded negative experiment and a demonstrated complete threat-boundary need |
| **D — process/OS firewall or enforcing network proxy** | Potential enforcement at the effective destination, including resolved IP | Per-platform privilege, DNS/IPv6, proxy bypass, browser subprocess ownership, recovery, maintenance and compatibility still require genuine proof | **Defer to Goal B**, not a default Windows-first dependency |

Source contracts: [Playwright Network](https://playwright.dev/docs/network), [CDP Fetch.requestPaused](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/#event-requestPaused), [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access). Sources document **mechanisms**, not successful containment of this Agent.

### Scope/approval checkpoint (not yet accepted)

1. **Current default = hold**: do not enable `browser_navigate`, other browser MCP tools, or production browser networking because neither effective-target containment nor an approved change of trust/risk scope has been demonstrated. Keep directly intercepted URL checks, Service Worker block, separate Profile, and non-replay receipts; none constitute a sandbox. Do not introduce a new Worker, broker, auth service, DB, binary or required OS firewall for a disabled Draft.
2. **If Goal A deliberately accepts the host's existing network exposure**, record that as an **explicit owner-approved change** to the Q49/Q37 threat boundary: public web content and redirects may reach services available from the Agent host and may trigger unintended effects. This is not implicit in pairing, a generic tool invocation, or previous permission to test. Define permitted page classes and operational consequences before revising the accepted ADR. Until then preserve the stricter existing gate.
3. **Navigation is effectful** even when expressed as GET. Existing Portal ownership/Ed25519 proves caller/device authorization, and `operation_id` prevents replay; neither proves a human approved this **specific** navigation or website effect. Any approval scheme must be verified through a *real supported ChatGPT → MCP → Worker → Agent* path, bound to owner, device, session, tab, operation ID, effective target and material arguments, consumed once and invalid after change/replay. Tool annotations, model-conversation `yes`, and unverified MCP elicitation capabilities are insufficient. If no enforceable channel is observed, consequential and ambiguous operations remain disabled; no replacement approval service is authorized.

### Smallest falsifiable next checks and stop condition

- **Read-only capability/contract check:** inspect actual ChatGPT client/Worker tool approval evidence, including what reaches Agent and what binds it to one operation. No mutation of a live device or browser-tool enable flag. Result is **verified or unavailable**, not guessed.
- **Disposable Windows traffic fixture** *only if a specific candidate warrants code*: local controlled HTTP redirects (top-level and subresource, 302/307), public-looking name resolving to loopback/private (including changed DNS answer), IPv4/IPv6, WebSocket and pre-context-start egress. Observe **server-side hits** and actual remote addresses, not merely route callback counts. No production tokens, local admin ports, existing Chrome Profile or persistent firewall/proxy modifications.
- **Required for a claimed strict-private-network PASS:** private/loopback endpoint hit count **zero across all in-scope cases**, including changed destination and non-HTTP channels, while ordinary approved public browsing still succeeds; repeat on the exact native Windows Chrome/Agent package. Anything unobservable, bypassed, or version-dependent is **NOT ACCEPTED**. A passing 302 case alone does not satisfy the gate. No claim of acceptance from unit/CI alone.
- **Stop** if achieving Goal B would require stacking CDP + custom DNS + privileged firewall/proxy + a new runtime. Return to the owner risk-scope decision and compare one established OS/network boundary against honest Goal A limitations rather than piling on mitigations. Cross-platform and production release decisions remain separate.

**Current P6 conclusion:** zero additional entities selected, zero network-isolation success claims, zero new MCP tool exposure. Only the above review/validation plan is ready; actual policy acceptance, one-use user confirmation, browser MCP end-to-end activation and deployment are pending.


## P7 verified approval-transport capability audit (2026-10-21)

**Stage: audited API/source contract, NOT a verified human-presence flow or an accepted new design.** Source pinned to Agent [Draft PR #20](https://github.com/lirtual/remote-control-agent/pull/20) `150b705` and Worker [Draft PR #143](https://github.com/lirtual/mcp-workers/pull/143) `f30f66a`; cross-repository source review only, not a ChatGPT-client E2E experiment.

### Concrete evidence through existing components

| Boundary | Evidence from the pinned Draft source | Result for action-specific approval |
| --- | --- | --- |
| ChatGPT host → MCP tool | OpenAI documents ChatGPT tool confirmation and configurable app preferences; a tool-level approval may even be remembered for the same conversation. Tool annotations affect client handling but are **not server authorization**. | Host-side confirmation might happen, but does **not itself supply an independently verifiable one-use approval artifact** to this server. |
| Worker `initialize` | `apps/remote-control-mcp-worker/src/worker.ts` advertises only `capabilities: {tools:{listChanged:false}}`; no elicitation client-capability negotiation, request, or approval token handling occurs in this route. | No proven live ChatGPT elicitation/approval transport. |
| Public `browser_navigate` tool | `src/browser-tools.ts` accepts precisely `device_id`, `operation_id`, `session_id`, `url`; rejects unknown fields. | No approved action digest, target binding, nonce, proof issuer or expiry is transported. |
| Worker → DO → authenticated WSS | `v2-pairing.ts` frames carry `tool`, `arguments`, `operation_id`, `request_id`, using already-paired device session checks. | Device connection/authentication and non-replay are reused; neither communicates a user approval decision. |
| Agent acceptance | `browser-operations.ts` parses session/URL and invokes the backend through existing SQLite receipts; no human approval verifier. | `operation_id` deduplicates execution but cannot prove human authorization. |
| Public activation | `worker.ts` has `BROWSER_TOOLS_ACCEPTED = false`; calls are not advertised/handled. | **Safe disabled gate preserved**, not an end-to-end browser approval test. |

**Official capability distinction:** [OpenAI custom MCP guidance](https://developers.openai.com/api/docs/guides/custom-mcp-server) describes host approval that may be remembered in a conversation; [OpenAI Plugin tool guidance](https://developers.openai.com/plugins/plan/tools) explicitly says annotations are not authorization; [MCP Elicitation specification](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation) requires **client capability advertisement** and an authenticated user context; [MCP TypeScript SDK elicitation](https://ts.sdk.modelcontextprotocol.io/v2/servers/elicitation) shows how server-driven user input works when supported. `elicitation/create` and its `accept` response are **not a signed one-use proof by definition**, and URL-mode elicitation is not an implicit approval backend. ChatGPT support for the *specific client/plugin/protocol path* and a server-verifiable action binding remain **unverified**.

### Minimal decision and validation gate

- **No new implementation selected.** Do not add an `approved: true`/user-entered code tool field, a model-callable `approve_action` that could authorize itself, a new approval Worker, a second Portal, or a new database. The existing Portal owner credential alone is not specific human consent for a proposed website action.
- **If future client capabilities allow:** in a disposable, authenticated non-production connection, prove the exact `initialize`/client capability exchange and a server-originated action-specific elicitation challenge that cannot be fabricated from ordinary tool arguments. Bind identity, device, session, tab, operation ID, intended effective destination and material parameters; expire and consume exactly once; reject denial, timeout, reuse, mismatched URL, and changed redirect target. Inspect the actual server receipt of the client decision; never assert support from documentation alone.
- **If no supported client signal:** leave consequential and uncertain website effects disabled. An independent **local-owner Windows confirmation** is a possible later feasibility candidate using the existing Agent (no new cloud service), but its UX and exact user binding must first be evaluated; it is **not approved or implemented**.
- **Keep network gate independent:** consent to an action is **not consent for arbitrary internal destinations** reached via redirect/DNS/WebSocket, and it is not a substitute for an explicitly decided trusted-host risk policy. P5's real redirect-to-loopback server hit remains a launch blocker under the current policy.
- **Stop condition:** fail closed if exact user identity, proposed-action parameters or one-use enforcement cannot be proved at the execution boundary. Do not implement a separate confirmation platform merely to resolve a disabled Draft. No merge, release, installed Agent update or production tool enablement follows from this review.

**P7 result:** the current Agent/Worker source does *not* implement or prove the ADR-0030 confirmation contract. Existing authentication and durable receipts are reusable but insufficient. No client E2E proof, feature work or security-policy weakening has been claimed.

## P8 current-MCP protocol review and trusted-device choice (2026-10-21)

**Result: source/standards review and a pending owner decision, not network acceptance or activation authority.** This explicitly updates P7's legacy-only elicitation discussion; the `2025-11-25` reference remains correct for *this Worker*, but is not the latest MCP protocol.

### Version and client-evidence correction

- The published [MCP specification 2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/) removes `initialize/initialized` and the protocol session: client capabilities travel in request `_meta`; `server/discover` replaces the old handshake for discovery. [MCP elicitation 2026-07-28](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/client/elicitation.mdx) uses `InputRequiredResult` with `inputRequests`, `inputResponses` and `requestState` (Multi Round-Trip Requests), not only legacy synchronous `elicitation/create`.
- **Actual staged Worker `apps/remote-control-mcp-worker/src/worker.ts`:** default `PROTOCOL_VERSION = "2025-11-25"`, and `SUPPORTED_PROTOCOL_VERSIONS` are exactly `2024-11-05`, `2025-03-26`, `2025-06-18` and `2025-11-25`. It exposes a manually implemented legacy `initialize` and no modern `server/discover` / `input_required` flow. Consequently, do not assume a modern 2026 host can negotiate this Worker on the new wire format without compatible fallback. **No actual client handshake was captured here.**
- ChatGPT [plugin documentation](https://developers.openai.com/plugins/build/mcp-server) supports *elicitation as a concept* and calls for confirmation of consequential actions, but does not by itself establish which wire revision, elicitation callback or per-action approval attestation the **current connected plugin/client** presents. Its [tool approval UI](https://developers.openai.com/plugins/reference) may withhold UI `toolInput` until a host-approved call; that notification is a widget lifecycle event, **not** a signed Agent-readable human approval receipt.
- [MCP TypeScript SDK protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions) distinguishes the legacy handshake era and the new request-metadata era. **Do not upgrade the entire Worker or add an SDK dependency merely to unblock browser navigation**. First capture a real compatible client's version, capabilities and behavior on a disposable non-production connection, then compare a minimal legacy-compatible path to an intentional modern-protocol migration with all current MCP tools regression tested.

### Risk boundary: concrete choice still pending

| Scope | Legitimate benefit | Residual risk | Recommendation |
| --- | --- | --- | --- |
| **Goal A: owner-trusted Windows host, normal browser trust model** | Reuse existing paired Agent and installed Chrome, no additional proxy/OS sandbox | An untrusted public page/redirect may reach the host's loopback/LAN; P5 **confirmed** a loopback HTTP hit despite Playwright route hygiene. Website navigation may have side effects. Host trust does **not** imply page trust. | Plausible only with **explicit owner acceptance** of this residual egress risk, plus narrowly scoped actions and independently verified action confirmation. Do **not** silently reinterpret ADR-0030 Q49. |
| **Goal B: strict private-network egress isolation** | Deny sensitive destinations even when hostile redirects/DNS/WebSockets target them | Requires actual browser-wide/process-level controls verified against redirect, DNS, IPv6, WebSocket and startup traffic | Retain **NOT ACCEPTED**. No CDP+DNS+firewall+proxy stack without a demonstrated, maintainable enforcement boundary. |

**Current decision:** remain at the existing **hold** gate; no implicit Goal A risk acceptance, no Goal B claim, and no reinterpretation of user permission to develop/test as permission to expose production browsing. Five browser tools stay disabled. No need to introduce a new browser Worker, confirmation backend, database, SDK, universal profile manager or network-proxy layer at this point.

### One falsifiable next gate, with stop conditions

1. **Client capability probe, only via a genuinely disposable authenticated endpoint** (not the published Remote Control plugin): record wire protocol version and actual advertised elicitation support; verify that a server-originated *specific* challenge, denial/cancel, parameters changed between rounds and repeated response are handled fail-closed. A simulated client or static spec is not ChatGPT acceptance. The proof must exclude model-supplied `approved:true` and require the server to bind authenticated caller + device/session/tab + operation ID + material target to one use through an existing receipt/transaction boundary.
2. **Do not yet build it**: without an actual supported client signal, do not introduce extra approval plumbing. A locally interactive Windows-owner prompt remains only a separately assessable alternative, with UI/session limitations explicitly considered.
3. **Independently resolve the network policy**: if owner does **not** accept Goal A's egress exposure, pause navigation until a single effective-destination enforcement boundary demonstrates zero internal test-server hits (including redirects/DNS/WebSocket). Confirmation cannot substitute for this control; likewise network isolation cannot prove human consent.
4. **Stop and return to selection** if a proof needs additional services or cross-platform protocol migration solely to pass a first-stage browser tool. No real site login, durable Agent profile change, Worker flag change, merge, deploy or release is authorized here.

**P8 verdict:** current legacy protocol/version verified; modern MCP elicitation mechanism documented; actual ChatGPT support, server-verifiable one-use approval and private-network safety are **unverified**. The minimal implementation plan stays unchanged pending owner risk-scope choice and one isolated client proof.

## P9 acceptance reconciliation — trusted Windows Goal A (2026-10-21)

**Owner decision, not a safety-test success:** The personally paired Windows device is allowed to operate as a normal owner-trusted machine. Web content remains *untrusted*. Explicitly accepted residual network exposure includes redirects, DNS rebinding, WebSocket attempts, HTML subresources and requests made before the Playwright route hook; Chrome may contact loopback, LAN or device-reachable internal services. P5 real Windows 302 result **attempted=1, blocked=0, localHits=1** stays recorded as **redirect SSRF isolation FAIL / risk accepted for Goal A**. The private-network zero-hit acceptance criterion belongs to Goal B only. Never re-label this as network isolation passing.

### What the first stage can and cannot do

| Surface / gate | Accepted Goal A boundary | Status / evidence |
| --- | --- | --- |
| Paired Windows and transport | Explicit device, existing Portal owner, Ed25519 WSS, Durable Object and SQLite operation receipts | Existing P3 isolated signed WSS read and independent compiled native Chrome startup **PASS as separate paths**; actual signed browser-MCP operation **not tested** |
| Browser local ownership | Single Agent-owned Chrome automation Profile; do not attach personal Chrome or import user profiles; context closing / revocation / no replay | P2/P3 real Chrome, disposable identity/profile and revocation checks provide existing evidence, but **not a newly installed production Agent** |
| Initial navigation hygiene | Reject malformed/unsupported schemes and obvious direct local/private initial inputs, preserve existing context route as defense-in-depth | Existing parser and direct subresource tests pass; **redirect/DNS/WebSocket isolation NOT provided** |
| External effect authorization | `browser_status`/`browser_snapshot` observational; `browser_start`/`browser_close` are owner-scoped lifecycle effects; **`browser_navigate` remains effectful**, not automatically read-only for any arbitrary URL | No verified ChatGPT→Worker→Agent action-specific human approval attestation. Consequential/ambiguous effects **disabled** |
| Powerful interactions | No arbitrary JS/CDP, personal Profile, click/fill/keyboard/submit/upload/download tools in first five | Staged tools still `BROWSER_TOOLS_ACCEPTED=false` |
| Platform/release | Windows-first; Linux/WSL/macOS browser rollout independent | CI and separate P3 Windows acceptance are **not** a published installed/pinned release |

### Minimal nonproduction acceptance path (no new infrastructure)

1. **Source/negative verification now:** verify the five-tool schema, exact device/session/operation IDs, malformed/direct-private URL rejection, disabled `tools/list` and denied `tools/call`, no arbitrary commands or Profile fields. Reuse existing checked-in P4/P5 tests and evidence unless changed. Do **not** use a public user-owned internal service as a test target.
2. **Private browser lifecycle validation:** on the already owner-approved Windows test host, only from a disposable TEMP Profile/identity, reuse verified packaged BrowserManager evidence for start, public controlled test page, bounded snapshot, close, restart/revocation, clean process teardown. Keep original owner's Agent identity and scheduled task untouched; state exactly which segments were separately tested.
3. **User approval proof:** independently check actual client protocol and client-initiated server interaction on a disposable endpoint. Require an authenticated *server-verifiable*, action-bound, short-lived, one-use result that cannot be model-forged; test denial/expiry/modified URL/replay. If unavailable, **leave high-impact and ambiguous navigation disabled** and record unsupported. Do not upgrade the entire MCP protocol or invent an approval backend by default.
4. **Only after approval gate and separate test authorization:** run one authenticated, end-to-end *disposable* browser MCP call over actual Worker DO / signed WSS. The current Worker has the browser tool flag hardcoded **false**, which must not be overridden just to fake acceptance. This is a future isolated validation gate, **not permission now** to modify production or deploy.
5. **Stop:** if the plan grows to require an OS firewall, proxy, DNS layer, another Worker, persistent approval server or cross-platform packaging only to support this first phase, return to an explicit selection decision. Never conflate a disconnected fixture, successful CI, and installed-agent production activation.

**P9 status after documentation update:** Goal A network risk **explicitly accepted**; Goal B private-network isolation **not passed / not required for Goal A**; authentic one-use user confirmation **unverified**; browser MCP actual signed E2E **unverified**; all three PRs still Draft and browser tools disabled. No merge, deploy, publication or installed Agent upgrade.

### P9 executed read-only checks (2026-10-21)

- **Source-only inspection 10/10:** current Worker Draft has `BROWSER_TOOLS_ACCEPTED=false`, conditional exclusion from `tools/list` and dispatch, only five atomic browser tool descriptions, required identity/operation fields and HTTP(S) first-hop parsing. Current Agent Draft uses an Agent-private Profile, blocks service workers, explicitly disclaims redirect-hop isolation and preserves SQLite receipt admission/unknown results. These are *source assertions*, **not** 10 automated runtime security tests.
- **Paired device availability:** current Remote Control device listing shows the native Windows paired entry `71b4b4d8-6496-4898-9b80-1ea3a03f6ccd` online and the separate WSL2 entry `af666663-b30c-4b3d-ad85-c8047dc3516b` online. This validates device presence only, **not** BrowserManager availability or a browser-tool E2E.
- **Reusable native evidence:** P3's existing disposable Windows Chrome Profile/Snapshot cleanup and separate real signed DO/WSS local read remain the relevant acceptance evidence. P5 direct local HTML subresource protection was proven on Windows; redirected loopback HTTP traffic actually reached the test server. Those paths are not one browser MCP round trip, and have **not** been rerun for this docs-only decision.
- **No production changes:** source/CI evidence remains pinned to unchanged Agent/Worker Draft runtime code. Only documentation/PR description updates have occurred for P9, not a new Agent binary install, Worker tool enablement, browser process start, CI security run or production server action.
- **Important limitation:** existing user-authorized Remote Control Shell has the host account's network access regardless of browser-tool restrictions. This Goal A design protects the **browser tool interface and automation Profile ownership** only; it is not an OS-wide boundary preventing commands issued through already-authorized Shell.

**Remaining unpassed gates:** real action-specific ChatGPT human approval proof; real signed browser MCP call on a disposable Windows identity; separately reviewed packaged/release install and rollback; explicit later approval to enable production. No inference of zero local-network requests is made or required for owner-selected Goal A.


## P10 negative permission-gate verification (2026-10-21)

**Stage: isolated Worker request-parser/handler regression proven, human-confirmation acceptance still UNVERIFIED.** On the owner's **WSL2 development device** `af666663-b30c-4b3d-ad85-c8047dc3516b` (not the paired native Windows target), tested the actual Worker Draft branch without touching a production Worker, browser, identity or service. The source was fetched at `d83b6fe` into a disposable `git archive` directory and ran under local Node 22.21.0; the temporary directory was removed on completion.

| Test / source | Result | Meaning and strict limit |
| --- | --- | --- |
| Disposable browser argument-parser + static gate checks against `d83b6fe` | **19/19 PASS** | `approved`, `confirmed`, `approval_token`, `user_approved`, extra scripting/Profile fields, missing IDs, unsupported/private first-hop URLs rejected; basic source gate still off. Parser/static assertions are not network or consent proofs. |
| Disposable **real `worker.fetch` function** with synthetic owner bearer and fake DO | **10/10 PASS** | Legacy `initialize`, `tools/list` omission, all five `tools/call` denials, forged `approved=true` / `confirmation=yes` denial, **DO forwards = 0**. This is a local request-handler fixture, not ChatGPT client and not Cloudflare production. |
| Persisted regression tests in Worker Draft PR #143 | [`a4414e9`](https://github.com/lirtual/mcp-workers/commit/a4414e9d33b9f52efff8a1384d3879e0d9173568), **5/5 targeted tests PASS** in clean WSL archive | Added spoofed-consent parser/DO negatives and disabled tool-call coverage for all five browser names. Production `src/worker.ts` and `BROWSER_TOOLS_ACCEPTED=false` **unchanged**. Not a full monorepo CI or real signed browser E2E claim. |

**Official platform boundary:** [OpenAI's MCP server guidance](https://developers.openai.com/plugins/build/mcp-server) says safety annotations help confirmation but do not replace server-side authorization; [ChatGPT plugin UI reference](https://developers.openai.com/plugins/reference) describes post-approval `ui/notifications/tool-input` delivery to widgets, which is **not an Agent-verifiable one-use approval proof**; [OpenAI's API MCP approvals](https://developers.openai.com/api/docs/guides/tools-connectors-mcp) is a distinct host-to-remote-server data-sharing approval flow and must not be presumed available as a specific ChatGPT plugin approval token. The published [MCP 2026-07-28 specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/) supports multi-round-trip user input, but current Worker supports only earlier protocol revisions. Do not upgrade protocol or add an approval backend merely to claim human approval support.

### Decision / narrow next gate

1. Keep **Goal A owner-approved residual network exposure** distinct from action authorization; browser content and redirected destinations remain untrusted. There is **no private-network-isolation PASS**.
2. Keep the minimal five-tool design and disabled flag. `browser_status`/bounded `browser_snapshot` and Agent-owned start/close are separate lower-risk lifecycle candidates, not permission to unlock arbitrary `browser_navigate`. Website navigation may cause effects; consequential or unclassifiable targets stay disabled without enforceable, action-specific owner consent. No new click/fill/submit/JS/CDP input surfaces are accepted.
3. A **real supported ChatGPT client → test-only MCP endpoint** must demonstrate a server-originated request for the exact proposed effect and an identity/target/nonce-bound, one-use result verifiable at execution. It must reject deny, timeout, reuse and changed material URL. **This test has not happened**; existing plugin connector tool approvals, mock Worker tests and previous chat “yes” are not substitutes. Determine actual client capability before proposing implementation or migration.
4. If the existing client/Agent cannot support that proof at reasonable complexity, stop and explicitly reconsider the low-risk browser scope rather than layering a confirmation portal, new Worker, database or firewall. Next real-browser E2E and install/upgrade rollout require separate authorization and remain blocked.

**P10 typecheck limits:** isolated Worker production TypeScript `tsc --noEmit -p tsconfig.json` **PASS** on the updated `a4414e9` source snapshot. The broader `tsconfig.test.json` check was **not completed** because the disposable archive intentionally excluded the separate Agent test-fixture source files (TS2307 missing cross-repository modules, followed by implicit-any errors). Do **not** call that broad check PASS or attribute it to the new approval test. No second dependency tree or Agent installation was created to work around this fixture limit.

**P10 PR CI follow-up:** GitHub Actions [run #39525669190](https://github.com/lirtual/mcp-workers/actions/runs/39525669190), for Worker Draft commit `a4414e9`, **CI completed SUCCESS**. The **Application checks** job succeeded including staging the pinned public Agent test fixture and running affected application checks. **Database integration** and **Manual selected Worker release** jobs were **skipped**. This is independent CI evidence for the Draft test addition; it is **not** a production publish, a browser MCP signed real-device run, or a ChatGPT user-confirmation acceptance.

**P10 checkpoint:** source/test hardening completed and repeatable; confirmed human-approval transport **NOT PROVEN**; no production tool exposure, code deployment, Agent upgrade, PR merge or network isolation assertion.

## P11 annotated risk and protocol boundary (2026-10-21)

**Outcome: minimal source metadata correction plus local protocol contract tests; NOT a live ChatGPT confirmation experiment.** The owner-selected Windows Goal A remains the active risk model, with the network-exposure risk accepted and with consequential/uncertain external actions gated by real user approval. All browser tools remain disabled on the production MCP surface.

### Exact changes to Worker Draft PR #143

- [`cb15d8a`](https://github.com/lirtual/mcp-workers/commit/cb15d8acca0606f8dbcbd921022dd413c245d857) corrects **only staged tool descriptors**: `browser_navigate` is `readOnlyHint=false`, `destructiveHint=true`, `openWorldHint=true` because even GET navigation may cause irreversible website effects; `browser_close` now explicitly warns of unsaved page state loss and uses `destructiveHint=true`. `browser_status` and `browser_snapshot` explicitly declare `destructiveHint=false`. `browser_start` remains a non-read-only, non-destructive local session-start operation. All five expose explicit booleans for `readOnlyHint`, `destructiveHint` and `openWorldHint`.
- [`091eca8`](https://github.com/lirtual/mcp-workers/commit/091eca8f421e3126bcdc6174ac5ca471704e6e21) pins these exact annotations as a regression test. **Annotations are advisory host UX, not authorization or proof of single-use consent.** [OpenAI plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines) require explicit truthful values; the [MCP maintainers' tool annotation review](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/) cautions against treating these hints as enforcement.
- [`ca6f383`](https://github.com/lirtual/mcp-workers/commit/ca6f3830be8a832605969ce7ebbde0cae52d0bce) pins legacy protocol behavior: an isolated client-shaped `initialize` requesting `2026-07-28` and `capabilities.elicitation` still returns only `2025-11-25` with `{tools:{listChanged:false}}`. This checks the **existing local Worker handler**, not a real ChatGPT client connection, and does not prove 2026-07-28 MRTR or trusted user presence. No protocol migration selected.

### Observed evidence and precise limits

| Validation | Result | Limit |
| --- | --- | --- |
| WSL disposable archive, Node 22, Worker Draft `ca6f383`, `node --experimental-strip-types --test tests/browser-tools.test.ts` | **7/7 PASS** | Local handler + parser tests only, no Cloudflare production or ChatGPT client |
| Worker source `tsc --noEmit -p tsconfig.json` with existing development dependencies | **PASS** | Isolated test configuration with full Agent fixtures not repeated this turn |
| Existing Client ↔ live plugin runtime negotiation / elicitation callback | **NOT TESTED** | Cannot infer support from public docs or synthetic `initialize` |
| One-use approval bound to signed Agent browser operation + execution effects | **NOT IMPLEMENTED / NOT VERIFIED** | Still blocks high-impact/uncertain operations |
| Native Windows production browser enablement, build/install or release | **NOT DONE** | `BROWSER_TOOLS_ACCEPTED=false`, Draft only |

**Complexity decision:** To verify actual ChatGPT client user input, a *separately authorized* disposable MCP endpoint/connection with non-production credentials is necessary; reusing the production Remote Control plugin as a test endpoint is not acceptable. Do not add a second worker, approval backend, auth provider, special browser binary, or persistent challenge storage solely to compensate for a currently unobserved client response. If the client's trusted server-visible approval signal cannot be demonstrated, **preserve the five-tool staging/deny gate and do not enable consequential or ambiguous navigation**, rather than pretending host confirmation is Agent-verifiable. Reuse P3 independent native Windows Chrome/DO signed evidence without combining it into a fictitious complete live browser E2E.

**P11 status:** two staged code-description changes, added tests, zero runtime or production behavior changes, no Client human-confirmation acceptance. Continue only with a realistic isolated client proof after separate permission to connect one; no merge, deploy, release, installed Agent upgrade, or production browser feature enablement.

**P11 CI and client-policy conclusion:** [Worker CI #39528200816](https://github.com/lirtual/mcp-workers/actions/runs/39528200816), for final Worker Draft documentation/metadata head `9eb5886`, completed **SUCCESS**. Earlier targeted protocol-test head `ca6f383` [CI #39527990459](https://github.com/lirtual/mcp-workers/actions/runs/39527990459) also completed **SUCCESS**, with application checks passing and manual worker release skipped. This is source/CI acceptance, not a real ChatGPT elicitation callback.

Host confirmation settings may allow automatic approval of tool calls, including mutating ones. Consequently **no host UI confirmation choice or tool annotation may be treated as Agent-verifiable per-action human consent without actual client/transport proof**. Keep user-specific app permission settings out of public repository files and logs. The authorized owner risk acceptance for Windows/LAN exposure does not alter the high-impact action confirmation gate.

## P12 actual Windows session evidence and approval-channel selection (2026-10-21)

**P12 decision: NO new confirmation implementation selected.** The owner's Windows Goal A risk acceptance still covers possible host loopback/LAN network access by untrusted webpages, but does **not** waive action-specific verified consent for impactful/ambiguous website effects. Existing Drafts remain gated and unmerged.

### Real read-only device checks

- Connected native Windows paired device `71b4b4d8-6496-4898-9b80-1ea3a03f6ccd` via current Remote Control for read-only PowerShell session checks. Received **exit 0** and exactly `OS=Win32NT`, `USER_INTERACTIVE=True`, `SHELL_SESSION_ID=1`, `EXPLORER_SESSION_IDS=1`, `TASK_STATE=Running`. This proves a live interactive user session, not that any browser approval popup is visible or that a human approved something. No window/UI prompt was created.
- Reviewed current Agent Draft `apps/remote-control-agent/scripts/windows-user-task.ps1`: task uses `New-ScheduledTaskPrincipal -LogonType Interactive -RunLevel Limited`, a user-owned, no-window executable and the existing scheduled task. [Microsoft TASK_LOGON_INTERACTIVE_TOKEN](https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype) requires a logged-in interactive session; it does not attest a person clicked a specific button.
- The native Windows Shell tool itself completed the check in the **same session as Explorer**. With the user's already-authorized full Shell ability, a plain Windows Yes/No popup or same-account file marker cannot distinguish an independently acting human from software that can operate that desktop. This is a **trust-model limitation**, not a claim that every Windows UI is inherently forgeable.
- Read-only Windows Hello availability probe: the `Windows.Security.Credentials.UI.UserConsentVerifier` WinRT type resolves successfully, and `CheckAvailabilityAsync()` returns a `__ComObject` through the installed PowerShell. Plain PowerShell access did **not** expose an immediately readable async result (`Status` empty; earlier access returned `RuntimeException`), so **device Hello/PIN/biometric availability is UNKNOWN**. We neither requested a PIN/fingerprint nor showed any modal. Microsoft's [Windows Hello documentation](https://learn.microsoft.com/en-us/windows/apps/develop/security/windows-hello) describes `UserConsentVerifier` and challenge-response as possible mechanisms but they require real per-action binding and execution-boundary verification. No WinRT bridge, native DLL, new package or platform-wide dependency was introduced.

### Approval source comparison (explicit capability vs claim)

| Candidate | Observed capability | Verifiable human + exact one-use operation? | P12 outcome |
| --- | --- | --- | --- |
| ChatGPT tool approval/annotation | Tool hints and host permission preferences exist, and host approvals may be automatic | **No verifiable proof observed in the supported MCP→Worker→Agent payload** | **Not sufficient**; no reliance on ChatGPT display as an Agent-side authorization token |
| Existing Portal bearer + device WSS + receipt | Valid caller/device identity, authenticated transport, operation de-duplication | **No**; the current Portal auth module validates only Bearer/Origin, and Agent receipts do not attest human presence | **Reuse for transport and no-replay**, not human consent |
| Same-process Windows confirmation dialog | User-owned interactive task could potentially display one | **No independent person attestation** under same-user full Shell; lock/unattended/headless UX untested | **Reject as security proof**; do not implement a naive MessageBox |
| Windows Hello / secure user re-verification | Official OS API exists, Windows task is in a user session | **Not tested or available as a reliable Agent-bound primitive**; read-only availability probe inconclusive, platform complexity | **Defer**, don't add binary/Windows-only package or collect credentials |
| Curated first-stage safe operations | Only bounded session lifecycle/status/snapshot + narrowly controlled fixture navigation on a disposable profile | Does not purport to authorize arbitrary consequential web effects | **Preferred next nonproduction acceptance**, no approval service |

### Concrete next test without new infrastructure

Use a disposable, owner-approved native Windows Agent identity and automation Profile to verify the **existing five-tool** lifecycle against a deterministic controlled public test fixture: start → status → one controlled HTTP(S) fixture navigation → bounded snapshot → close → repeated operation ID and receipt-state reconciliation → revocation/cleanup. Keep provenance precise: an actual Worker/DO/signed WSS **browser** end-to-end test is still **NOT DONE**, while existing P3 showed separate signed `read_file` and local real Chrome segments. The test-only URL must have no account/credential or consequential backend action; do not substitute personal websites or LAN services. **No public browser tool exposure, production Worker flag change, installed Agent upgrade, merge or deploy is authorized by this plan.** An isolated test route must be separately reviewed if the hardcoded gate prevents it; do not bypass the gate in deployed code.

Stop if accomplishing this requires a second runtime, user-confirmation service, popup broker, new database, a Windows Hello dependency just for a fixture, or global MCP protocol migration. For real consequential/uncertain webpage actions, do not proceed until a separately demonstrated actor-bound short-lived one-use approval channel is in place; otherwise remain disabled.

**P12 achieved:** real native interactive session verified; Portal and Windows UI trust limits established; OS secure-confirmation availability **not established**; consent transport still **UNPROVEN**; zero PR promotion/deployment/activation.
