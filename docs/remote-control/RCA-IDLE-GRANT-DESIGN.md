# RCA — Permanent device idle-grant lifecycle

**Status:** Final Grill With Docs design consensus (2026-11-01); **design only**.
Owner selected policy **B** and **Q1–Q12=A**, in three rounds.
**Not implemented, merged or production deployed for RCA.**
Related: [Browser Spec #626](https://github.com/lirtual/mcp-workers/issues/626),
[RCA ADR-0023](./adr/0023-online-held-permanent-device-idle-grants.md),
[revocation ADR-0017](./adr/0017-v2-device-revocation-without-tombstones.md),
[temporary grant ADR-0018](./adr/0018-v2-temporary-agent-pairing-lifecycle.md).

## Goal and accepted trade-off

Abandoned permanently paired Agents should stop occupying the existing **64
active device slots**, while genuinely online owner-enabled Agents retain
unattended access without repeated OTP. Explicit user choice **B** means a
device may remain online but completely unused for months **without expiring**.
This is *not* tool-activity-based renewal, an absolute 14-day grant, or a
browser Profile's physical device identity.

One shared RCA / Browser rule: **ON + freshly authenticated ONLINE = no
countdown**. Each authentic ONLINE -> OFFLINE transition starts **a new full
idle period** from the most recent trustworthy **server-observed** online
instant; valid automatic reconnection **before expiry** cancels that offline
deadline and restores online hold. A later true disconnection gets its own
full period. A deliberate local owner OFF has a **sticky, nonrenewable Stop
deadline**; auto-reconnect, heartbeat, MCP calls, repeated Stop and stale
messages cannot refresh it. Browser uses its Chrome/Edge Extension/Access
flow; RCA uses its own Agent identity and local service manager. **Share the
policy, not the Worker, database, credentials or client runtime.**

## Grant states and transitions

| Event / device state | Permanent RCA authorization |
| --- | --- |
| Newly approved and genuinely signed ONLINE | Owner ON, **no deadline** |
| ON, authenticated online for weeks with no tool calls | **No deadline**, continues occupying one active slot |
| ON -> disconnected, sleep, crash, network loss, stale authenticated liveness | Start one **full configured idle period** from last trusted server online observation; device is unusable while offline |
| ON automatically reconnects with valid signed proof **before deadline** | Check expiry **first**, then clear offline deadline and restore online hold; next disconnect begins new full period |
| Owner deliberately stops the managed Agent | Persist protected local OFF intent **before service shutdown**; cloud Stop starts a single deadline on verified transition and blocks new remote operations |
| Local OFF while cloud is unavailable | Locally deny/reject auto-start immediately. Mark cloud Stop **unconfirmed**; when later reconciled, **never extend** an existing earlier offline deadline. Do not call the cloud state stopped until acknowledged |
| Owner repeats Stop or retries delayed Stop | Idempotent; **never extend** the first known deadline |
| Owner locally starts within a valid deadline | Process any pending Stop intent in order; verify current same-device signed proof and **explicit local Resume** before new ordinary tool session. No OTP or fresh pairing |
| Owner OFF and unexpected service auto-start/reconnect | Remain OFF; unsigned/stale/automatic socket cannot Resume or clear deadline |
| Deadline reached (offline or OFF) | Server denies old key/ID on **all new admissions**; lazy delete frees active slot; fresh explicit owner-approved pairing required |
| Owner explicitly Revoke | Immediate final denial on verified server commit, independent of idle countdown |
| Temporary or Workflow Session grant | **Unchanged**; temporary remains fixed, nonrenewable **24 hours** and Workflow Session retains its own immutable run-bound rules |

A scheduled wake-up is not needed to *guarantee admission denial* at/after
expiry: protected admission must always check server time. Storage may be
cleaned lazily on subsequent access; an idle record need not physically
disappear at exactly midnight. A previously admitted operation is **not**
automatically undone or killed at grant expiry.

## Duration and deployment configuration

- Default **14 * 24 server hours**. Optional existing GitHub Actions
  Environment **Variable** `RCA_PERMANENT_IDLE_DAYS` scoped to the existing
  RCA Worker release; unset/empty = 14; valid nonempty decimal integer
  **1–90**, no whitespace/sign/decimal. Invalid nonempty value fails existing
  release preflight and Worker policy **closed**, not widened.
- Use existing selected Worker `release.yml` and reviewed
  `scripts/worker-release-variables.mjs` allowlist, not another workflow,
  remote variable reader, Portal form or dynamic settings store.
  A GitHub Variable edit alone cannot change a running Worker; a separate
  authorized production release is required.
- Configure duration **when a new idle deadline starts**, or during initial
  migration. Never rewrite or silently extend a persisted absolute deadline
  merely because the variable changes.
- Do not modify fixed temporary grant deadlines, Workflow Session grant
  deadlines, pairing-code TTL, Agent protocol keys, or receipt retention.

## Stop, local owner recovery and trust boundary

- OS-owner-issued local Stop is **not** simply WebSocket.close(): persist
  a local private stop marker/intent before a controlled service stop, prevent
  automatic service restarts while owner OFF, and reconcile against server
  under a device-signed, replay-resistant sequence. Preserve marker across
  installer upgrade/rollback. Crash/reboot/sleep **without** this marker
  remains ON-but-offline. Do not guess an OFF from a legacy disconnected Agent.
- Owner-controlled `rca start` (or an equivalent platform-native manager
  command) is **intentional local action**, not a callable remote MCP Resume.
  It is a **target behavior**, not a claim all installed Linux/Windows/macOS
  CLIs already implement the contract. Before normal service dispatch,
  a limited-purpose signed recovery path reconciles pending Stop and
  atomically transitions a **still-valid** grant to ON, establishing a fresh
  generation/epoch. Never temporarily admit ordinary tools to do so.
- Reuse existing Ed25519 pairing key, signed challenge and device epoch,
  rather than creating another OTP/login service. **A signed key by itself
  proves the installed device identity, not cryptographic human presence**:
  local owner intent relies on the existing protected OS account/CLI boundary.
  This is the same owner-trust assumption as existing RCA pairing; no claim
  that stolen key material cannot imitate an owner action.
- Server acknowledgements matter: a local Stop while disconnected is only
  **locally confirmed**, not cloud-confirmed. Owner Resume must validate the
  *earliest* existing server deadline before clearing a Stop. Network failure
  must never be interpreted as an accepted Resume or fresh 14-day lease.

## Trusted ONLINE observation and expiry admission (Q9=A)

1. Existing Agent sends a signed-session **authorization probe every 15
   minutes**; server currently uses a **16-minute** recently-probed window to
   display online status. Reuse this channel, session generation/epoch,
   server time and DO Hibernation attachments. Do **not** introduce high-rate
   heartbeat, per-message durable writes, another timer or Cron.
2. **Critical source boundary:** current `handleIdleSocketMessage` updates
   `last_auth_check_at` in the socket attachment **before** checking the
   approved device and current epoch. That timestamp is a **rate limiter**,
   *not* trusted online proof. Introduce/derive a separate trusted
   `last_verified_online_at` fact only **after** server-side device and
   epoch validation. Neither `last_connected_at`, WSS.OPEN alone,
   client-provided time nor a transport ping is sufficient. Preserve the
   existing precheck rate gate's security role.
3. Persist a bounded, server-owned last-successful-online checkpoint at
   the existing authorization-probe cadence as needed to survive DO
   Hibernation/long-lived online sessions. At most one durable checkpoint
   per successful 15-minute probe interval per permanent device; no write
   on every socket frame. A short checkpoint granularity may make the
   offline deadline up to one probe interval earlier than the physical
   disconnection; this is accepted over high-frequency machinery.
4. On authenticated owner-ON -> genuinely OFFLINE, including stale heartbeat
   but WSS.OPEN, derive **once** `idle_expires_at = trusted_checkpoint +
   configured_duration`. Subsequent list/dispatch requests never reset
   it. Genuine, fresh authenticated reconnect **before** expiry may clear
   it; a later disconnect gets a new full period. ONLINE has no active
   deadline.
5. At the first protected call after silent disconnection, calculate
   expiry from durable trusted evidence and enforce **before** admitting a
   fresh signed session or treating a stale socket as online. Missing
   or corrupt trusted checkpoints cannot confer indefinite access; use
   one-time migration evidence conservatively and fail closed if unknown.
   Physical grant deletion is lazy; lack of cleanup is never permission.
6. Reuse `deviceIsAuthorized` / `grantCurrent`, existing Owner DO
   `listLiveGrants`, signed nonce/epoch checks, message verification
   and read/mutation authorization. Connection display, grant validity
   and operation completion remain distinct facts.

## Concurrent actions and old Agent compatibility (Q10=A)

- **Priority:** confirmed Revoke or elapsed expiry overrides all; owner
  Stop overrides auto-reconnect; only a valid **later local owner Resume**
  may clear a still-valid Stop. Use existing signed epoch/revision plus
  minimal monotonic intent fencing to reject late sockets, duplicate Stop,
  delayed ACK and stale Resume (including Hibernation). Repeated Stop
  must not extend a deadline; earlier offline deadline cannot be replaced
  by a later Stop deadline.
- **Already admitted effects:** no new unauthorized read/write/command
  admission after expiry, but an already started operation is not undone
  or necessarily terminated. Preserve local SQLite receipts, original
  operation IDs and unresolved Unknown across Stop, expiry, upgrade and
  re-pair. Keep explicit Revoke's existing best-effort owned-process
  cleanup and truthful outcome distinctions.
- **First compatible migration:** perform one idempotent server-time
  transition. An existing verified ON/online permanent grant holds without
  a deadline; an existing OFFLINE permanent grant gets the configured
  **full period from migration**, not historical `last_connected_at`.
  Legacy WSS is considered online only after current identity/epoch
  verification. Keep old revoked devices revoked and the old local
  device IDs/receipts; do not start an owner-stopped service.
- **Legacy agents:** normal signed legacy clients can continue online and
  reconnect before their offline deadline. A legacy socket has **no
  explicit Stop/Resume authority**: require an explicitly locally upgraded
  compatible Agent and never infer owner OFF from disconnect. No forced
  upgrade of Windows/Linux hosts or an unpublished macOS candidate.
- **Rollback safety:** an old Worker that doesn't implement this policy
  cannot be represented as enforcing it after rollback. Verify
  authorization/data compatibility and no resurrection of expired keys
  before choosing a formal rollback release; block unsafe rollback or
  require separate owner evaluation, rather than quietly restoring
  indefinite grants or building a second deploy path.

## Discovery and operator controls (Q11=A)

Keep `list_devices` with stable full `device_id`, existing name,
`status: online|offline`, and `grant_type`. Add only
`owner_stopped` when verifiably known and `idle_expires_at` when counting
down (plus bounded last-online evidence only if genuinely helpful). An old
Agent's unobserved Stop intent is **unknown**, not assumed OFF or ON.
Expired/revoked devices are omitted from active listings, never consume
the 64 active slots, and remain distinguishable from simply offline
devices. Display absolute server deadlines, not fabricated client clocks.
No additional MCP tool, status enum, management UI or history index.

## Minimal implementation and verification (Q12=A)

- **Change only affected seams:** RCA Worker/Owner DO's grant checks and
  list, WSS signed checkpoint and reconnect, narrowly scoped local
  stop-intent + manager command and the current official release
  variable allowlist. Keep existing test/CI and GitHub Actions release
  paths. No D1/KV/R2, separate Worker/DO, Cron, queue, process monitor,
  separate config page, high-rate polling or new login provider.
- **Targeted tests:** default/custom/invalid variable; ON continuously
  beyond 14 days; rate-limit timestamp vs validated probe; stale WSS,
  Hibernation, missing close callback, bad checkpoints, repeated
  Stop and delayed ACK; offline local Stop and pre-/at-/post-deadline
  owner Start; reconnect before expiration resets only **offline**
  period; after expiration never resurrects; later valid disconnect
  gets a fresh full interval. Verify signed epoch/revision ordering,
  missing/old Client capabilities, initial migration, 64-slot cleanup,
  admitted operation/Unknown continuity and unchanged temporary
  24h/Workflow Session grant rules.
- **Acceptance:** native Windows + Linux/WSL2 genuine paired-device
  Stop, crash, sleep, reconnect, deadline and local owner Resume
  separately from Worker/Agent CI. macOS only when its source candidate
  and independently approved real Mac are available; hosted macOS
  CI does not replace a real client. Preserve existing device ID until
  explicitly re-paired; prove old credentials are denied at expiry.
- **Release gating:** no auto-merge of design PR. Formal Agent Release,
  production Worker change and changes on paired personal machines
  require their own explicit authorization. Verify older Agent and
  rollback compatibility before rollout; do not disconnect existing
  healthy devices to force migration. Do not rerun unrelated broad CI.

## Grill completion

**Q1–Q12=A; final owner consensus.** Product rule, OFF/Resume authority,
online evidence, replay/receipt boundaries, old-device migration,
configuration, discovery and release gates are resolved; no further
owner architectural question is required. This is a **design artifact**,
not an RCA implementation, production acceptance or closure of the
separate Browser #626 unfinished verification.
