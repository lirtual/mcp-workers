# ADR 0003 — Remembered Profile pairing expires after 30 days inactive

Status: Accepted as design consensus, 2026-10-31. **Not implemented or released.**

## Decision

Keep the existing per-Profile Extension Grant and independently owner-selected Browser Control Session. Replace indefinite remembered ("permanent" internally) pairing with server-enforced **30-day idle expiration**.

A remembered Profile with locally selected ON and genuinely live authenticated WSS has **no running countdown**. Explicit OFF starts one 30-day countdown; repeated Stop does not extend it. ON with no authenticated live connection for 30 days also expires. An explicit locally initiated OFF→ON with successful Access verification before the deadline restores the grant to its full allowance, while an automatic reconnect of an already-ON Profile merely clears a live-disconnection countdown before expiry. After expiry, the old Endpoint grant is irrevocable; new pairing requires the existing same-Profile proof and Access flow (which may reuse valid SSO, not necessarily a fresh OTP). Temporary browser-session grants and their bounded server lease remain unchanged.

The server owns deadlines using trusted server time and admission checks; neither extension local timers nor MCP agent actions can renew a grant. Keep Endpoint identities and historic anti-replay receipts across upgrades/expiry. Expose stable human-editable alias plus truthful browser/platform and connectivity metadata without pretending an Endpoint is a physical machine.

## Context and alternatives

The old indefinite remembered grant has good everyday usability but leaves unused OFF/lost devices authorized indefinitely. An absolute 30-day TTL or activity-based rolling renewal would interrupt a deliberately ON, connected Profile or allow background traffic to keep dormant devices forever. Per-action OTP and a separate device-management service would impose additional ongoing complexity and contradict #531's local-control/SSO model. Owner selected ON/online hold + OFF/offline 30-day expiry as the intended balance.

## Consequences

Continuously ON **and online** remains authorized indefinitely; this is an explicitly accepted residual risk, not an assertion of periodic reauthentication. "Online" must be based on fresh authenticated transport activity, not an unverified local ON bit or incidental updated timestamp. Client clock skew, stale sockets, delayed cloud Stop, DO alarms, callback races and legacy clients must fail closed rather than extend expired authorization. Default listings may hide revoked/expired identities, but not delete Unknown/Operation receipts. Reuse the current DO storage, Alarm and same Chrome/Edge extension release system; no new deployment service or configuration knobs.
