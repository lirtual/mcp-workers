# RCA permanent-device idle grant — Grill With Docs

Status: **design in progress**, not a Spec, implementation or deployed policy.
Owner's confirmed 2026-11-01 decision: **B — Browser-style ON-online hold**.
Reference [Browser MCP #626](https://github.com/lirtual/mcp-workers/issues/626),
[ADR-0017](./adr/0017-v2-device-revocation-without-tombstones.md)
and [ADR-0018](./adr/0018-v2-temporary-agent-pairing-lifecycle.md).

## Settled intent

Reduce abandoned RCA devices occupying 64 active-device grant slots while
normally connected permanent Agents continue without repeated OTP.

**ON and genuinely signed-WSS online:** no idle countdown, regardless of
how long since an actual remote tool was used. **Owner OFF or ON but offline:**
start an idle countdown, and before expiry a valid owner restart or legitimate
automatic ON reconnect may recover. After expiry, deny new authorization and
release the grant; never silently re-pair. Existing fixed, nonrenewable
24-hour temporary mode is untouched.

Browser #626 uses **14 days by default** and a release-time override of
**1–90 days**. Exact RCA override/migration/recovery edge semantics are still
subject to user confirmation, not silently assumed.

## Verified existing code boundaries

- Server module apps/remote-control-mcp-worker/src/v2-session.ts authorizes
  every nonrevoked permanent grant indefinitely; temporary expires after
  approved_at + 24h. listLiveGrants cleans expired records lazily.
- Server holds per-socket signed session/epoch information and checks recent
  authorization evidence (15-minute Agent probe, bounded online lease).
  The persisted last_connected_at timestamp records connection metadata,
  NOT the latest trusted activity on a long-lived WebSocket. Using it as
  the last-online timestamp would prematurely expire healthy long sessions.
- Server device revocation has no permanent tombstones; deletion invalidates
  stale session nonce/epoch, and existing 64-slot capacity is bounded.
- RCA has no common Browser-style ON/OFF toolbar. Linux systemd, Windows
  user task and candidate macOS LaunchAgent have different local Stop modes.
  Deliberate stop, sleep, crash and offline transport are different states.
- Agent-local Ed25519 identity and SQLite operation receipts are separate from
  server approval. Unknown operations cannot be replayed on expiry/re-pair.

## No expansion of infrastructure or authority

Reuse existing Owner DO/Worker, signed WSS and pair approvals, on-device
service management and existing CI/release flows. No new Worker, database,
periodic Cron, infinite revoked-key blacklist, automatic OTP, or automatic
new identity. Expiration must deny new session challenge/WSS/read/mutation
authorization even with a stale socket or late DO Alarm. Past admitted effects
and durable local Unknown receipts must not be erased or silently replayed.

No production release, credential mutation or installed device change is
authorized by this design review. macOS candidate CI is not real owner-Mac
evidence.

## Decision frontier (not yet agreed)

Q1: What is an explicit persistent Owner OFF versus generic disconnection?
Q2: What verified local action safely restores an Owner OFF before expiry?
Q3: How do existing permanent grants migrate without abrupt expiration?
Q4: How should expired identities/re-pair preserve local receipts and history?
Q5: Which release-time idle-period configuration is required?

After resolving these, review hibernation/last-online checkpoints, stale
connection/race/receipt behavior, UI truthfulness, and migration verification.
