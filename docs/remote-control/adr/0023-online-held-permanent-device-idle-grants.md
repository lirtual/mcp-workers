# ADR-0023 — Server-enforced RCA permanent grants with online hold

**Status:** Accepted and implemented under [Spec #666](https://github.com/lirtual/mcp-workers/issues/666). Worker source [PR #664](https://github.com/lirtual/mcp-workers/pull/664) was merged on 2026-11-01; formal Worker/Agent delivery and scoped real Windows/WSL2 Stop/Resume acceptance completed on 2026-11-03. Natural 14-day expiration and real forced expiry were not physically exercised; deterministic tests covered expiry denial. Subsequent monorepo Agent release and device continuity were independently accepted under [Spec #803](https://github.com/lirtual/mcp-workers/issues/803) / [#810](https://github.com/lirtual/mcp-workers/issues/810), including explicit macOS real-device waiver. No new deployment or hardware test is implied by this ADR.

## Decision

RCA permanent device grants use the same idle-expiry **semantics** as
Browser MCP remembered Profiles, not a shared storage or client service.
Genuinely owner-enabled and authentically signed-WSS **ONLINE** devices
retain authorization **without a countdown**, even if unused for months.
On authenticated ONLINE -> OFFLINE, use the **full configured idle interval**
from the most recent credible server-observed online instant (default 14
days). An authenticated automatic reconnect **before** expiry clears
that offline deadline; a subsequent genuine offline period starts anew.
Explicit local owner Stop instead starts/retains a nonrenewable OFF deadline:
a heartbeat, automatic reconnect or repeated Stop cannot refresh it.

Owner Stop persists locally before process shutdown even during a network
outage; server acknowledgement may remain unconfirmed, and later
reconciliation **must not extend** an earlier offline deadline. Before
expiry, explicit OS-owner local Start can reconcile pending Stop and
complete a fresh signed identity/epoch Resume without a new OTP or
pairing. Remote MCP/ordinary reconnect cannot Resume. The server
authenticates the existing Ed25519 device identity, not independent
human presence; owner intent is enforced by the locally protected
service manager/command boundary.

The Worker enforces expiry on every new protected admission, including
stale socket/Hibernation paths; an expired grant cannot authenticate
again and is lazily removed from the existing 64-slot registry. Trust
only **successfully verified** server-side session/epoch evidence; do not
mistake the existing pre-authorization `last_auth_check_at` rate-gate
timestamp, stale `last_connected_at`, open WSS, or client time for
online proof. Reuse the existing 15-minute signed probe with bounded
durable checkpoints instead of new high-frequency writes or timers.

Use one optional reviewed repository-level GitHub Actions Variable
`RCA_PERMANENT_IDLE_DAYS` on the RCA release path (unset/empty = 14, strictly 1–90
decimal integer days); malformed nonempty values fail closed. Existing
absolute deadlines are not retroactively changed by configuration.
Existing ON-online grants remain valid; legacy offline grants get one
migration-time full interval without re-reading stale timestamps.
Legacy Agents can remain online, but only compatible, explicitly
owner-upgraded clients support new signed Stop/Resume. Preserve local
keys, device IDs and SQLite Operation Receipts/Unknown across expiry;
new pairing requires separate explicit owner approval and generates
new identity. Temporary 24h and Workflow Session grants are unaffected.

## Rationale and consequences

The alternative *use-based* or absolute 14-day expiry would disrupt
unattended online Agents. The accepted trade-off is that an always-online
but unused device can occupy an active slot indefinitely. Reuse the
existing Worker, Owner DO, Node Agent, per-device signature/epoch,
OS-owned management and official CI/release; no new manager UI,
persistent revoked-key blacklist, second database, Cron or service.

A legacy Worker rollback could bypass idle enforcement and must be
independently checked **before** any authorized rollout/rollback.
Existing operation effects cannot be undone; expired grants do not
erase unresolved Unknown or re-authorize replay. See [Spec #666](https://github.com/lirtual/mcp-workers/issues/666) for exact implementation and acceptance evidence, including the remaining Waived/Not performed cases. Current configuration and release gates are defined by `.github/workflows/release.yml`, its referenced scripts and tests. Future releases, credential/configuration changes and device mutations still require separate authorization; source/CI evidence is never a substitute for production readback.
