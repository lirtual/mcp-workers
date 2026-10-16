# ADR-0015 — v2 owner-reviewed pairing and device-held identity

Status: **accepted two-code UX with one local-terminal challenge entry; independent real-host human confirmation and production security validation still pending**. Updated: 2026-10-16.
New consolidated protocol decision for PR #45's accepted Q15–Q20 (prior discovery drafts superseded, not merged). Related: [v2 transport ADR](./0014-v2-multi-device-ws-do.md).

> **Superseded section (2026-10-17):** The permanent **tombstone/previous-public-key ban** in accepted requirement 4 and subsequent historical references to tombstones have been superseded by [ADR-0017 — device revocation without tombstones](./0017-v2-device-revocation-without-tombstones.md). The owner now requires an atomic removal of approved identity/session authorization, no permanent removed-device registry, and full separate owner/device confirmation for any new pairing. All other ADR-0015 decisions remain applicable. The earlier language is preserved below as historical context; do not implement its superseded retention rule.

## Accepted requirements

1. **Portal review and independent local confirmation (Q15/Q17=A; owner refinement 2026-10-15).** The existing Remote-Control-only `MCP_ACCESS_TOKEN` lets the owner look up one pending device and immutable public-key fingerprint, then invoke `pairing_prepare({pairing_id,expected_fingerprint})` to obtain a **single-use 12-character Base32 challenge valid at most five minutes**. Neither MCP tool approves a device. The owner manually enters **only the new 12-character challenge** in the **new Agent's own terminal/SSH session**; the initial 10-character pairing code is held by the installer in local process memory, not retyped. That Agent signs the pending-record-bound transcript with its installation-specific private key. The DO alone atomically validates both and approves a `device_id`. No `pairing_confirm(approve:true)` tool is allowed.
2. **On-device code (Q16/Q18=A).** A fresh installation shows **10 cryptographically random Base32 characters (50 bits), expiring after 10 minutes, single use**. Code generation is local; it is bound to one pending device public key. The DO stores a verifier, not a plaintext code; approval consumes the pending record atomically. Strict rate limits, pending-entry caps and constant-time verifier checks are part of security acceptance, with boring server-side constants rather than a configuration framework.
3. **Per-installation keypair (Q19=A).** The Agent generates its own distinct asymmetric private/public keypair, keeps the private key locally under the account's OS permissions, and submits only the public key. Use standard **Ed25519** if Node.js/Workers interop verification succeeds; specify a fixed versioned wire encoding and signed transcript. An Agent must sign a fresh server nonce bound to the domain/protocol/`device_id`/session. Reject reused or wrong-key proofs, cross-device substitution and revoked identities. DO SQLite persists public key, opaque `device_id`, approval/revocation state.
4. **Durable independent revoke.** Server commits a tombstone before notifying/stopping online owned sessions and closing a socket. Reject revoked credentials both during reconnection and before every command dispatch. Reinstall/host-name collision never recovers trust without another owner confirmation. A revoked public key cannot re-register as an authorized device automatically.
5. **72h gate (Q20=A).** Five simulated, independently paired devices remain connected for **72 continuous hours** in nonproduction; prove DO hibernation, Free quota margin, websocket recovery, liveness, nonce replay defense and revoke. No claim this test has been run.

## Human-approval security caveat

Static Portal Bearer validates **token possession only**. Two MCP calls from a model cannot cryptographically prove a human. The owner therefore accepted a separate **local-terminal confirmation channel** instead of an independent OAuth/browser service. This reduces accidental autonomous authorization only under the trust assumption that the model cannot control the newly installed Agent's terminal/private key and cannot relay its challenge there. A compromised/remote-controllable host is **not** an independent human-presence factor; tests must not claim universal human identity verification. Production pairing remains gated on actual client/host threat-model and security validation, not merely mock signature success.

## Simpler protocol boundary

- Agent sends limited, preauthorization pending-public-key + locally generated code verifier through a separate bounded Agent-only HTTPS bootstrap path. It is **not** the MCP endpoint, and cannot run file/Shell tools.
- Authenticated `pairing_lookup` shows immutable pending fingerprint. Authenticated `pairing_prepare` generates a short-lived one-use local confirmation challenge matching that fingerprint; it cannot approve. The new Agent's terminal requires manual entry only of the challenge; its process retains the original pending code, and only the signed bound proof allows the DO to consume the pending request atomically.
- Once local challenge signature has approved the device key, the Agent may perform a **separate fresh WSS session challenge** during #50. The local pairing challenge is **not** an operational WebSocket credential. Authenticate WSS sessions against current durable approval/revocation before any command dispatch.
- Owner-scoped DO selection is internal and fixed, not derived from a public caller-supplied tenant/DO ID. Limit and expire public pending entries, signed challenges and unauthenticated rate; ignore untrusted hostnames as identity.
- Never expose the Portal Bearer, Agent private key, Cloudflare admin token, raw pairing code or raw command payload in logs, chat tool results or installer arguments.
- WSS connection state is volatile; SQLite approval/tombstones are authoritative. A short-lived socket attachment/epoch cannot override current revocation. Duplicate sockets use a deterministic epoch fence; no in-memory-only identity records.

## Test obligations

Invalid/stolen code, rate limit, wrong fingerprint, repeated/expired/local confirmation challenge, two signed confirmations racing, lookup-only, model-only confirmation, compromised bootstrap client, wrong/replayed Ed25519 signature, forged `device_id`, stolen/old keys, revoked socket, concurrent duplicate connects, Agent restart and pending pairing expiry must fail closed. One malformed device must not affect another. After a network gap, local `operation_id` receipt is authoritative; never replay uncertain writes/Shell.

## Out of scope

No per-device OAuth app, Cloudflare One/Access login, shared `REMOTE_CONTROL_DEVICE_TOKEN`, user-managed permanent installer secret, fleet identity service, automatic trust on installation, and no new CI or production changes.

References: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ · https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ · [v2 Spec](../V2-MULTI-DEVICE-SPEC.md).
