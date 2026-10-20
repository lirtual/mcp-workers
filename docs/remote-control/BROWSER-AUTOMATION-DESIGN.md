# Remote Control — Browser Automation Design (Grill With Docs)

Status: **rounds 1–13 recorded (Q1–Q52=A, 2026-10-20); design-tree convergence review completed, separate owner confirmation of shared understanding pending**. This document records decisions, not shipped behavior, authorization to implement, a release gate or a new development Ticket. The existing v1/v2 specs remain authoritative for their implemented scope. Do not infer that browser tools, native Windows browser automation coverage, or personal-profile access exist today.

## Goal

Allow a ChatGPT MCP client to operate a specifically selected browser on an already paired remote device, without introducing a second fleet, public CDP listener or general remote desktop access. Use the existing `lirtual/mcp-workers` Remote Control MCP routing and `lirtual/remote-control-agent` Agent boundary.

## Decision tree — accepted root (round 1)

| Question | Decision | Consequence |
| --- | --- | --- |
| Q1 — Product ownership | **A**: extend existing Remote Control MCP | Keep device identity, authenticated WSS/DO, dispatch and device revocation in existing Remote Control ownership; no separate browser MCP Worker |
| Q2 — Delivery order | **A**: independent automation browser first | Connecting to an owner's already-open Chrome/Edge and existing login profile is a later, explicitly scoped capability |
| Q3 — Product scope | **A**: browser only | No full desktop access, generic OS mouse/keyboard or native GUI control; browser page interactions and browser-scoped files are candidates |
| Q4 — Authorization | **A**: reuse device pairing, select browser target explicitly | Every browser tool is device-targeted; select browser session/tab as applicable. Pairing does not automatically authorize all personal browser profiles. Existing-profile access needs owner target authorization; sensitive external actions need an explicit confirmation boundary |

See [ADR-0021](./adr/0021-browser-automation-extension.md) for the architectural trade-offs.

## Accepted execution and session choices (round 2)

| Question | Decision | Consequence |
| --- | --- | --- |
| Q5 — Automation engine | **A**: Agent integrates Playwright library directly | Expose only curated Remote Control browser tools. CDP can be an adapter detail, not the public contract. Do not run an independent nested Playwright MCP Server |
| Q6 — First platform targets | **A**: Linux and native Windows; WSL2 as Linux; macOS later | Platform-specific acceptance and packaging are independent. Current Linux-only Agent source/Windows preview history does not prove released native Windows browser support; WSL2 Linux is not a bridge to the Windows desktop |
| Q7 — Sign-in persistence | **A**: separate persistent local automation profile | Local cookies/sign-in can persist between browser sessions without reusing the owner's regular Chrome/Edge profile. Owner can clear the profile; detailed ownership, storage and clearing behavior are open |
| Q8 — Session lifetime | **A**: explicit reusable browser session with idle timeout | Stable session identity across MCP calls, explicit close and bounded idle cleanup. Lost responses/disconnects do not authorize automatic replay. Timeout value and offline/restart policy remain open |

See [ADR-0022](./adr/0022-playwright-managed-browser-sessions.md) for the browser engine, target-platform and local-session decisions. The detailed profile/session topology has not yet been selected.

## Accepted provisioning, exclusivity, and interruption choices (round 3)

| Question | Decision | Consequence |
| --- | --- | --- |
| Q9 — Browser provisioning | **A**: install a Playwright-version-compatible Chromium on demand if unavailable | Do not bundle a browser into every Agent release or depend exclusively on personal Chrome/Edge. Surface missing OS-level prerequisites without unattended privilege escalation. Download trust, layout and upgrade behavior still need design |
| Q10 — Profile concurrency | **A**: only one active browser session per profile | One session can have several tabs. Do not run simultaneous browser processes against the same profile; lock/race recovery is not yet designed |
| Q11 — Profile cardinality | **A**: one dedicated persistent automation profile per paired device at first | Keep sign-in state locally and support owner-triggered clearing; no initial multi-account profile manager or per-site automatic profile creation |
| Q12 — Disconnection/revocation | **A**: retain local session through brief caller disconnect until local idle timeout; no action replay; revoke cloud authorization promptly and best-effort stop online sessions | Reconnect requires explicit status read. Local cleanup cannot be guaranteed for an offline, stopped or compromised Agent; revocation does not implicitly erase retained local profile data |

See [ADR-0023](./adr/0023-browser-runtime-profile-interruption.md). These do not prescribe exact idle limits, browser display mode or recovery mechanics.

## Accepted interaction defaults and approval boundary (round 4)

| Question | Decision | Consequence |
| --- | --- | --- |
| Q13 — Idle lifetime | **A**: 30 minutes without activity | Agent-local browser session/process becomes eligible for cleanup; retained automation profile and sign-in state survive. Exact activity accounting and offline cleanup timing are unsettled |
| Q14 — Display mode | **A**: headless by default; headed on request | Only use a visible browser when the selected device supports a usable graphical desktop; headed mode is not general remote desktop control |
| Q15 — Page observation | **A**: bounded semantic/accessibility/page structure first; screenshot on demand | Avoid unconditional image output for every interaction; use visual fallback when semantic structure is insufficient. Specific limits/secret handling remain open |
| Q16 — High-impact operations | **A**: explicit approval before each consequential external action | Ordinary navigation and form preparation may proceed; payment/purchase, send, delete and permission changes require action-specific owner confirmation. Page instructions or device pairing are not confirmation |

