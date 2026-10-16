# ADR-0017 — v2 device revocation without permanent tombstones

Status: **Accepted product decision; documentation only, not implemented**. Date: 2026-10-17.
Supersedes only the **permanent revoked-identity/tombstone retention** portion of [ADR-0015](./0015-v2-pairing-and-identity.md). All independent owner-confirmation, private-key, explicit-device-routing, operation-receipt and v1-isolation decisions remain in force.

## Context

The v2 preview in [Draft PR #58](https://github.com/lirtual/mcp-workers/pull/58) currently marks `device:<id>` with `revoked: true` and retains it indefinitely. `list_devices` includes revoked devices. Pairing and device listing scan at most 65 device records and return a capacity error above 64; therefore repeated device removal/re-pairing can exhaust a small single-owner registry even with few active devices.

Permanent denial of the *same public key* is useful only if the owner wishes to maintain a permanent revoked-key blacklist. For this personal installation, the owner explicitly chose not to retain that blacklist or historical device list. The security authority is the *currently approved device record*, not a record of every previously approved key.

## Decision

1. **Device removal means authorization deletion.** Revoke must atomically remove the target device's durable approval and its outstanding WSS challenge/epoch authorization. Commit the loss of authorization before attempting any online connection or managed-process cleanup. If that durable change cannot be confirmed, fail closed and do not report success. Never infer success from closing a socket alone.
2. **Only approved devices are enumerable.** `list_devices` returns current approved identities (online/offline) and does not return deleted/revoked history. A missing/deleted `device_id` cannot authorize a reconnect, tool dispatch, or recovery, even when a stale socket still exists.
3. **No permanent revocation log, tombstone, blacklist or 90-day cleanup scheduler.** Delete the device record and related per-device session state instead of keeping `revoked: true`. Device-capacity accounting must count approved identities, not historic removals. Make the existing 64-entry boundary exact; the 65th record may never be committed accidentally.
4. **Re-pairing is a fresh permission grant, never automatic restoration.** Old `device_id` authorization stays invalid. Another pairing requires the existing authenticated owner lookup/prepare and independent device-terminal signed challenge flow, with a newly approved `device_id`. The normal interactive installer should create a fresh local key for a new enrollment and must not silently re-enroll on a background reconnect or restart.
5. **Explicit security trade-off.** Without a retained revoked-key fingerprint, the server cannot *permanently* identify or blacklist a formerly revoked public key; a party holding it may submit a **new pending request**. That request must have no file/Shell/WS permission until it passes the complete, separate human-assisted pairing procedure. Server-side enforcement of never reusing any old public key would require retaining history and is therefore **not claimed**.
6. **Revocation cannot undo operations that have already reached the Agent.** Reject new dispatches after deletion, close current sockets, attempt to stop only Agent-owned managed sessions, and report `confirmed`/`unconfirmed`/`offline` accurately. For already admitted mutations, preserve Agent-local operation receipts and `timeout_unknown` reconciliation; do not blindly replay.
7. **No new infrastructure.** Reuse the existing owner-scoped Durable Object and Agent. No D1/KV/R2, extra admin worker, timers, periodic cleanup task, new CI or production cutover for this choice.

## Consequences

- **Benefits:** bounded active-device registry, no permanently accumulating revoked entries, a clean daily device list, simpler lifecycle and no retention policy/scheduler.
- **Trade-off:** the server loses revoked-device history, `already_revoked` becomes an ordinary `not_found`, and permanent old-public-key exclusion is no longer promised. Independent local owner approval remains the critical re-enrollment security gate.
- **Migration:** when implementing on the v2 preview, safely remove existing historical tombstones after confirming the new authorization checks do not depend on their existence. Ensure missing record semantics cannot trigger automatic re-pair in an unattended Agent. No v1 production database or v1 identity is altered by this decision.

## Outstanding grilling frontier — not yet approved

- Whether a **temporary debugging device** is time-limited authorization or single-operation authorization, and which default duration and execution semantics apply.
- Whether temporary onboarding preserves the existing two-code independently confirmed pairing flow or adopts a different reviewed human-consent mechanism.
- On expiry, the exact rule for in-flight and managed processes, and whether to use foreground-only/no-service installation.

Those are **questions**, not accepted decisions, and must not be implemented based on this ADR alone.

## Required verification before implementing/deploying

Revoke-vs-login and revoke-vs-dispatch races; stale/suspended socket rejection; no resurrected identity after restart/Hibernation; denied read/write after deletion; repeated revoke truthful `not_found`; no leaked capacity after multiple pair/revoke cycles; preexisting operations return honest `timeout_unknown`; independent-terminal proof for any re-pair; unchanged v1/production behavior. All changes remain gated by the existing nonproduction v2 acceptance and explicit release approval.
