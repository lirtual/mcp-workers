# ADR-0023 — Server-enforced RCA permanent grants with online hold

**Status: Accepted design consensus, 2026-11-01 (policy B, Grill Q1–Q12=A); implementation candidate in PR #664 / Agent #666. Not merged, released or production-verified.**

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

Use one optional reviewed release-time GitHub Actions Environment
Variable `RCA_PERMANENT_IDLE_DAYS` (unset/empty = 14, strictly 1–90
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
erase unresolved Unknown or re-authorize replay. See the
[final design and acceptance conditions](../RCA-IDLE-GRANT-DESIGN.md).
The original design Draft was extended to an implementation candidate; source/CI and release approvals remain separate. No PR merge, GitHub Release, real-device upgrade or production deployment is implied.
