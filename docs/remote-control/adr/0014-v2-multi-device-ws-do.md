# ADR-0014 — Remote Control MCP v2: one WebSocket/Hibernating DO transport

Status: **accepted design; no implementation, cloud resource or production authorization**. Date: 2026-10-15.
This new ADR supersedes the **unmerged discovery-draft** ADRs originally numbered 0014–0018 on PR #45; the full grilling history remains in that PR. Existing accepted v1 ADR-0004/0012/0013 remain valid for **v1 production**.

## Problem and decision

An individual owner wants to install a native Linux Agent on Linux/WSL2 in unrelated home/office/cloud networks with minimal setup, and control multiple separately paired devices through **one authenticated Remote Control MCP**.

**Select** v2 **Agent-initiated TLS WebSocket → existing MCP Worker → one owner-scoped SQLite-backed Durable Object using the WebSocket Hibernation API**. A DO maintains minimal device registry, revocation records and live socket routing; the native Agent retains file/search/Shell behavior, operation receipts and owned process sessions. No public Agent port, per-device Tunnel, VPC Network/Mesh, Cloudflare One Client or Cloudflare device enrollment is needed for v2. The choice of a single coordinator is for a small personal fleet, not a multitenant architecture.

- Continue using a Remote-Control-specific Portal `MCP_ACCESS_TOKEN` for the MCP caller. **It never authenticates an Agent or goes into an installer**.
- One MCP lists devices and requires explicit, server-validated `device_id` for every v2 tool operation; never accept a client-selected destination URL/IP or mutable global default.
- Device identity is per installation; each Agent pairs separately using the approved protocol in [ADR-0015](./0015-v2-pairing-and-identity.md). Reinstall = new identity, new pairing, old one must be revoked.
- Detect known offline state, reject commands while offline, reconnect automatically without buffering/replaying commands. A network outage alone does not terminate locally running operations; reconcile uncertain outcomes through existing local `operation_id` receipts.
- Revocation **first persists an application-level deny**, refuses subsequent WebSocket auth and command dispatch, and closes the old connection. Request **best-effort** cancellation of *Agent-owned* online sessions; an offline/compromised device may continue local work, which cannot be falsely reported stopped.
- Remove every access permission **actually granted**. Because this chosen architecture issues no Cloudflare One network registration, no Cloudflare One device-registration deletion exists. Re-enrollment is only possible through a fresh explicit owner-approved application pairing.
- Preserve current fixed VPC Service + private Tunnel v1 as-is. Design, build and test v2 **separately**, then require explicit migration approval, isolation and a reversible cutover. No automatic production deployment, Cloudflare resources, secrets or CI added by this ADR.

## Free and Hibernation rules

Use `ctx.acceptWebSocket()`, `webSocketMessage`/`webSocketClose`, minimal `serializeAttachment` metadata and `getWebSockets()` reconstruction; **persist** pairings, public keys and revocation tombstones in DO SQLite, not just JS memory. Check current device status before command dispatch.

Avoid unbounded requests, permanent timers, outbound DO WebSockets, and frequent application-level heartbeat handlers: all can prevent hibernation. Prefer runtime protocol ping/pong or `setWebSocketAutoResponse()` for idle presence, plus a bounded stale-connection policy. Any running Shell command must be handled by the **Agent-owned session**, not by an indefinitely pending DO request.

Official Workers Free / SQLite-DO quotas currently include 100,000 DO billable requests/day, 13,000 GB-s/day, 5 million SQLite rows read/day, 100,000 rows written/day and 5 GB total stored; incoming WebSocket app messages bill at 20:1 for compute requests, not for metrics. Workers frontend quota and other DO consumers are additional. **One isolated v2 Preview device observed for 48h in nonproduction** must demonstrate real hibernation/wake, controlled reconnect, low-frequency operations and shared Free-plan headroom before rollout. Multi-device routing, revocation and isolation remain covered by existing acceptance and CI; this soak does not claim simultaneous multi-device endurance. Approval of this test requirement does not authorize creating test resources now.

## Why not other transports?

Cloudflare Mesh + VPC Network can route across sites, but per-device permanent refusal of a removed interactive Cloudflare One registration (while keeping the same user's other devices authorized) was not proven. A site Tunnel also imposes per-site reachability setup. They are **not v2 implementation candidates**; preserve only this short rejected-alternative rationale, not pages of Mesh setup or Cloudflare admin API flows. Existing v1 Tunnel is not being removed.

## Prior accepted requirements preserved (Q1–Q16)

- Q1/Q2: near-one-command installation; Linux/WSL2 first, native Windows/macOS later. Permission to automate Cloudflare One Client was **conditional on using Mesh**; it is not needed under the selected WS design.
- Q3: interactive Cloudflare One login/headless Service Auth was conditional on Mesh. Under v2, owner authorization is via existing Portal-authenticated **MCP pairing approval** instead; no implicit Cloudflare One login or OAuth.
- Q4–Q6: separate per-device pairing and revocation, all actually granted permissions withdrawn, one MCP with `list_devices` and explicit stable `device_id`.
- Q7–Q10: auto reconnect, no offline work queue, local receipts with no blind retry, reinstall requires new identity, fail-closed revocation with truthful cleanup status.
- Q11–Q13: revoke only credentials actually granted; preserve production v1; online best-effort termination for owned sessions on *explicit* removal, not on ordinary disconnection.
- Q14: WS + DO Hibernation selected for v2 design; v1 deployment remains unchanged. Q15/Q16 owner Portal review and short-lived on-device pairing code are detailed in ADR-0015.

## Consequences, gates and non-goals

**Benefits:** one Linux Agent without Cloudflare One client, individually revocable device identity, minimal edge state, one MCP, reuse of local execution/receipt semantics.

**Costs:** a narrow public Agent bootstrap surface, strong approval flow, WebSocket challenge proof, connection correlation and actual idle-usage verification. Bearer-based Portal authentication does not prove human presence.

Non-goals: native Windows/macOS/GUI, a fleet control panel, OAuth server, D1/KV/R2, per-device DO instances, offline queues, cross-account tenancy, arbitrary private IP proxy, new CI, production resource changes or a new execution sandbox claim.

References: [protocol ADR](./0015-v2-pairing-and-identity.md) · [authoritative v2 Spec](../V2-MULTI-DEVICE-SPEC.md) · [v1 Spec](../SPEC.md).
Cloudflare: https://developers.cloudflare.com/durable-objects/best-practices/websockets/ · https://developers.cloudflare.com/durable-objects/platform/pricing/ · https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
