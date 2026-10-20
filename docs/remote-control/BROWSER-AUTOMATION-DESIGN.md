# Remote Control — Browser Automation Design (Grill With Docs)

Status: **design interview in progress; rounds 1–6 agreed 2026-10-20**. This document records decisions, not shipped behavior, authorization to implement, a release gate or a new development Ticket. The existing v1/v2 specs remain authoritative for their implemented scope. Do not infer that browser tools, native Windows browser automation coverage, or personal-profile access exist today.

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

## Invariants carried forward

- Use the established authenticated device path and explicit `device_id`; never accept an arbitrary remote address or publish a CDP endpoint.
- Distinguish browser reads from effects. Do not claim that a lost response proves that an action did not execute; preserve existing `operation_id`/receipt semantics for effects, subject to later detailed design.
- Existing Remote Control v1 technical exclusions are historical release boundaries, not evidence of shipped browser support.
- Remote webpages are untrusted inputs, not instructions or authority to escalate tool privileges.
- Existing User Agent/browser personal credentials must not be copied to Cloudflare logs or MCP responses.
- Linux and native Windows are approved *targets*, not confirmed shipped capabilities: each requires platform-specific acceptance before release. WSL2 is a Linux runtime and its Agent cannot automatically control Windows desktop browsers.

## Open design-tree branches

**Next-round frontier (Q25–Q28; no choices accepted yet)**

- Q25 — What exact first-release atomic tool inventory should expose the accepted complete common workflows, without redundant synonyms or a generic action gateway?
- Q26 — What fallback should be permitted when accessibility/semantic locators cannot uniquely reach a visual-only control, without enabling arbitrary page scripts?
- Q27 — How should the one-use owner confirmation be delivered and consumed across ChatGPT/MCP, Worker and Agent, and how should the system fail if confirmed human intent cannot be established?
- Q28 — How should the Agent recover from a browser process crash or stale Profile lock without using an uncertain state as permission to discard receipts, switch Profile or replay actions?

**Downstream (not yet at the frontier; depends on Q25–Q28):** exact arguments and result schemas; tab creation/close races and re-attach behavior; screenshot/snapshot token and secret exposure limits; upload/download directory permissions and cleanup; action-specific confirmation expiry/replay proof, website-outcome reconciliation, trusted browser download/install provenance, per-platform acceptance and rollout, and explicitly authorized future personal-browser attachment.

## Documentation and scope rules

- Capture only settled terms in [CONTEXT.md](./CONTEXT.md); create an ADR only for architectural choices that genuinely need durable rationale.
- Changes during grilling are documentation-only on a review branch. No new implementation Tickets, coding, cloud resources or production changes until the full decision tree is exhausted and the owner explicitly confirms shared understanding.