See [ADR-0024](./adr/0024-browser-observation-and-confirmation.md). No particular tool interface, consent plumbing, screenshot quota or action-classification algorithm has been approved.

## Accepted browser operation and remote-effect boundaries (round 5)

| Question | Decision | Consequence |
| --- | --- | --- |
| Q17 — Tool granularity | **A**: curated, minimal atomic browser tools | Single-purpose operations for browser sessions/tabs/navigation/observation/interaction; no generic unchecked browser-action dispatcher or arbitrary JS/Playwright execution. Exact first-release tool list and schemas remain open |
| Q18 — Element selection | **A**: semantic/accessibility-first with unique resolution | Prefer roles/names/labels/text; reject ambiguous, missing or stale matches and re-observe rather than guess/click. Fallback selector rules remain open |
| Q19 — File boundary | **A**: device-local upload paths and Agent-managed local downloads | Reuse existing Remote Control file operations for subsequent access/transfer as applicable; do not send complete browser file payloads through MCP by default. Local path permissions and cleanup remain open |
| Q20 — Action recovery | **A**: stable Operation IDs and Agent-local Receipts for potentially effectful browser actions | Lost response means query status, never automatically replay. A successful browser click receipt is not proof of the remote site's completed business effect. Exact receipt schema and reconciliation still need design |

See [ADR-0025](./adr/0025-atomic-browser-actions-and-receipts.md). These agreements do **not** approve individual tool names, exact locator syntax, file permissions, receipt algorithms or bypass of the Q16 per-high-impact-action confirmation.

## Accepted common workflow, tab identity, and approval scope (round 6)

| Question | Decision | Consequence |
| --- | --- | --- |
| Q21 — Initial capability groups | **A**: complete common browser workflows via curated atomic operations | First scope includes session/tab management, navigation, page observation, click/fill/select/keyboard, screenshot, and browser-scoped uploads/downloads; do not expose unrestricted scripting or all Playwright features. Final tool names and schemas remain undecided |
| Q22 — Tab identity | **A**: stable Tab ID, explicitly scoped to device/session | An exact `device_id`, `session_id` and `tab_id` identify a tab-dependent action. Navigation preserves the Tab ID, close invalidates it; tab index/title/URL are not substitutes. Restart and race semantics remain open |
| Q23 — High-impact confirmation | **A**: one-use approval bound to a concrete action and target | Approval covers the reviewed device, session, tab, action and material arguments only; material target changes require re-approval. Confirmation transport, expiry, and consumption/replay mechanics remain open |
| Q24 — Profile clearing | **A**: owner request with safe-state check | Clear retained local automation Profile data only when no active browser session or unresolved/unknown-effect operation exists; if safety cannot be established, refuse and report. Session close and device revoke do not imply deletion |

See [ADR-0026](./adr/0026-browser-capabilities-tab-and-approval-scope.md). These decisions do not select exact tools, introduce a new confirmation system, or make browser actions available in the deployed Agent.

## Accepted tool inventory, visual fallback, consent flow, and safe recovery (round 7)

| Question | Decision | Consequence |
| --- | --- | --- |
| Q25 — Atomic inventory | **A**: compact, complete curated tools | Session start/status/close; tab list/create/close; page navigate/semantic snapshot/screenshot; interaction click/fill/select/keyboard; local file upload/download-result access. Actual names, signatures and download initiation remain unselected |
| Q26 — Semantic fallback | **A**: bounded visual fallback from current tab | When semantic target resolution is insufficient, use a recent screenshot bound to the explicit tab/page state and intended visible region; fail and re-observe on ambiguity or staleness. Never bypass high-impact approval or introduce arbitrary desktop control |
| Q27 — Confirmation protocol | **A**: prepare → owner confirm → execute, fail closed | Proposed high-impact action is not executable until an action-specific single-use approval is carried and validated by the execution boundary; if reliable confirmation is unavailable, refuse. The approval transport and cryptographic authority are not assumed to exist yet |
| Q28 — Crash/lock recovery | **A**: verify process ownership and operation safety first | Recover only after safely resolving process/Profile access and relevant uncertain actions; refuse ambiguous locks, no forced lock deletion, Profile wipe, switch or action replay |

See [ADR-0027](./adr/0027-browser-tools-visual-consent-and-recovery.md). These decisions are design boundaries, not a shipped tool API or a claim that today's ChatGPT client already supports independent verified confirmation.

## Accepted data, file authority, provenance, and platform boundaries (round 8)

| Question | Decision | Consequence |
| --- | --- | --- |
| Q29 — Page/privacy budget | **A**: minimal bounded task-relevant semantic output | Avoid routine extraction of passwords/cookies/tokens; screenshots on demand, may expose secrets and cannot be presumed redacted. No website allowlist. Numeric budgets/redaction/truncation behavior remain open |
| Q30 — Local files | **A**: reuse Agent OS account authority and existing file tools | Explicit local upload path; downloads land in Agent-managed directory, then use existing Remote Control file operations. No second browser file manager, path allowlist or additional privilege system. Permissions/collision/retention remain open |
| Q31 — Chromium provenance | **A**: pinned Playwright-compatible browser from trusted verified source | Validate genuine available provenance/integrity evidence; fail clearly on offline absence, missing trust, corruption or mismatch. Never invent checksums, silently fallback to untrusted sources or execute unknown builds. Specific upstream artifact/verification scheme remains open |
| Q32 — Platform acceptance | **A**: independent platform-specific real acceptance and staged enablement | Linux, WSL2 and native Windows must each substantiate browser startup, interaction, file transfer, reconnect, authorization, upgrade compatibility. Reuse unchanged prior evidence where relevant; pass on one platform need not block another. Release gates remain open |

