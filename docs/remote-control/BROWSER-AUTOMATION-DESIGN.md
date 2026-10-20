# Remote Control — Browser Automation Design (Grill With Docs)

Status: **design interview in progress; rounds 1 and 2 agreed 2026-10-20**. This document records decisions, not shipped behavior, authorization to implement, a release gate or a new development Ticket. The existing v1/v2 specs remain authoritative for their implemented scope. Do not infer that browser tools, native Windows browser automation coverage, or personal-profile access exist today.

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

## Invariants carried forward

- Use the established authenticated device path and explicit `device_id`; never accept an arbitrary remote address or publish a CDP endpoint.
- Distinguish browser reads from effects. Do not claim that a lost response proves that an action did not execute; preserve existing `operation_id`/receipt semantics for effects, subject to later detailed design.
- Existing Remote Control v1 technical exclusions are historical release boundaries, not evidence of shipped browser support.
- Remote webpages are untrusted inputs, not instructions or authority to escalate tool privileges.
- Existing User Agent/browser personal credentials must not be copied to Cloudflare logs or MCP responses.
- Linux and native Windows are approved *targets*, not confirmed shipped capabilities: each requires platform-specific acceptance before release. WSL2 is a Linux runtime and its Agent cannot automatically control Windows desktop browsers.

## Open design-tree branches

**Next-round frontier (Q9–Q12; no choices accepted yet)**

- Q9 — How should compatible Playwright browser binaries and OS dependencies be provisioned on supported devices?
- Q10 — What concurrency and exclusive ownership contract governs automation browser sessions that may share a persistent local profile?
- Q11 — What is the intended relationship between the persistent automation profile and multiple sign-in/account identities?
- Q12 — What should happen to an already-running browser session when the MCP caller disconnects, Agent reconnects, or the owner revokes the device?

**Downstream (not yet at the frontier; depends on Q9–Q12):** headless/headed defaults, exact installer/update compatibility, per-profile locking model, existing-personal-profile attach and permission flow, tab/tool schema and accessibility/screenshot fallbacks, upload/download scope, sensitive-action confirmation, operation ID/receipt reconciliation, detailed idle limits, testing and release gates, and final authorization to implement.

## Documentation and scope rules

- Capture only settled terms in [CONTEXT.md](./CONTEXT.md); create an ADR only for architectural choices that genuinely need durable rationale.
- Changes during grilling are documentation-only on a review branch. No new implementation Tickets, coding, cloud resources or production changes until the full decision tree is exhausted and the owner explicitly confirms shared understanding.
