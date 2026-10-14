# ADR-0015 — v2 owner-reviewed pairing and device-held identity

Status: **accepted security and experience requirements; unverified real-client approval gate**. Date: 2026-10-15.
New consolidated protocol decision for PR #45's accepted Q15–Q20 (prior discovery drafts superseded, not merged). Related: [v2 transport ADR](./0014-v2-multi-device-ws-do.md).

## Accepted requirements

1. **Portal approval, two distinct steps (Q15/Q17=A).** Through the existing Remote-Control-only `MCP_ACCESS_TOKEN` authenticated MCP surface, the owner first **looks up** the pending device by its locally shown code and reviews the sanitized name and immutable public-key fingerprint. A **separate explicit confirmation** for that same pending request/fingerprint then approves it. Lookup alone must never grant a credential. Invalid/missing Bearer, changed key, expired request or concurrent approval fails closed.
2. **On-device code (Q16/Q18=A).** A fresh installation shows **10 cryptographically random Base32 characters (50 bits), expiring after 10 minutes, single use**. Code generation is local; it is bound to one pending device public key. The DO stores a verifier, not a plaintext code; approval consumes the pending record atomically. Strict rate limits, pending-entry caps and constant-time verifier checks are part of security acceptance, with boring server-side constants rather than a configuration framework.
3. **Per-installation keypair (Q19=A).** The Agent generates its own distinct asymmetric private/public keypair, keeps the private key locally under the account's OS permissions, and submits only the public key. Use standard **Ed25519** if Node.js/Workers interop verification succeeds; specify a fixed versioned wire encoding and signed transcript. An Agent must sign a fresh server nonce bound to the domain/protocol/`device_id`/session. Reject reused or wrong-key proofs, cross-device substitution and revoked identities. DO SQLite persists public key, opaque `device_id`, approval/revocation state.
4. **Durable independent revoke.** Server commits a tombstone before notifying/stopping online owned sessions and closing a socket. Reject revoked credentials both during reconnection and before every command dispatch. Reinstall/host-name collision never recovers trust without another owner confirmation. A revoked public key cannot re-register as an authorized device automatically.
5. **72h gate (Q20=A).** Five simulated, independently paired devices remain connected for **72 continuous hours** in nonproduction; prove DO hibernation, Free quota margin, websocket recovery, liveness, nonce replay defense and revoke. No claim this test has been run.

## Human-approval security caveat

Static Portal Bearer validates **token possession only**. It does *not* attest a physical person; two tool calls from an LLM are not cryptographic human proof. The accepted UX requires a separately observed owner-confirmation action in the real ChatGPT/MCP client. **Release is blocked** if the actual client cannot reliably distinguish explicit owner consent from autonomous tool invocation. If that gate fails, propose a narrow out-of-band human verification mechanism for separate approval rather than silently turning `approve: true` into authorization. No new OAuth/browser service is approved now.

## Simpler protocol boundary

- Agent sends limited, preauthorization pending-public-key + locally generated code verifier through a separate bounded Agent-only HTTPS bootstrap path. It is **not** the MCP endpoint, and cannot run file/Shell tools.
- Owner's first MCP tool shows immutable pending identity/fingerprint; second MCP tool confirms exactly that pending item, consuming the code once.
- The Agent can check pairing status in a bounded way. Only after approval may it obtain a fresh server challenge and open an operational `wss` channel by signing that challenge. Prefer authenticating at upgrade instead of retaining idle unauthenticated control sockets.
- Owner-scoped DO selection is internal and fixed, not derived from a public caller-supplied tenant/DO ID. Limit and expire public pending entries, signed challenges and unauthenticated rate; ignore untrusted hostnames as identity.
- Never expose the Portal Bearer, Agent private key, Cloudflare admin token, raw pairing code or raw command payload in logs, chat tool results or installer arguments.
- WSS connection state is volatile; SQLite approval/tombstones are authoritative. A short-lived socket attachment/epoch cannot override current revocation. Duplicate sockets use a deterministic epoch fence; no in-memory-only identity records.

## Test obligations

Invalid/stolen code, rate limit, wrong fingerprint, two approvals racing, lookup-only, fake owner confirmation, compromised bootstrap client, wrong/replayed Ed25519 signature, forged `device_id`, stolen/old keys, revoked socket, concurrent duplicate connects, Agent restart and pending pairing expiry must fail closed. One malformed device must not affect another. After a network gap, local `operation_id` receipt is authoritative; never replay uncertain writes/Shell.

## Out of scope

No per-device OAuth app, Cloudflare One/Access login, shared `REMOTE_CONTROL_DEVICE_TOKEN`, user-managed permanent installer secret, fleet identity service, automatic trust on installation, and no new CI or production changes.

References: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ · https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ · [v2 Spec](../V2-MULTI-DEVICE-SPEC.md).
