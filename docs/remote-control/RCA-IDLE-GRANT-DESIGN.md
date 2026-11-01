# RCA permanent-device idle grant — Grill With Docs

Status: **design in progress**, not an implementation or deployed policy.
Owner's confirmed 2026-11-01 decisions: **B — Browser-style ON-online hold; Grill Q1–Q8=A**.
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
| Owner-confirmed OFF -> ON before expiry | Owner-controlled local start with signed fresh authorization before expiry clears it; no repeat OTP | Browser uses verified local owner activation through existing Access |
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

## Second-round resolved decisions (2026-11-01)

- **Q5=A — Owner OFF during a network outage.** A deliberate local
  OS-owner Stop persists a private, install/upgrade-safe **stop intent**
  before stopping the Agent. When the Worker cannot be reached, the local
  service remains OFF and must not auto-reconnect or restart. On a subsequent
  owner Start, the Agent must first reconcile the pending OFF intent through
  a fresh signed authorization exchange; the server must apply the earlier
  of its **already established offline deadline** and any newly acknowledged
  Stop deadline. The client clock or delayed Stop receipt must **never**
  move an earlier deadline forward. An offline Stop may remain *cloud-
  unconfirmed*; local OFF is immediate, cloud revocation/expiry is only
  promised after server-side validation. Don't claim full cleanup when the
  server was unreachable.
- **Q6=A — Owner-controlled local recovery before expiry.** The existing
  OS owner explicitly runs `rca start` (or an equivalent platform-native
  service manager command), retains the device private key and proves the
  same approved identity through existing fresh signed session challenge/
  epoch. The Worker processes any pending signed Stop first, checks the
  original deadline, then permits a distinct explicit Resume transition
  and returns to ON/online hold. This is **not** a new pairing or a fresh
  OTP; neither remote MCP tools nor ordinary Agent auto-reconnect may
  clear OFF. Linux/Windows/macOS command support is part of the later
  implementation, not a claim that every installed CLI already supports it.
- **Q7=A — Expired local identity and receipts.** On expiry the old
  device grant is denied, disconnected when feasible, and lazily removed
  from the 64-slot active authorization registry. Preserve the old local
  key, device ID and SQLite Operation Receipts, especially Unknown/unresolved
  operation IDs. A new key and ID may replace the installed identity only
  through the existing **explicit owner-approved fresh pairing** with
  separately verified promotion; no background re-pair, deletion of old
  evidence, or blind replay. The old key cannot authenticate after expiry.
- **Q8=A — Legacy Agent compatibility.** Previously paired, genuinely
  online older Agents keep normal behavior; pre-migration legacy offline
  grants get the full one-time migration allowance. All permanent
  devices remain subject to server-side *offline* expiry. Old versions
  lacking explicit signed Stop/Resume support cannot claim or trigger
  these new control transitions; don't infer deliberate OFF from a
  disconnected legacy socket. Enable explicit OFF/Resume only with a
  verified compatible local Agent version. No forced or implicit upgrade
  of paired Windows/Linux hosts or unshipped macOS candidates.

**Sequence rule:** admission for a newly signed reconnect must check
existing durable expiry **before** recognizing authenticated online;
out-of-order Stop/Resume/reconnect must not clear a prior owner OFF. Server
authorization loss means no new operations even when old local receipts
still show admitted or Unknown work.

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

## Third-round dependent Grill frontier (pending owner decisions)

**Q9 — Trusted online checkpoint:** Reuse the existing signed 15-minute
Agent authorization probe, persisted WSS attachment and bounded server-side
online evidence; checkpoint durable last-online at a bounded frequency
instead of per-packet writes. Network loss/stale heartbeat starts the full
period at the latest *trusted* server observation, not last_connected_at.
Accept a small observation granularity (recommended). Alternative: add
high-frequency heartbeat and storage writes for near-second precision.

**Q10 — Race priority and accepted work:** Server-side expiry and Revoke,
then owner OFF, beat a late old socket, Stop retry, offline auto-reconnect,
or stale Resume. A pre-expiry local owner Resume needs a fresh signed proof
and epoch; all dispatches recheck authorization. Already admitted work and
Unknown receipts remain truthful and unreplayed (recommended). Alternative:
recover connectivity optimistically before durable OFF reconciliation.

**Q11 — Client API and status compatibility:** Preserve existing
list_devices `online|offline` status and stable full device_id; add
minimal separate `owner_stopped` (only when known) and `idle_expires_at`
server-owned fields, rather than change the status enum or add a new MCP
tool, page or management service (recommended). Legacy unknown Stop
intent must be displayed as unknown, not guessed.

**Q12 — Release and owner acceptance gates:** Implement scoped Worker
and Agent changes using existing CI and release mechanisms; test Worker
expiry/Stop/reconnect/64-slot behavior plus compatible native Linux and
Windows. Independently assess macOS only when its candidate and real
owner Mac are available. Production release and real paired-device
Stop/Resume/expiry acceptance require specific authorization; keep existing
service available until then (recommended). Alternative: a single
big-bang Worker/Agent cutover, which risks disconnecting live devices.

Further questions are only necessary if these answers leave a materially
different safety, compatibility or complexity decision. No unanswered
option is silently selected.
