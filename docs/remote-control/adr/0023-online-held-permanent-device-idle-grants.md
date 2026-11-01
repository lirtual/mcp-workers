# ADR-0023 — Hold permanent RCA device grants while authentically online

Status: **Proposed — owner's B policy and Grill Q1–Q4=A confirmed 2026-11-01;
Stop reconciliation / owner recovery details remain under review**.

The owner chose Browser-style online hold for RCA permanent devices instead
of expiring devices based solely on the absence of remote tool calls. An
authentically signed-WSS online, owner-enabled permanent Agent therefore
keeps its grant without an idle deadline; owner-stop or prolonged loss of
trusted online connectivity starts a bounded server-enforced expiry window.
This deliberately permits a connected but unused permanent Agent to occupy a
slot indefinitely: the trade-off favors unattended device availability over
strict use-driven cleanup. Temporary 24-hour grants and their absolute
deadlines remain separate.

Owner OFF is an **explicit local owner action**; an ordinary disconnected
but still-ON device receives a **fresh full 14-day default countdown** on each
loss of genuine signed online evidence, and a pre-expiry authenticated
automatic reconnect cancels that countdown. This rule is intentionally
identical in Browser MCP remembered pairing and RCA permanent pairing;
ONLINE holds indefinitely, not as a database TTL extended by every ping.
Active OFF deadlines do not renew through auto-reconnect or repeated Stop.
Existing permanent online devices retain their grant at first migration;
offline legacy grants receive a full migration-time idle window. Duration is
release-configurable 1–90 days and device lists show real expiry only while
counting down. The detailed OFF reconciliation, reactivation, migration
races and enforcement are **not yet accepted**. See
[Grill design](../RCA-IDLE-GRANT-DESIGN.md).
No implementation, release or production authorization follows from this ADR.
