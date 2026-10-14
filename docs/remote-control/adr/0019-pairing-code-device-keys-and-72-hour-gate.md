# ADR-0019 — Owner-reviewed one-time pairing, per-installation key proof, and 72-hour Free-plan gate

Status: **accepted v2 protocol requirements and test gate, NOT implementation or rollout approval**.
Date: 2026-10-15. Owner decisions: grilling **Q17=A, Q18=A, Q19=A, Q20=A**.
Depends on [ADR-0018](./0018-v2-websocket-do-transport-and-portal-pairing.md); existing single-device production v1 is unaffected.

## Context

The accepted v2 design uses an Agent-initiated WSS connection to a SQLite-backed Durable Object (DO) with WebSocket Hibernation, with a single Portal Bearer-authenticated MCP endpoint and per-device approval. The earlier pairing and soak-test defaults were proposals. The owner has now chosen the approval sequence, pairing-code strength/lifetime, long-term cryptographic identity, and 72-hour test gate.

The existing Portal middleware validates a static `MCP_ACCESS_TOKEN`; it establishes **possession of a credential, not a separately authenticated human presence**. Consequently, the accepted "owner explicitly confirms" UX is an interaction/authorization requirement, not a claim that ChatGPT can prove a human clicked. A genuine human-presence requirement would need an additional verified channel and a new decision.

## Accepted decisions

1. **Q17=A — Two-stage owner-reviewed approval in Portal-authenticated MCP**. The owner first queries **a particular pending pairing** by entering the code and reviewing a sanitized candidate label and a stable short fingerprint of the Agent-generated public key. A **distinct, explicit confirmation** then approves that same pending identity; one lookup must never approve or issue an operational credential. An independent confirmation action must be distinguishable from ordinary listing, with mismatched, expired, revoked or changed pending identity rejected. Keep the current Remote-Control-specific MCP Bearer authentication; do **not** claim Portal login, Cloudflare One login, OAuth, or ChatGPT UI tool consent authenticates a human. Acceptance must test the real client confirmation flow. No automatic Agent activation from an LLM-only suggestion.
2. **Q18=A — Local 10-symbol random Base32 code, 10-minute TTL, one use.** The installed Agent displays a cryptographically generated **10-character Base32 code representing 50 bits of random entropy** (excluding any separators; if a checksum reduces entropy, this requirement is not met). Store only a verifier/hash in durable pending state, never the raw code in Cloudflare logs, Worker analytics, or device lists. A code is bound to one pending key and one enrollment attempt, expires 10 minutes after issue, atomically transitions once, and is immediately invalidated on approval or denial. A stolen/guessed code alone must **not** authorize Shell or acquire a durable device credential. Rate-limit creation and confirmation, bound concurrent pending entries, and reject collisions and replay; precise attempt budgets remain implementation-level constants and need explicit tests, not new environment variables.
3. **Q19=A — Agent-generated asymmetric device keypair and proof of possession.** Each fresh installation generates an independent private/public keypair locally. The private key stays on the device with restrictive filesystem/OS permissions and is **never sent to the Worker, DO, Portal or chat**. Pairing atomically binds the owner's approval to that exact public key, an opaque server-issued `device_id`, and one installation. A subsequent WSS session must prove possession through a **fresh server challenge signed by the private key**, with domain-separated transcript binding `device_id`, session context and challenge; verify signature and current **durable** authorization before granting command capability. Prevent nonce reuse, replay and cross-device substitution; duplicate connections require one deterministic fencing rule. The specific cryptographic algorithm/encoding is a spec implementation selection, not another shared static token.
4. **Q20=A — Five simulated devices for 72 hours.** Before any production cutover, run a **nonproduction 72-hour soak** with at least five simultaneously connected, independently paired Linux/WSL2-simulated Agents, realistic sparse messages plus controlled activity, restart, partition/reconnect and revocation scenarios. Record evidence of actual hibernation/wakeup, WebSocket continuity, billable DO requests, GB-s, SQLite read/write/storage, Workers Free requests and other account DO use (including IMA); fail if an active idle-object duration pattern indicates Hibernation did not work or the combined budget would exceed Free quotas. 72-hour test approval here does **not** authorize starting hosted resources or production testing now.

## Invariants that must hold in the buildable spec

- Bootstrap is a **tool-less, bounded, preauthorization channel**; pending Agent cannot dispatch commands, list devices or choose another owner's DO.
- Use a cryptographically strong random generator; avoid 6-digit numeric codes or reproducible host-derived identifiers. Avoid putting sensitive auth material in URL/query, command-line arguments, logs or user-facing MCP tool output.
- Owner review and owner confirmation must refer to the **same** immutable pending request + public-key fingerprint, with one-time atomic commit. A code may not be reused for a different public key if rejected.
- Distinguish `device_id` (opaque installation identity), `device_name` (untrusted editable label), public key (key material bound to identity), `operation_id` (Agent-local mutation receipt identity), and transient socket/session ID.
- Revocation is stored durably before best-effort online stop/close, and **no existing socket remains trusted** merely because it authenticated once; re-check allow/revoke before dispatch. Offline devices cannot be remotely guaranteed to stop processes they already launched.
- Never enqueue new operations for offline devices or blindly retry a mutation with an unknown outcome.
- Favor one owner-coordinator DO for small personal deployments, with SQLite for approvals/device registry/tombstones and Hibernation socket attachments for ephemeral connection metadata. No D1/KV/R2/fleet-management service until a demonstrable need.
- Keep the existing v1 production Worker, Tunnel and Agent untouched, with explicit opt-in migration.

## Consequences

**Benefits:** simple copyable pairing UX, high-entropy single-use authorization step, proof of private-key possession without a shared `REMOTE_CONTROL_DEVICE_TOKEN`, targeted device revocation and a measurable Free-plan acceptance bar.

**Costs/risks:** fresh challenge protocol and Agent private-key storage/recovery, approved pending state/race control, client UI verification, and time-consuming nonproduction 72-hour performance evidence. The static Portal Bearer by itself cannot verify real human presence; approval must be treated as a sensitive authorized MCP operation and tested for unintended AI tool execution.

## Follow-up engineering gates (not new owner decisions)

The [v2 Spec](../V2-MULTI-DEVICE-SPEC.md) defines minimal message envelopes, pairing endpoint/tool contracts, durability and failure semantics. Pairing code attempt budgets, specific signature algorithm/encoding, offline-detection bounds, idle heartbeat mechanism and measurable soak pass/fail thresholds should be resolved and documented there as narrow implementation constants, or explicitly marked as acceptance blockers, rather than inventing a new credential service.

## References

- [ADR-0018](./0018-v2-websocket-do-transport-and-portal-pairing.md)
- [Security and Hibernation acceptance plan](../V2-PAIRING-AND-HIBERNATION-ACCEPTANCE.md)
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
