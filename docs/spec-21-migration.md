# Spec #21 Workflow cutover notes

The new source accepts only `ACTIONS` -> `cloudflare-actions#ActionsEntrypoint`
for fresh Weixin Session Ready, verified download notifications and Bark sends. `ACTIONS_DEPLOYMENT_ID` is frozen in each newly
published grant, and new Action reservations check `cloudflare_action_gate`
inside the same D1 INSERT, preventing a separate-check race.

Migration 0018 introduces a single D1 singleton gate (default `open`). For
production cutover, after old Workflow instances have **physically** drained,
use the protected GitHub Actions mechanism to freeze via a conditional D1 UPDATE:

```sql
UPDATE cloudflare_action_gate SET state='frozen',changed_at=unixepoch()*1000
WHERE id=1 AND state='open';
```

This SQL is descriptive, **not automatically applied**. It cannot stop old
previously deployed source code which does not inspect the gate. Only physical
drain plus atomic admission provide the necessary stop. The protected release
checks new migration 0018, exactly one Actions Service Binding and its pinned
single active version. Retain old historical Weixin receipt access and prevent
Bark history sends; an old Weixin Published Plan can only query original
receipts and cannot issue a second notification.

Source-only and mock tests are not substitutes for real production proof. See
`lirtual/cloudflare-actions/docs/spec-21-cutover.md` for complete staging and
rollback requirements. No migration, rollout or cleanup has been performed.

The protected Workflow release also performs a **read-only** runtime-topology
and D1 fence check immediately before publishing. It rejects an initial
legacy-to-unified Binding transition unless the D1 row is `frozen`. This
check **does not** claim that old native instances have drained; the Owner
must separately verify physical instance quiescence before the release.
After the first compatible transition, future Workflow code releases do not
require a permanently frozen dispatch gate.

The 2026-10-30 UTC production read-only audit observed 6 nonterminal Runs,
15 historical Action Invocation rows, 0 nonterminated physical Sessions,
and a separate still-running old-version native Workflow instance. The
0018 table is not installed. These facts do **not** satisfy the old-code
physical drain condition; a new release must independently recheck the
then-current state. See the Producer cutover document for the full evidence.

## Fresh Weixin encryption key decision (2026-10-30)

Owner explicitly accepted a NEW WEIXIN_ENCRYPTION_KEY and one QR/OTP
re-pair; transferring the old encryption Secret is no longer required.
The old Worker must use its existing Access-protected /setup/unbind
operation after native Workflow drain and an atomic frozen 0018 gate.
This increments binding Generation and clears old ciphertext. The
original Weixin D1 and immutable receipt/unknown rows remain. After
read-only confirmation that no encrypted session/pending pairing or
active lease remains and historical receipt counts match the
pre-unbind baseline, the new Worker can receive a fresh key and the
Owner can complete new QR/proof verification. Old invocation IDs do not
become new send rights. Rollback may require re-pair; D1 is not reset.
These steps require separate production authorization and are not run
by merely updating docs.

For the **first** legacy-to-`ACTIONS` release, the protected consumer gate
now additionally queries Cloudflare's official native Workflow instance
statuses (`queued`, `running`, `paused`, `waiting`, `waitingForPause`,
`rollingBack`) read-only and rejects any nonzero or incomplete result.
This is a necessary snapshot, **not** a guarantee against an old-code
instance starting after the check; the ingress/admission quiescence and
physical drain requirement remains a separate hard operator prerequisite.
A running native instance was observed earlier on 2026-10-30; a later
read-only check saw no nonterminal native instances. Neither snapshot prevents
new old-code admissions, so quiescence must be proved at cutover. The candidate unified Worker deliberately has **no**
Owner custom-domain `routes` in its initial Wrangler configuration; the
existing Weixin Owner route must be transferred separately in an authorized
protected operation after staging and successful rebind preflight.

**Release verification refinement:** the first-cutover read-only gate now
also validates the target service and entrypoint of each legacy Binding
(`WEIXIN_ACTION_PROVIDER` -> `weixin-mcp-worker#WeixinActionProvider`,
`BARK_ACTION_PROVIDER` -> `bark-provider#BarkActionProvider`). Subsequent
unified releases require exactly `ACTIONS` ->
`cloudflare-actions#ActionsEntrypoint`. A correct Binding name with an
unexpected target is rejected. The gate reports native-instance inventory
only when it actually performed that read. This does not eliminate the
race against newly admitted old-version instances.

**Mainline compatibility (2026-10-30):** Preserve the already merged
'weixin.notify_download' Action and 'http.request' capability. The old
'0017_http_connection_auth.sql' remains immutable; the unified Action
migration is numbered '0018_cloudflare_action_migration_fence.sql'.
Final source/local tests do not authorize production freeze, owner unbind or send.
