# ADR-0018 — v2 temporary debugging pairing tied to Agent exit

Status: **Two owner decisions accepted; failure handling still in Grilling with Docs; documentation-only**. Date: 2026-10-17.
Related: [ADR-0015 — independent owner pairing](./0015-v2-pairing-and-identity.md), [ADR-0017 — deletion-based device removal](./0017-v2-device-revocation-without-tombstones.md), and [v2 Spec](../V2-MULTI-DEVICE-SPEC.md).

## Context

The existing v2 Preview [Draft PR #58](https://github.com/lirtual/mcp-workers/pull/58) supports `install-v2.mjs --foreground`: it does not create a systemd unit, but it **does persist** the normal device key and `.device-id` locally. On SIGINT/SIGTERM, `v2-main.ts` aborts the signed WSS reconnect loop and exits; it **does not revoke** the cloud authorization, delete local credentials, or prove owned managed processes were stopped. The Worker currently offers an authenticated owner-side `revoke_device` MCP tool, not a device-authenticated self-revocation operation.

Treating an ordinary WebSocket close as proof of intentional termination is unsafe: network loss, WSL suspension, and application crashes are indistinguishable from exit to the server. A separate fixed authorization TTL would also conflict with the owner's selected user experience.

## Accepted owner decisions — Grilling round 2026-10-17

1. **Q1=C — exit-coupled temporary authorization.** The temporary device is intended to lose its approval **when the temporary Agent is closed**. It has **no fixed 2-hour/other wall-clock authorization lifetime** and is **not** a single-use remote operation. Closing is an intentional Agent lifecycle event; transient offline observations must not automatically be equated with a completed voluntary shutdown without a separately approved failure policy.
2. **Q2=A — reuse the existing independent two-code pairing.** A newly paired temporary Agent shows the same cryptographically random 10-character pending pairing code; the owner calls authenticated MCP `pairing_lookup` and `pairing_prepare` and manually enters the one-use 12-character challenge in the *new device's local terminal*. The locally held private key signs the proof. No model-only authorization, no weakened fingerprint/key binding, no new OAuth service or alternative one-code trust path.
3. **No additional authority.** Temporary pairing gives no more file/Shell/process privilege than the existing separately enabled v2 tool capabilities. Reuse owner-scoped DO and Agent execution/receipt semantics. Existing `operation_id` receipts and `timeout_unknown` handling are unaffected by the absence of an overall temporary-device lifetime.
4. **Separation from normal permanent devices.** The new temporary-lifecycle semantics must be explicit; do not cause ordinary durable device installations to auto-revoke on a routine Agent restart or network reconnect. Existing v1 production remains isolated.
5. **No inference of successful cleanup.** The selected UX is an intended outcome, **not** a guarantee of cleanup after abrupt SIGKILL, power loss, network partition, untrusted host compromise or unreachable server. A revocation failure cannot be silently reported as success. The precise crash recovery and session-completion policies remain undecided below.

## Technical reconnaissance (facts, not approved implementation details)

- `--foreground` already runs v2 without systemd, providing a likely reuse point, but its identity files currently use the normal persistent path and it rejects an installed v2 unit.
- Normal signed WSS reconnects use bounded backoff. A transient socket close is not proof of intentional exit; treating it as revocation would turn short network glitches into repeated mandatory re-pairing.
- A standalone temporary Agent cannot invoke the existing Portal Bearer-only `revoke_device` operation without being given an inappropriate owner secret. A **narrow, signed, self-only Agent exit/revoke proof** is one candidate for implementing the owner-approved behavior; the exact transport, nonce binding, transaction ordering, retry bounds and failure UX still require design review. No unauthenticated or name/IP-based revoke may be introduced.
- Existing Managed Sessions have bounded lifetimes (ordinary development commands up to 60 minutes under ADR-0016), owned-process termination/unknown-result behavior, and local operation receipts. **No fixed temporary-device lifetime does not remove process deadlines.**
- For existing revocation the owner DO first commits loss of authorization, then attempts bounded online owned-session cleanup. Any temporary Agent shutdown design must honor the same fail-closed authorization and honest local process accounting without claiming to cancel already applied file mutations.

## Open decision frontier — NOT APPROVED YET

**Q3 — unexpected disappearance:** if the temporary Agent crashes, is killed without cleanup, loses power, or its WSL distro is stopped, should its approved identity stay `offline` until an explicit owner revoke (preserves reconnect after network faults), or should a bounded offline grace period *also* revoke (can falsely drop a temporarily disconnected device)? Neither choice may claim instantaneous guaranteed cleanup after an unobservable failure.

**Q4 — voluntary exit with active work:** should closing the Agent immediately reject new dispatch and request bounded stop of **only Agent-owned managed sessions**, reporting ambiguous termination as `uncertain`, or wait for selected running work to finish before revoking? Already-applied writes are not rolled back; an interrupted receipt cannot be treated as failed/replayable.

**Q5 — credentials and failed exit:** should temporary mode use isolated owner-only ephemeral key/ID files and delete them **after confirmed server revocation**, retaining a recoverable protected identity when server revocation is unconfirmed; or reuse the regular persistent identity and require manual cleanup? Decide what visible failure message and retry mechanism are needed. None can give the Agent the Portal/admin secret.

**Q6 (downstream, after Q3–Q5) — authenticated exit protocol details:** confirm signed self-only revoke versus another narrow server-validated path, race-proof sequencing, cancellation deadlines, and terminal/automatic shutdown semantics without adding a new infrastructure service or DO alarm. This is an engineering acceptance decision, not assumed in the current round.

## Required later acceptance

A clean SIGINT/SIGTERM exit; network drop with bounded reconnect (never silently treated as human exit); SIGKILL/power loss and offline owner removal; no ordinary-device accidental revoke; stale WSS and revoke-vs-dispatch race; server unavailable during voluntary exit; identical device-label isolation; old key cannot reconnect after confirmed deletion; new pending pairing requires fresh owner and terminal confirmation; running/recently admitted managed Shell and receipt `timeout_unknown` correctness; no residual active-device quota entries after confirmed removal; v1 unchanged.

**No code, installation, CI, deployment, live Cloudflare state or v1 resource changes are authorized by this ADR.**