See [ADR-0028](./adr/0028-browser-data-files-provenance-platform-acceptance.md). The privacy, supply-chain and platform commitments are design choices, not proof of deployed capability, tested compatibility or availability of source-provided integrity metadata.

## Accepted results, effect reconciliation, download retention, and capability gating (round 9)

| Question | Decision | Consequence |
| --- | --- | --- |
| Q33 — Tool result contract | **A**: shared minimal structured result | Identify device/session and required tab, status/error, bounded task-specific payload, truncation and effectful `operation_id`. Exact field schema/transport remain open; no raw Playwright objects |
| Q34 — Browser vs website outcome | **A**: separate Agent action receipt from read-only website-effect evidence | Click dispatch/execution does not establish website commit; unknown outcome stays unknown and cannot trigger automatic replay. Actual state machine and evidence contract remain open |
| Q35 — Managed download cleanup | **A**: seven-day default retention for unreferenced files | Cleanup only Agent-managed browser downloads, never active/unresolved referenced files or other host/Profile content. Owner may explicitly manage downloaded files via existing tools; reference tracking and race behavior remain open |
| Q36 — Enablement under missing confirmation support | **A**: independently enable verified safe low-impact capabilities while high-impact operations remain disabled without enforceable one-use approval | No downgrade of high-impact effects to ordinary clicks. Precise safe subset and ambiguous-action classifier are open; production rollout needs later owner authorization and platform evidence |

See [ADR-0029](./adr/0029-browser-results-outcomes-downloads-gated-release.md). This accepts design boundaries, not exact schemas, live website-effect guarantees, an installed confirmation channel or permission to ship. Representative unsafe assumption to reject: a generic `click` is not automatically low-impact just because the visible button label looks harmless.

## Accepted conservative action gating, real consent proof, receipts and acceptance (round 10)

| Question | Decision | Consequence |
| --- | --- | --- |
| Q37 — Uncertain side effects | **A**: conservative, positive low-impact classification | No safe-by-label or model-only decision; if a click/fill/keyboard/navigation can have material external effects and safety cannot be reliably established, fail closed for verified confirmation (or leave disabled). Exact safe subset remains undecided |
| Q38 — High-impact confirmation acceptance | **A**: require real ChatGPT→MCP→Worker→Agent end-to-end proof | Validate user intent and a single-use, unchanged action-specific approval at execution. If supported client transport cannot prove this, high-impact actions remain disabled; no new approval portal is selected. Exact mechanism and tests remain open |
| Q39 — Agent receipt lifecycle | **A**: reuse existing minimal local Operation ID/Receipt model | Represent known progress, browser-level completion/failure and Unknown Outcome as applicable; query/reconcile on interruption, never blind replay. Do not invent new state enum or external website ledger. Exact schema/transitions remain open |
| Q40 — Platform release gate | **A**: targeted real E2E per-platform acceptance | Cover launch, interactions, local file work, interruption/recovery, unauthorized/sensitive denial, permissions, upgrade/rollback, reusing unchanged evidence. Linux, WSL2 and native Windows may pass independently; no release authorization given |

See [ADR-0030](./adr/0030-browser-conservative-gating-consent-evidence-acceptance.md). Approval channel feasibility, result schemas and safe-subset details are not yet proven. These choices do not approve new tests, tickets, tools or deployments.

## Accepted initial safe surface, compact contracts, and local download references (round 11)

| Question | Decision | Consequence |
| --- | --- | --- |
| Q41 — Initially safe surface | **A**: conservative candidate low-impact subset | Status/list of sessions/tabs, bounded read-only semantic observation, and explicitly requested screenshots are initial candidates; navigation needs explicit target and effect-safety review, and no ordinary click/fill/keyboard/select is safe solely by tool name. Content, identity and read exposure still require authorization. Uncertain effects fail closed |
| Q42 — Atomic tool interface | **A**: minimal shared targeting/results | Explicit `device_id`, relevant `session_id` and `tab_id`; each tool has its own focused parameters. Results supply known status, errors, required data/truncation and effectful `operation_id` without universal complex envelopes or a generic action router. Exact schemas remain open |
| Q43 — Page observation budget | **A**: bounded follow-up reading | Initial default approximately **8,000 characters** in a semantic snapshot, explicit truncation, focused follow-up reads as needed; screenshots on demand, initially **one per request**. No routine credentials extraction; screenshots may still expose secrets. Image format and measurement details remain open |
| Q44 — Download reference tracking | **A**: reuse existing Agent-local session/operation metadata | Auto-delete after seven days only if the file is positively unreferenced; retain on unknown references or outstanding operations. Do not introduce another file index/database, bulk cloud transport or duplicate file manager. Exact reference/race implementation remains open |

See [ADR-0030](./adr/0030-browser-conservative-gating-consent-evidence-acceptance.md) for Q41, [ADR-0025](./adr/0025-atomic-browser-actions-and-receipts.md) for Q42, [ADR-0028](./adr/0028-browser-data-files-provenance-platform-acceptance.md) for Q43 and [ADR-0029](./adr/0029-browser-results-outcomes-downloads-gated-release.md) for Q44. No new ADR, feature code, runtime behavior, tickets or deployment is authorized by these decisions.

## Accepted browser URL, visual target, download path, and availability boundaries (round 12)

