# Remote Control — Browser Automation Design (Grill With Docs)

Status: **design interview in progress; round 1 agreed 2026-10-20**. This document records decisions, not shipped behavior, authorization to implement, a release gate or a new development Ticket. The existing v1/v2 specs remain authoritative for their implemented scope. Do not infer that browser tools, native Windows coverage, or personal-profile access exist today.

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

## Invariants carried forward

- Use the established authenticated device path and explicit `device_id`; never accept an arbitrary remote address or publish a CDP endpoint.
- Distinguish browser reads from effects. Do not claim that a lost response proves that an action did not execute; preserve existing `operation_id`/receipt semantics for effects, subject to later detailed design.
- Existing Remote Control v1 technical exclusions are historical release boundaries, not evidence of shipped browser support.
- Remote webpages are untrusted inputs, not instructions or authority to escalate tool privileges.
- Existing User Agent/browser personal credentials must not be copied to Cloudflare logs or MCP responses.
- No assumption that a native Windows Agent is production-ready solely because Windows work exists elsewhere: platform targets and release gates remain undecided.

## Open design-tree branches

**Next-round frontier (Q5–Q8; no choices accepted yet)**

- Q5 — Which browser automation engine/runtime boundary is the primary implementation?
- Q6 — Which OS targets must be supported at first acceptance?
- Q7 — How should isolated automation browser profiles and sign-in state persist?
- Q8 — What is the session ownership and idle lifetime contract?

**Downstream (not yet at the frontier; depends on Q5–Q8):** exact adapter lifecycle and packaging, existing-profile attach and permissions, tabs/tool schema, accessibility snapshots/screenshots, downloads/uploads, sensitive action classification, idempotency and reconciliation, session concurrency, test/rollout criteria and final implementation authorization.

## Documentation and scope rules

- Capture only settled terms in [CONTEXT.md](./CONTEXT.md); create an ADR only for architectural choices that genuinely need durable rationale.
- Changes during grilling are documentation-only on a review branch. No new implementation Tickets, coding, cloud resources or production changes until the full decision tree is exhausted and the owner explicitly confirms shared understanding.
