# ADR 0004 — Retire Browser Owner Unknown Review without weakening operation receipts

Status: **Accepted 2026-11-04; production deployment and independent retirement verification Pass 2026-11-05.**

The Owner chose to **remove**, rather than reauthenticate or relocate, the independent Browser Owner Unknown Review page and its dedicated Access application. It provided only a retrospective human `effect_seen`/`no_effect_seen` report, not execution permission; its separate browser/mailbox requirement created maintenance burden and had previously been **Waived**, not proven. This decision supersedes **only** the independent Owner Unknown-review-channel requirement in [ADR 0002](0002-profile-grant-not-business-authorization.md). It does **not** supersede the task-authorization boundary, protected targets, immutable intent identity, no-blind-replay rule, or Browser Activation's Access and same-Profile one-use proof.

## Decision

Retire `/owner/unknown/*`, its coordinator review endpoints, Review-only Owner Access verifier/config and related UI. Keep past operation receipts and `owner_reported_resolution` facts unchanged. For unresolved `unknown`, keep its existing status and original `intent_key`; never fabricate completion, re-dispatch it, or release it merely because time elapsed. A genuine signed late extension receipt still follows the existing guarded finalization contract. `browser_operation_status` remains the read-only way to inspect an outcome.

To prevent a permanently accumulated Unknown count from eventually denying all new work, retain a cap of **100** on **still-Unknown operations created within the last seven 24-hour days**, using existing trusted server `created_at`. Older Unknowns remain stored, queryable, non-replayable and semantically Unknown, but no longer consume new-admission capacity. This is a bounded **counting window**, not a storage TTL, resolution mechanism or permission to retry. It requires no schema migration, queue or background cleaner.

## Consequences

The Owner accepts the loss of a dedicated human-reporting page and the residual historical storage growth in exchange for simpler day-to-day use. Removing the Access app before disabling and verifying the corresponding Worker routes would risk an exposed Owner surface and is forbidden. The subsequent [authorized Worker release](https://github.com/lirtual/mcp-workers/actions/runs/41871291888) and [Review Access deletion with production 404 readback](https://github.com/lirtual/mcp-workers/pull/716#issuecomment-6636929175) completed on 2026-11-05. The [three Owner Access SSO+OTP logins](https://github.com/lirtual/mcp-workers/pull/715#issuecomment-6646761813) separately passed Owner-reported real-client verification. Further production configuration, credential, or data changes still need their own authorization. Historical waivers remain historical facts and are not retroactively counted as Pass.

See the accepted cross-application design for the remaining Cloudflare SSO + OTP login decisions and cutover order.