| Question | Decision | Consequence |
| --- | --- | --- |
| Q45 — Navigation/network destinations | **A**: ordinary HTTP(S) page navigation and separate review of sensitive destinations | Do not expose `javascript:`, `file:` or other nonordinary schemes as normal navigation. Loopback, link-local, metadata and sensitive internal/admin targets are **not automatically low-impact**; require explicit authorization and target/effect-safety review, without a global website allowlist. Redirect/DNS/subresource safety remains open |
| Q46 — Screenshot-derived target freshness | **A**: bind target to exact tab and page/viewport state | Navigation, tab change/closure, viewport change, scroll or material layout change invalidates old screenshot coordinates. On uncertainty obtain a fresh screenshot and locate again. Exact freshness signal, animations and races remain open |
| Q47 — Download name/path safety | **A**: local dedicated directory with safe names and no overwrite | Unique noncolliding names for downloads; reject outside-directory path traversal and symlink escapes. Website filenames cannot authorize arbitrary host overwrites; moving/replacing through existing explicit Remote Control file operations only. Windows path and atomic creation details remain open |
| Q48 — Client-facing availability | **A**: reuse device status and tool feedback, no new registry | Distinguish documented/planned, implemented, platform-accepted and presently enabled capabilities; report missing browser, unsupported platform, disabled action or missing verifiable approval with meaningful errors. Precise status vocabulary and tool advertisement remain open |

See [ADR-0030](./adr/0030-browser-conservative-gating-consent-evidence-acceptance.md) for Q45, [ADR-0027](./adr/0027-browser-tools-visual-consent-and-recovery.md) for Q46, [ADR-0028](./adr/0028-browser-data-files-provenance-platform-acceptance.md) for Q47 and [ADR-0029](./adr/0029-browser-results-outcomes-downloads-gated-release.md) for Q48. No new ADR or implementation authorization follows from these choices.

## Accepted navigation revalidation, minimal logging, expiring approval and convergence (round 13)

| Question | Decision | Consequence |
| --- | --- | --- |
| Q49 — Redirect and DNS destination changes | **A**: revalidate each effective navigation destination | Repeat scheme, network-address and sensitive-target review on redirects, changed host and relevant DNS/resolved-address changes; reject unknown or unapproved effective targets. Never trust only the initial URL. Subresource/iframe/service-worker and rebinding-race coverage still requires proof |
| Q50 — Page data and operational logs | **A**: no default persistence of sensitive page content | Routine logs/receipts retain minimal safe operation identity/status/error information, not DOM dumps, screenshots, passwords, cookies, tokens or full tool payloads. Page content remains untrusted and cannot authorize action. Requested screenshots may still expose private information |
| Q51 — One-use approval lifetime | **A**: short-lived, single-consumption, exact-action binding, only if verifiable end-to-end | Expired, used/replayed, changed target/parameters or unverifiable approval requires new confirmation; disconnect/restart cannot renew it. No numeric TTL or pre-existing verified client mechanism assumed; otherwise all high-impact effects stay disabled |
| Q52 — Interview and implementation boundary | **A**: converge design and request separate owner confirmation | Review all branches/ADRs for omissions, contradictions and overengineering; distinguish external evidence gates from decisions. Do not automatically create implementation Tickets, merge/mark-ready the Draft, run CI, change services or deploy. Final shared-understanding confirmation is **separately requested**, not assumed |

See [ADR-0030](./adr/0030-browser-conservative-gating-consent-evidence-acceptance.md) for Q49, [ADR-0028](./adr/0028-browser-data-files-provenance-platform-acceptance.md) for Q50, [ADR-0026](./adr/0026-browser-capabilities-tab-and-approval-scope.md) for Q51, and [ADR-0021](./adr/0021-browser-automation-extension.md) for Q52. No ADR-0031 is necessary for this round.

## Invariants carried forward

- Use the established authenticated device path and explicit `device_id`; never accept an arbitrary remote address or publish a CDP endpoint.
- Distinguish browser reads from effects. Do not claim that a lost response proves that an action did not execute; preserve existing `operation_id`/receipt semantics for effects, subject to later detailed design.
- Existing Remote Control v1 technical exclusions are historical release boundaries, not evidence of shipped browser support.
- Remote webpages are untrusted inputs, not instructions or authority to escalate tool privileges.
- Existing User Agent/browser personal credentials must not be copied to Cloudflare logs or MCP responses.
- Linux and native Windows are approved *targets*, not confirmed shipped capabilities: each requires platform-specific acceptance before release. WSL2 is a Linux runtime and its Agent cannot automatically control Windows desktop browsers.

## Design-tree convergence review — Q1–Q52

**Outcome of the design interview:** 13 rounds, **52 explicitly owner-approved A choices**, grouped in the accepted tables above and the existing ADR-0021–0030. The current **product-level decision frontier has no additional independent choice identified**. Do not create more Q-numbers solely to keep the interview running. This is **not** a claim that implementation specifications, runtime feasibility, validation or owner sign-off are complete.

**Cross-branch consistency check:**

