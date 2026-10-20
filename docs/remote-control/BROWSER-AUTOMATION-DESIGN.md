# Remote Control — Browser Automation Design (Grill With Docs)

Status: **design interview in progress; rounds 1–12 agreed 2026-10-20**. This document records decisions, not shipped behavior, authorization to implement, a release gate or a new development Ticket. The existing v1/v2 specs remain authoritative for their implemented scope. Do not infer that browser tools, native Windows browser automation coverage, or personal-profile access exist today.

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

## Invariants carried forward

- Use the established authenticated device path and explicit `device_id`; never accept an arbitrary remote address or publish a CDP endpoint.
- Distinguish browser reads from effects. Do not claim that a lost response proves that an action did not execute; preserve existing `operation_id`/receipt semantics for effects, subject to later detailed design.
- Existing Remote Control v1 technical exclusions are historical release boundaries, not evidence of shipped browser support.
- Remote webpages are untrusted inputs, not instructions or authority to escalate tool privileges.
- Existing User Agent/browser personal credentials must not be copied to Cloudflare logs or MCP responses.
- Linux and native Windows are approved *targets*, not confirmed shipped capabilities: each requires platform-specific acceptance before release. WSL2 is a Linux runtime and its Agent cannot automatically control Windows desktop browsers.

## Open design-tree branches

**Next-round frontier (Q49–Q52; no choices accepted yet)**

- Q49 — Should sensitive-target navigation protections remain effective after HTTP redirects, DNS resolution changes and navigation to a new host, rather than checking only the originally requested URL?
- Q50 — How should untrusted page text/screenshot content be handled in MCP results and routine logs so that sensitive data is not retained or made into instructions by default?
- Q51 — What lifetime and replay/consumption safety boundary should a proposed one-use high-impact action have **if** a supported client-to-Agent verification channel is later shown to exist, without inventing a new approval service?
- Q52 — What minimum evidence and ownership gate should conclude this design review and permit requesting a separate implementation plan, while preventing a Draft documentation PR from being treated as authority to merge or deploy?

**Known external feasibility blockers, not choices that may be assumed resolved:** whether ChatGPT/MCP carries verifiable action-specific approval through Worker to Agent; actual installed Agent receipt and native Windows runtime compatibility; trustworthy compatible Chromium binary metadata; Linux/WSL2/Windows browser acceptance, which requires later real evidence. The next round records design choices only; it does not certify these facts. The final audit should consolidate duplicate ADR wording rather than extending the interview for already settled decisions.

## Design review observations — not accepted decisions (2026-10-20)

These are **review findings and remaining feasibility or detail gaps**, *not* further accepted decisions, implementation evidence, issue tickets or permission to act. Round-10 choices resolve design direction, **not proof that safety mechanisms exist**.

1. **High — conservative classification and navigation scheme boundary accepted (Q37/Q41/Q45), resolution/redirect behavior still unproven.** Status and bounded observation are candidate low-impact operations, not universally safe: page loads, HTTP redirects, local/network metadata endpoints, and even GET requests may carry side effects. Q45 now requires ordinary HTTP(S) navigation and explicit review of sensitive destinations; it does not prove that hostnames, DNS changes, subresources or redirect chains are filtered. Q49 must decide the policy boundary without adding a global website whitelist. Generic click/fill/keyboard/select are not automatically safe.
2. **High — E2E owner authorization gate accepted (Q38), actual transport unverified.** Q38 now requires a demonstrated action-specific, single-use proof from ChatGPT via MCP/Worker to Agent and rejection of invalid approvals. Such a client capability has **not** been established here. High-impact actions must remain disabled if proof is unavailable; no new portal is automatically justified.
3. **Medium — existing local receipts accepted (Q39), exact outcome representation open.** Q39 reuses existing receipt semantics for progress and unknown outcomes and rejects a new website transaction ledger. Read-only website confirmation may be inconclusive. Q42 and subsequent evidence review must preserve this distinction instead of inventing exactly-once guarantees.
4. **Medium — screenshot/cleanup safeguards accepted (Q43/Q44/Q46/Q47), implementation evidence still missing.** Approximately 8,000 semantic characters and one requested screenshot do not guarantee privacy; page content and screenshot-derived coordinates can become stale on scrolling, navigation or dynamic layout. Q46 requires fail-closed freshness checks, not a timestamp-only rule. Q47 prevents download overwrite and path escape, but symlink races, Windows pathname handling and retention references must still be validated. No separate file manager/index or cloud binary proxy is justified.
5. **Medium — installation and rollout evidence.** Q31 requires genuine trusted Chromium provenance, which must be established from actual available metadata rather than inventing a checksum. Q32 requires platform-specific proof; previous Windows preview work is not proof of browser support. A new distribution pipeline or cross-platform lockstep release would exceed accepted scope without further justification.
6. **Complexity watch — first-release coverage vs staged enablement (Q40).** Q21/Q25 identify intended *tool capability*, while Q36/Q37/Q40 permit only safety-classified, platform-accepted operations to become *enabled* under separate release authorization. Keep defined, implemented, tested and enabled states distinct. No new Worker/DO, profile manager, general scripting gateway, approval service, independent website ledger or cross-platform lockstep release is justified by these decisions. Q40 permits reusing relevant unchanged test evidence, not skipping changed behavior.
7. **Complexity watch — documentation and existing runtime drift.** ADR-0021–0030 now cover one browser feature and repeat some cross-references; a final editorial pass should reduce redundant wording *without overturning approved decisions*. [Existing receipt ADR-0007](./adr/0007-local-receipts-and-no-blind-replay.md) already describes minimal not-started, running, completed, failed and unknown distinctions, while [ADR-0016](./adr/0016-agent-local-receipts-and-bounded-commands.md) distinguishes merged Agent source from an installed Agent that may still use prior local receipt storage. Do not mistake an accepted shared architecture for verified native-Windows or installed-device receipt compatibility; reconcile only the affected code path and evidence before any later rollout. This is a review note, not approval of a migration or refactor.
8. **Complexity watch — avoid ADR and capability registry proliferation.** Rounds 11–12 amend existing ADR-0025/0027/0028/0029/0030 and deliberately do not create ADR-0031. Q48 reuses existing device/tool status instead of a new centralized capability registry. A final editorial consolidation should shorten duplicated cross-references without silently superseding past owner decisions.

## Documentation and scope rules

- Capture only settled terms in [CONTEXT.md](./CONTEXT.md); create an ADR only for architectural choices that genuinely need durable rationale.
- Changes during grilling are documentation-only on a review branch. No new implementation Tickets, coding, cloud resources or production changes until the full decision tree is exhausted and the owner explicitly confirms shared understanding.
