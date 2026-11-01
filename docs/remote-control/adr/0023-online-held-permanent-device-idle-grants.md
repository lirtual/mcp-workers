# ADR-0023 — Hold permanent RCA device grants while authentically online

Status: **Proposed — owner's B direction selected 2026-11-01; expiry and
local recovery details still in Grill With Docs**.

The owner chose Browser-style online hold for RCA permanent devices instead
of expiring devices based solely on the absence of remote tool calls. An
authentically signed-WSS online, owner-enabled permanent Agent therefore
keeps its grant without an idle deadline; owner-stop or prolonged loss of
trusted online connectivity starts a bounded server-enforced expiry window.
This deliberately permits a connected but unused permanent Agent to occupy a
slot indefinitely: the trade-off favors unattended device availability over
strict use-driven cleanup. Temporary 24-hour grants and their absolute
deadlines remain separate.

The exact meaning of owner OFF, reactivation, legacy migration, configuration
and race handling is **not yet accepted**. See
[Grill design](../RCA-IDLE-GRANT-DESIGN.md).
No implementation, release or production authorization follows from this ADR.