- **Product and reuse:** existing paired Remote Control MCP/Agent/WSS path, one isolated persistent automation browser profile per device, Playwright library integration and atomic tools. No new browser MCP Worker/CDP gateway, remote desktop, global site allowlist, full Playwright scripting gateway or personal Chrome/Edge attachment in this scope.
- **Specified feature vs enabled capability:** Q21/Q25 describe the intended common workflow tool surface; Q36/Q37/Q41/Q48 restrict what may actually be enabled before human-confirmation feasibility and per-platform acceptance are established. These are not contradictory. Tool presence, paired-device possession or a model response do not grant an arbitrary effect.
- **Identity and effects:** explicit device/session/tab target, semantic-first unique locator with fresh visual fallback; potentially effectful operations use established Agent-local Operation IDs/Receipts. Agent/browser execution is not evidence of external website transaction completion; unknown outcomes do not allow automatic replay.
- **Security and privacy:** sensitive network destinations including redirects/resolved-address changes are reviewed and fail closed when uncertain, while full request/subresource coverage remains unverified; high-impact effects need genuine end-to-end, single-use, short-lived exact-action approval or remain disabled; normal logs exclude browser content/credentials by default, while authorized screenshot results may still contain secrets.
- **Files and lifecycle:** Agent OS/filesystem permission and existing file tools, local downloads with safe non-overwriting names, seven-day cleanup only when positively unreferenced. Persistent Profile retained across a 30-minute idle session cleanup; explicit owner clear only when session and unknown operations are safely resolved. No second file manager or durable cloud browser state.
- **Delivery:** Linux, WSL2 and native Windows require separate real acceptance before independently authorized staged enablement; real browser artifact trust, Agent installed/runtime parity and owner approval are not established by these documents.

**External feasibility/implementation evidence gates (not unanswered Grill choices, not asserted complete):**

| Gate | Evidence needed before an affected feature can be enabled | Safe status absent evidence |
| --- | --- | --- |
| Verified high-impact approval | Supported ChatGPT client and MCP→Worker→Agent proof for an identified one-use action, including replay, expiry, changed-target, disconnected/restarted and invalid-approval denial | High-impact effects **disabled** |
| Navigation and effect boundary | Enforced HTTP(S) target checks on redirects and resolved addresses, sensitive local/metadata target handling, safe action classifier, and explicit assessment of subresources/iframes/service workers/races | Unproven/uncertain actions **denied** |
| Browser runtime and supply chain | Trustworthy Playwright-compatible Chromium artifact and actual source/integrity metadata; no silent fallback, plus OS dependency checks | Missing/unverified browser **not launched** |
| Agent contracts and local safety | Installed/source platform behavior of session/Tab ID, existing receipt persistence/Unknown Outcome, operation schemas, file references and safe cleanup, Profile lock/recovery and visual-target freshness | Fail closed, retain uncertain state, **no blind replay or destructive cleanup** |
| Privacy and observability | Confirm no default DOM/screenshot/secret-bearing payload persistence in MCP/Agent/Worker logs; characterize authorized screenshot exposure and bounded snapshots | Do not claim complete redaction or approve unsafe telemetry |
| Platform-specific acceptance and release | Relevant real Linux, WSL2 and native Windows browser launch, file, UI, disconnection, authorization denial and upgrade/rollback evidence; reuse unchanged prior evidence only when applicable | That platform's/browser capability **not enabled** |
| Final owner governance | Owner confirms shared design understanding separately; later implementation planning or deployment must each receive separately scoped authorization | PR remains **open Draft**; no code, Tickets, merge or deploy |

**Boundary of the audit:** Specific numeric approval TTL, detailed API/receipt enums, exact browser binary checksum sources, network request interception coverage and platform test procedures are **not silently selected** here. Those are technical contracts or evidence gaps to investigate only after appropriate authorization; if investigation reveals a *new product-level trade-off*, return it to the owner rather than assuming a choice. The deferred personal-browser-profile attachment is a separate future design, not a hidden unresolved branch in the isolated-browser scope.

**Next conversation step:** ask the owner **only** whether this final summary accurately captures the agreed design. Agreement does **not** grant implementation or PR-ready/merge/deploy authority. Preserve Draft #117 and all documentation boundaries.

## Post-convergence feasibility audit — recommendations, not new decisions (2026-10-20)

**Scope:** Owner approved a deeper feasibility and overengineering review following Q1–Q52. The recommendations below are **not** newly accepted Q-decisions, a license to code, a claim of live successful acceptance, or a change to the feature scope. Source inspection covered the `main` branches of `lirtual/mcp-workers` and `lirtual/remote-control-agent` plus relevant official Playwright/MCP/OpenAI guidance. **No implementation or runtime probe was executed.** Each proposed correction must be confirmed at the appropriate future design/implementation approval stage if it changes an accepted trade-off.

### Primary-source P0 research — source-only, no runtime acceptance

[Browser P0 Feasibility Research](./BROWSER-P0-FEASIBILITY-RESEARCH.md) now records two narrower, falsifiable evidence matrices **without implementing them**:

- **P0-A / owner confirmation:** current Worker advertises only MCP tools and routes allowlisted operations to the paired Agent; no observed per-action owner-attestation field or browser consent handshake. OpenAI host tool approvals and MCP elicitation are documented possibilities, **not proof that this particular ChatGPT client delivers a single-use user confirmation that Agent can reliably validate**. Establish actual supported capability and negative replay/expiry/parameter-change behavior on a harmless synthetic action; otherwise consequential effects stay disabled.
- **P0-B / network boundary:** official Playwright docs confirm ordinary route handlers see the initial redirect URL only; service-worker and separate WebSocket request handling further limit claims of full interception. Validate the **effective browser network destination**, including controlled private-address redirects, DNS changes, subresources, service workers and sockets. If the current browser library is insufficient, any additional host network isolation is **a new trade-off for owner approval**, not silently included.

Both are **unverified, evidence-required** as of this source review. No real client approval, browser traffic or installed-platform acceptance was exercised.

