# ADR-0021 — Browser automation is a scoped Remote Control capability

Status: **accepted design boundary (Grill With Docs round 1, 2026-10-20); documentation only, no implementation or release approval**.

Remote browser automation belongs to the existing **Remote Control MCP** product rather than a new `browser-mcp-worker`. It reuses the existing authorized device identity, explicit device routing, authenticated Agent transport, and ownership boundaries. The browser-specific runtime is an Agent-side capability, not a second device registration, Worker, Durable Object, public CDP endpoint, or browser-wide permission implied by pairing.

The first delivery **prioritizes an independently managed automation browser**. Attaching to an owner's already-open Chrome/Edge and reusing an existing login session is a **later, separately designed capability**; it must not be represented as available by this ADR alone.

The scope is **browser automation only**: navigation, page/element inspection, tab and browser-session management, webpage interactions, and browser-scoped file transfers as subsequently specified. Full desktop screen sharing, arbitrary OS mouse/keyboard control, and other native GUI applications remain out of scope. This does **not** supersede the first-release exclusion of graphical desktop control in the v1 Remote Control spec.

Existing **device pairing is necessary but insufficient as blanket browser authorization**. Operations must target an explicitly authorized `device_id` and identified browser session/tab as applicable. Access to an existing personal browser profile/tab requires the owner's explicit scope selection; sensitive external actions must have an explicit confirmation boundary. The precise approval UX, supported operations and action classes remain unsettled.

**Why:** reusing the established device trust and WSS/DO route avoids duplicating authentication and fleet coordination. Isolated automation sessions reduce interference and exposure before enabling the riskier existing-profile path. Restricting scope prevents browser support from becoming a general remote-desktop product.

**Still open:** browser engine/transport adapter, initial supported operating systems and dependencies, isolated profile persistence, session lifetime, tab and profile permission UX, high-risk action handling, exact tools and schemas, audit/receipt/recovery behavior, packaging, acceptance and rollout gates. No coding, Issue creation, production change, or deployment is authorized by this ADR.

Related: [Remote Control Domain Context](../CONTEXT.md), [v2 multi-device transport ADR-0014](./0014-v2-multi-device-ws-do.md), [local mutation receipts ADR-0007](./0007-local-receipts-and-no-blind-replay.md).
