# ADR-0015: Owner-reviewed device pairing

A locally generated Ed25519 device identity is approved through one short-lived pairing request and an authenticated Owner action. Approval is for a specific identity and explicitly selected permanent or temporary grant, never for a display name alone. Reconnection must prove possession of the same identity; it does not silently recreate, extend or upgrade a revoked grant.

Temporary device grants have bounded, nonrenewable lifetimes. Device identity, grant expiration, temporary Session authority and Agent-side process ownership are separate checks. Revocation and unknown outcomes fail closed and do not erase historical receipts.

The current protocol and acceptance contract are in Worker/Agent source and tests. Historical rollout evidence remains in Git and the relevant issues; this ADR does not authorize pairing, production changes or credentials.

## Accepted evolution — browser Owner approval (2026-11-24)

[Spec #1018](https://github.com/lirtual/mcp-workers/issues/1018) records the accepted, not-yet-implemented design: replace manual code transfer and MCP pairing approval with a minimal RCA browser approval entry using the existing Clerk Production identity source. Clerk authenticates the fixed Owner only; a separate explicit approval still binds the reviewed pending identity and requested grant type through the same DeviceCoordinator, followed by existing Agent-signed identity recovery. Reuse the existing pairing protocol rather than introduce OAuth Device Flow or a second enrollment state machine; browser Session Token verification is isolated from MCP OAuth and Agent authentication, with no new high-privilege secret or persistent Agent OAuth credentials expected. Clerk failure must not affect established devices or independent Workflow Session authority. Retire the old MCP pairing tools only after compatible rollout and acceptance; actual Clerk feasibility remains a prerequisite, not an established production capability.

This decision does not authorize implementation, production configuration, release, pairing or credential changes. The existing deployed contract remains authoritative until the staged acceptance in #1018 is complete.