**Additional same-session read-only and sandbox evidence:** [P0 research §D–E](./BROWSER-P0-FEASIBILITY-RESEARCH.md#d-non-destructive-feasibility-observations--same-session-local-probe-2026-10-20) records connected plugin tool discovery, two ambiguous same-named online devices (**no remote execution**), local Chromium startup, a synthetic redirect test **blocked by the sandbox administrator before a request could reach Playwright or the server**, and small offline screenshot sizes (PNG **12,063 B**, JPEG **10,553 B**). **Neither** remote high-impact approval nor remote browser egress interception has passed a real acceptance test. Existing DO dispatch also times out after **5 seconds**, which is a concrete future browser-call lifetime/design constraint; do not convert read calls naively or blindly retry unknown work. These are observations, not accepted Q decisions.

**Latest real Windows P0 baseline (2026-10-20):** [P0 research §I](./BROWSER-P0-FEASIBILITY-RESEARCH.md#i-live-windows-isolated-chromium-baseline-and-controlled-redirect-fixture-2026-10-20) **supersedes** prior Windows read-only/Stage-0 blockers. The exact user-selected device runs the native full-tools Windows Agent `v0.1.12-windows-rc.1`; [Worker PR #136](https://github.com/lirtual/mcp-workers/pull/136) was merged and released, and real Shell/file tools were independently accepted. **Stage 0 PASS:** disposable isolated Chromium Headless Shell actually launched and rendered a synthetic offline HTML marker, leaving no tagged browser process or temporary Profile. Agent-bundled Node v24.21.0 is present, but `playwright` is not resolvable from this Node context; Playwright API integration remains unverified. **Stage 1 CONTROLLED BASELINE PASS ONLY:** an ephemeral server bound to `127.0.0.1` observed one initial public-fixture request and one redirected `/simulated-sensitive` request; this proves unguarded Chromium followed the redirect, **not** that Q45/Q49 network policy blocks sensitive requests. **P0 request-policy gate remains NOT IMPLEMENTED / UNVERIFIED. Stage 2 action-bound ChatGPT→Agent approval is NOT TESTABLE** with the current MCP/browser interface. All isolated test files and processes were cleaned; no external sites, metadata endpoints, personal Profiles, release or browser product code were involved.

### Findings and minimum readiness contracts

| Priority | Finding verified against existing code/documentation | Recommended minimal disposition | Evidence gate before the affected feature |
| --- | --- | --- | --- |
| **P0 — authorization** | Existing Worker has authentication, device pairing and tool annotations but no demonstrated browser action-specific, user-origin approval proof. ChatGPT hosts can gate tool calls and MCP may support elicitation, but approval UI or an elicited answer is **not by itself** cryptographic human-intent attestation delivered to Agent | First test whether the actual installed ChatGPT/MCP client can reliably deliver evidence bound to one proposed action; reuse host confirmation plus the existing authenticated device dispatch, **not** a new approval portal by default. Do not equate a model's next tool invocation with proof of a user click | Accept/reject a prepared, one-use owner approval on the actual supported client, with replay, expiry, changed target, re-connect and altered arguments rejected at the execution boundary. If impossible, consequential/browser upload/general effects stay disabled; only proven safe capability gates may be considered |
| **P0 — browser egress/network** | Playwright `browserContext.route()` can intercept requests but its ordinary route handler runs only on the original URL of a redirect chain; service-worker-owned requests also have documented interception caveats. Q45/Q49 scheme and effective-target checks do not by themselves prove SSRF protection | Establish a **browser-wide effective network destination policy**, including requests other than top-level navigation, DNS/rebinding and redirect behavior, and define a fail-closed mode. Evaluate Playwright interception first; if insufficient, review narrow Agent/browser-process egress isolation as a **separate owner decision**, not assumed infrastructure | Controlled tests demonstrating rejection of loopback, private/link-local, metadata and unapproved internal targets across redirects, DNS changes, frames, XHR/fetch, websocket, service workers and relevant prefetch flows; no claims of complete interception without evidence |
| **P1 — screenshots/results** | Current Remote Control MCP request bound is **65,536 bytes** in `apps/remote-control-mcp-worker/src/worker.ts`; DO/Agent read protocol uses bounded JSON/text (including a 65,536-character reply check in `v2-pairing.ts`), **not a verified binary image channel**. Current `read_file`/other file tools are primarily text-oriented | Specify a **bounded image result contract**: viewport-first, compressed JPEG/WebP and `scale: 'css'` where appropriate; expected media type, size check, truncation/failure rule, privacy treatment, and mapping to MCP image content. Reuse current transport *only if actual bytes fit*. Otherwise compare minimal bounded binary/chunked alternatives; do **not** automatically add R2/cloud image storage | One real image round-trip through **Agent → DO/Worker → MCP → ChatGPT** on each intended platform, within measured message/response limits, with oversize behavior and privacy/log exclusion verified |
| **P1 — usable workflow** | Q21/Q25 define sessions, tabs, navigation, snapshot, click, fill, select, keyboard, screenshot and local transfers. Full login/search/forms can need dialog handling, scroll, wait-for-condition, history navigation, new-tab reconciliation and download lifecycle; some are served by Playwright built-ins or existing primitives | Create **no** new generic `browser_action` dispatcher or full Playwright tool mirror. Review three representative browser scenarios on paper, distinguish built-in auto-wait/locator scrolling from genuine missing atomic actions, and propose only necessary additions at a later separately confirmed interface review | Every claimed initial supported scenario maps unambiguously to atomic calls, with explicit failure modes for unsupported dialogs, uploads, downloads, popups and unknown effects |
| **P1 — local upload and binary downloads** | Agent OS filesystem authority and file-reading tools already exist, but **OS-readable does not mean authorized to exfiltrate**. Existing Remote Control file reads do not establish remote PDF/ZIP/image binary retrieval through MCP | Treat an explicit upload source path **and destination origin** as part of action intent/effect classification, with per-action owner approval where consequential. Keep downloaded bytes on Agent in Q19/Q30 dedicated area; do not promise attachment-like binary retrieval until transport is separately proven | Deny unexpected local-file uploads, path substitution and sensitive-file exfiltration; test non-overwriting local download, completion observation, retention references, and clarify whether remote binary access is supported or explicitly unavailable |

**Existing reusable evidence:** `lirtual/remote-control-agent/apps/remote-control-agent/src/operations.ts` defines durable `admitted/running/completed/failed/unknown` local receipts and 30-day normal retention (unresolved/guarded records have separate behavior); the Worker routes explicit `device_id` and `operation_id` for existing file/Shell operations. These are **patterns and source capabilities**, not proof browser-specific receipts have been integrated or accepted on Windows/WSL2.

**Current-source limitation:** browser automation is absent from the cited installed/current source paths; the present GitHub branches do not establish browser screenshot, Playwright runtime, verified owner consent, or full-network egress enforcement. The review cannot mark any new browser tool `implemented`, `tested`, or `enabled`. Existing Remote Control tool annotations are not authorization checks. Future open-web browser tools need accurate `readOnlyHint`, `destructiveHint`, and `openWorldHint` based on actual effects: e.g. public-web navigation/reads are open-world even when non-destructive.

### Lean scope correction and rollout model — proposal only

1. **Read/inspect capability candidate:** explicitly targeted session/tab status and scoped semantic snapshots; screenshot only after the image transport and privacy gate; navigation only after the browser-wide network and effect-safety gate. A read tool that starts a browser/page can change local state and a GET may trigger website effects, so “read-only” and annotations must reflect what the tool actually does.
2. **Normal interaction candidate:** click/fill/select/keyboard and missing dialogs/scroll/wait/navigation-history capabilities only after a clear safe-effect or verified approval rule; do not claim Q21's planned complete tool inventory is already shipped.
3. **Consequential action candidate:** external submissions, deletions, payments, permission changes and external uploads remain disabled unless the actual client-to-Agent single-use approval proof can be verified. Do not use “user said yes in chat” as a substitute.
4. **Dependencies kept lean:** use the officially supported Playwright version-matched browser install/cache as the default artifact lifecycle (with real provenance checks and no privileged silent install), existing Remote Control device/receipt/file lifecycle, existing authenticated Worker path. **No new Browser Worker, CDP network listener, approval service, capability registry, distributed transaction ledger, file index or R2 media store** absent evidence that a specific requirement cannot be met otherwise.

**Avoid premature implementation promises:** The screenshot compression route, actual network enforcement, tool coverage, client approval mechanism and download transfer are **candidate approaches**, not newly selected technologies or approvals. If later evidence forces a real new architecture choice, return it to the owner; do not silently modify Q1–Q52.

### Official references checked for this audit

- [Playwright Network](https://playwright.dev/docs/network) — interception, redirect-handler and Service Worker caveats.
- [Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext) — route scope and Service Worker bypass.
- [Playwright Page screenshots](https://playwright.dev/docs/api/class-page#page-screenshot) — `type`, `quality`, `scale`, masking, buffer result.
- [Playwright Browsers](https://playwright.dev/docs/browsers) — version-matched binary installs, cache and platform dependencies.
- [MCP TypeScript SDK Elicitation](https://ts.sdk.modelcontextprotocol.io/v2/servers/elicitation) — host capability-dependent interaction; **not proof that a given ChatGPT client forwards per-action authorization to this Agent**.
- [OpenAI plugin tool annotations](https://developers.openai.com/plugins/plan/tools) and [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines) — independent tools and accurate effect metadata; annotations are not authorization.

## Design review observations — not accepted decisions (2026-10-20)

These are **review findings and remaining feasibility or detail gaps**, *not* further accepted decisions, implementation evidence, issue tickets or permission to act. Q49–Q52 close the current product-level interview frontier; they do **not** verify runtime enforcement or allow implementation.

1. **High — navigation and action policy accepted (Q37/Q41/Q45/Q49), enforcement still unproven.** Recheck each redirect and changed resolved address/host, fail closed for unapproved sensitive targets. This does not prove that browser subresources, iframes, service workers, prefetch or DNS rebinding races cannot bypass top-level checks; real request coverage evidence is required. Even GET navigation may have side effects; generic click/fill/keyboard/select are not automatically low-impact.
2. **High — end-to-end owner approval contract accepted (Q23/Q27/Q38/Q51), actual client proof unverified.** Approvals must be short-lived, one-use, exact-action bound and rejected when reused, changed or unverifiable. No verified ChatGPT→MCP→Worker→Agent user-confirmation channel or human-presence proof has been demonstrated here. Keep high-impact operations disabled; do not assume a new approval portal is necessary.
3. **Medium — existing local receipts accepted (Q39), exact outcome representation open.** Q39 reuses existing receipt semantics for progress and unknown outcomes and rejects a new website transaction ledger. Read-only website confirmation may be inconclusive. Q42 and subsequent evidence review must preserve this distinction instead of inventing exactly-once guarantees.
4. **Medium — output, logging and cleanup contracts accepted (Q43/Q44/Q46/Q47/Q50), evidence missing.** Approximately 8,000 characters and one requested screenshot can expose secrets despite the rule to avoid routine persistent DOM/screenshot/credential logging. Runtime logging/trace integrations have not been inspected or certified by the interview. Target freshness, atomic file creation and symlink/Windows-path races, seven-day reference checks and retention of unresolved files still need validation; a separate file-manager DB or cloud binary proxy is not justified.
5. **Medium — installation and rollout evidence.** Q31 requires genuine trusted Chromium provenance, which must be established from actual available metadata rather than inventing a checksum. Q32 requires platform-specific proof; previous Windows preview work is not proof of browser support. A new distribution pipeline or cross-platform lockstep release would exceed accepted scope without further justification.
6. **Complexity watch — first-release coverage vs staged enablement (Q40).** Q21/Q25 identify intended *tool capability*, while Q36/Q37/Q40 permit only safety-classified, platform-accepted operations to become *enabled* under separate release authorization. Keep defined, implemented, tested and enabled states distinct. No new Worker/DO, profile manager, general scripting gateway, approval service, independent website ledger or cross-platform lockstep release is justified by these decisions. Q40 permits reusing relevant unchanged test evidence, not skipping changed behavior.
7. **Complexity watch — documentation and existing runtime drift.** ADR-0021–0030 now cover one browser feature and repeat some cross-references; a final editorial pass should reduce redundant wording *without overturning approved decisions*. [Existing receipt ADR-0007](./adr/0007-local-receipts-and-no-blind-replay.md) already describes minimal not-started, running, completed, failed and unknown distinctions, while [ADR-0016](./adr/0016-agent-local-receipts-and-bounded-commands.md) distinguishes merged Agent source from an installed Agent that may still use prior local receipt storage. Do not mistake an accepted shared architecture for verified native-Windows or installed-device receipt compatibility; reconcile only the affected code path and evidence before any later rollout. This is a review note, not approval of a migration or refactor.
8. **Complexity watch — consolidation without architecture proliferation (Q52).** Rounds 11–13 amend existing ADR-0021/0025/0026/0027/0028/0029/0030, and add **no** ADR-0031. Q48 reuses existing device/tool status rather than a capability registry. The final design index and follow-on reference cleanup should remove repetition without erasing historical accepted alternatives or inventing new systems.

### ego-lite comparative review — candidate UX patterns, not a new decision (2026-10-20)

[Research §S](./BROWSER-P0-FEASIBILITY-RESEARCH.md#s-external-agent-native-browser-reference-citrolabs-ego-lite-2026-10-20) reviews [CitroLabs ego-lite](https://github.com/citrolabs/ego-lite), its source-level Agent/browser interface, and open security/concurrency reports. **Conclusion:** keep **Remote Control MCP + paired Agent + Playwright-compatible Chromium**. Ego Lite is a useful **external design reference**, not a replacement runtime, confirmed network sandbox, approval protocol, or newly approved dependency.

The following are **possible implementation refinements within existing Q1–Q52 contracts**, to be verified during the later tool/UX review rather than assumed delivered:

- **Semantic-first, compact Snapshot refs:** carry explicit device/session/tab/frame/document/node provenance and a bounded ~8,000-character observation; reject stale/ambiguous nodes and require a fresh snapshot rather than guessing by text, index or coordinate. Cross-origin iframe/OOPIF and dynamically changing DOM need real-browser negative tests. No persistent sensitive DOM ledger.
- **Human/Agent control handoff:** owner takeover may pause further Agent mutations and allow controlled resumption using existing session/receipt state. A handoff or resume signal is **not** a short-lived one-use high-impact Browser Action Confirmation. Preserve exact-action verification and fail closed when no genuine client proof exists.
- **Fewer round trips without generic scripting:** prefer focused observations, Playwright auto-wait and local execution of explicitly authorized atomic steps. Ego Lite's model-generated arbitrary JavaScript/CDP, mutable global target switching and Node-side raw fetch are **not adopted**. A new batched action tool would conflict with Q17/Q25 unless separately reviewed and explicitly accepted; no such new tool is specified here.
- **Personal browser state stays separate:** Ego Lite's convenient shared logged-in Profile is not suitable as our default. Keep Q7/Q10/Q11's dedicated persistent Automation Profile and later *explicitly authorized* personal-browser attachment only. Reported cross-Space Cookie effects and raw-CDP risks are documented as third-party issue reports, not proof of current installed-product behavior.
- **P0 priority unchanged:** [research §R](./BROWSER-P0-FEASIBILITY-RESEARCH.md#r-actual-windows-basecontainer-launch-and-wfp-fixture-attempt--process-startup-blocks-network-acceptance-2026-10-20) shows the actual Windows BaseContainer can launch a trivial process but non-admin network-capable clients did not start successfully; positive/negative WFP traffic enforcement is **NOT ACCEPTED**. The one-use owner consent gate remains independent. Ego Lite does not address either gate.

No new ADR, Q53, feature tools, browser executable, profile import, Worker, network proxy, production code or release is authorized by this comparison. If direct reuse of MIT code is ever considered, review specific licenses and retain attribution first.

## Documentation and scope rules

- Capture only settled terms in [CONTEXT.md](./CONTEXT.md); create an ADR only for architectural choices that genuinely need durable rationale.
- Changes during grilling are documentation-only on a review branch. No new implementation Tickets, coding, cloud resources or production changes until the full decision tree is exhausted and the owner explicitly confirms shared understanding.
