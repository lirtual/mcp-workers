# RCA permanent-device idle grant — Grill With Docs

Status: **design in progress**, not an implementation or deployed policy.
Owner's confirmed 2026-11-01 decisions: **B — Browser-style ON-online hold; first Grill round Q1–Q4=A**.
The same online-reset contract is shared with [Browser #626](https://github.com/lirtual/mcp-workers/issues/626).
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

**Default idle period = 14 days**, optional reviewed GitHub Actions Environment Variable
`RCA_PERMANENT_IDLE_DAYS` (1–90 integer days); absent/empty means 14. Invalid
nonempty values fail release checks and runtime authorization closed. A release
change affects future newly started deadlines only, not existing persisted
absolute deadlines. RCA temporary grants retain their independent, fixed,
nonrenewable **24 hours**.

## Shared Browser / RCA online-reset contract — agreed

| Event | Permanent RCA | Browser remembered Profile |
| --- | --- | --- |
| Owner ON and freshly, authentically ONLINE | Hold indefinitely, **no countdown** | Same |
| Remains ONLINE for weeks without work | Stay paired; remote tool activity is irrelevant | Same |
| ONLINE -> OFFLINE (not owner Stop) | Start **fresh full configured period** counted from last trustworthy server-observed online evidence; not from initial connection | Same |
| Automatic authenticated reconnect before expiry while owner intent remains ON | Cancel offline countdown and restore indefinite ONLINE hold | Same |
| A later fresh disconnection after a genuine online interval | Start a **new full configured period**; do not reuse the earlier shorter deadline | Same |
| Owner explicit OFF | Keep first OFF deadline, repeated stop cannot extend; no automatic reconnect can remove it | Same |
| Owner-confirmed OFF -> ON before expiry | Only valid local owner-controlled restoration plus signed fresh authorization may clear deadline; see next Grill questions | Browser uses verified local owner activation through existing Access |
| Expired / revoked | Old grant cannot be refreshed by being online; needs fresh pairing | Same |
| Temporary | Fixed, nonrenewable 24 hours | Keep existing browser-session semantics, separate from remembered policy |

**“Online reset” is not a rolling write on every heartbeat**: the server holds
no deadline while fresh signed WSS connectivity is provable; on losing that
proof, it starts a full-duration deadline anchored to the latest **trusted
server-observed** online instant, with bounded checkpoint precision. Reconnect
*after expiry* cannot reset. A stale open socket, unsigned heartbeat, an
MCP tool request or a client timestamp cannot refresh the grant. The
online-reset rule **never resets explicit OFF**. This is one shared logical
model, **not** a shared RCA/Browser database or runtime service.

## First-round resolved decisions (2026-11-01)

- **Q1=A:** Only an **explicit local owner-confirmed managed Stop** becomes
  permanent OFF; crash, sleep and network loss are ON-but-offline. The local
  stopped marker is retained on reboot and installer upgrades.
- **Q2=A:** One-time migration: currently approved/verified ONLINE permanent
  Agents retain online hold; legacy OFFLINE grants start a full 14-day (or
  configured) server-time period at migration, never immediately expire from
  stale last_connected_at. Do not restart an owner-stopped service during
  migration; migrate stopped and uncertain states conservatively.
- **Q3=A:** Validate the one optional release-time variable and use existing
  official GitHub Actions release; no management UI or second workflow.
- **Q4=A:** Extend current list_devices with true online/authorized/OFFLINE
  states and absolute remaining deadline only when counting down. Hide
  expired grants from default valid list; no second device-management UI.

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

## Next dependent Grill frontier (pending owner decisions)

**Q5 — Stop intent when offline:** The owner can locally Stop while the
server is unreachable. Choose whether to record the local Stop as immutable
local intent and later reconcile with the server **without extending an
earlier trusted offline deadline** (recommended), or use only server-observed
disconnect (loses explicit Stop semantics).

**Q6 — OFF -> ON local owner proof:** RCA has no Browser Access toolbar.
Choose local, owner-confirmed `rca start` (platform-native equivalent) plus
existing signed session proof and a new server-accepted grant generation
**before** expiry (recommended; no OTP every restart) versus a new MCP owner
approval for every Stop/start. No remote tool may resume a stopped Agent.

**Q7 — Expired local identity:** Preserve local keys, old device ID and
SQLite Operation Receipts/Unknown. A stopped/expired Agent must use the
existing *explicit* owner re-pair procedure; fresh key and ID only after
approval and no automatic retries (recommended). Alternative is deletion
of identity on expiry, which risks irrecoverable local evidence.

**Q8 — Older Agent and rollout:** Version gate the new signed Stop/Resume
contract. For legacy Agents, use safe bounded OFFLINE expiry and require
explicit local upgrade to enable owner Stop/Resume; don't guess intent from a
legacy disconnected socket (recommended). Alternative is immediate uniform
enforcement including incompatible old clients.

Later frontier: race fences, offline heartbeat checkpoint granularity, genuine
revocation/Unknown effects, Windows/Linux/macOS native behavior, and real
end-to-end acceptance. No unanswered option is silently selected.
