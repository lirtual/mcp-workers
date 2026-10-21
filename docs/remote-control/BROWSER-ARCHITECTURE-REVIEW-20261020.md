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
