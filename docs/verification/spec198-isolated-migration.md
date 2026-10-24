# #198 / #199: isolated Cloudflare migration evidence

This is a **test report**, not production migration approval. All fixture resource
names use the `spec198-` prefix; every fixture created in the tests below was
removed. Production resources must not be used for rehearsals.

## Verified on 2026-10-23

- A disposable Worker accepted a dummy `MCP_PORTAL_CLIENT_ID` Secret and a
  same-name `plain_text` binding via multipart settings PATCH. Readback showed
  exactly one plaintext binding and no remaining Secret under that name.
- Attempting to restore the Secret **while the plaintext binding exists** fails
  with Cloudflare error `10053` (binding name in use). On a separate fixture,
  explicitly clearing bindings, checking the empty result, then adding a dummy
  Secret succeeded. Readback showed exactly one `secret_text` binding. Both
  fixtures were deleted and verified absent.
- Disposable D1 tests created schemas, an index, a foreign key, a migration
  history fixture, and rows. Async SQL export advanced from `active` to
  `complete` and returned export filename and signed URL. A second isolated
  test **downloaded the actual SQL export**, uploaded that exact file through
  the D1 Import signed-upload flow, and ingested it successfully (8 queries).
  Source and target matched on `sqlite_master` user definitions, record counts,
  complete row contents, migration history, and zero `foreign_key_check` issues.
  Both disposable databases were deleted and inventory checked for `spec198-`.
  The downloaded **fixture export** contains only the fixture user tables,
  not `_cf_KV`; this is not proof that exporting the production database would
  preserve or safely recreate its platform-managed state. Never manufacture
  `_cf_KV` inserts or schema manually as part of a migration.
  A read-only `SELECT count(*) FROM _cf_KV` on the existing production D1
  returned Cloudflare error `7500: not authorized: SQLITE_AUTH`; the internal
  table is not available as an ordinary user table. Do not bypass this check.
- An isolated Worker exported both `Spec198Old` and `Spec198New` after an
  update. The old Workflow instance had reached `complete` with output `ok`
  before the update and remained queryable by its original ID afterward. A
  new Workflow instance completed with output `new-ok`. Both temporary
  Workflows and the temporary Worker were removed after verification. **This
  proves coexistence and retention while the old export remains**, not safe
  deletion of the old export.
- Historical production check on **2026-10-23** observed zero business rows,
  five applied migrations and six completed native Workflow instances. These
  are point-in-time findings, **not** current export or cutover assumptions.
  The follow-up review on **2026-10-25** reported **8 migrations**, **7 Workflows**,
  **58 Runs**, **49 terminated Session executions** and **4 delivered Callback
  receipts**. Recheck every mutable count, pending Task/Session, external GitHub
  side effects and in-flight callbacks immediately before any write freeze.

- Repository-pinned Wrangler **4.130.0** was run locally under temporary Node
  **24.21.0** without changing the system Node installation. Release script
  tests passed **46/46**, Workflow Worker tests **95/95**, TypeScript
  typecheck and `wrangler deploy --dry-run` passed. Dry-run reports existing
  `WorkflowRunner` and old D1 bindings: it is a build/preflight check, **not**
  an authenticated isolated deployment or a migration test.

## Verified again on 2026-10-25 · pinned Wrangler release-shaped transitions

Using Wrangler **4.130.0** under Node **24.22.1** and a disposable
`spec198-binding-*` Worker, the same CLI flags as `release.yml` were
exercised with **dummy credentials only**:

1. First deploy with `--secrets-file` created a genuine
   `MCP_PORTAL_CLIENT_ID` `secret_text` binding.
2. Second deploy with `--secrets-file` for an unrelated Secret **and**
   `--var MCP_PORTAL_CLIENT_ID:<fixture-id>` succeeded. Cloudflare
   settings readback confirmed exactly one `plain_text` Client ID, no
   old same-name Secret, and the unrelated `secret_text` intact.
3. A deliberately syntax-invalid Worker failed deployment; a second
   Cloudflare settings readback confirmed the previous binding types
   remained intact.
4. Direct `wrangler secret put MCP_PORTAL_CLIENT_ID` while the Variable
   existed failed as expected with Cloudflare **10053** (name in use).
5. A deployment using `--secrets-file` with the original **fixture**
   Secret and **without** the `--var` restored `secret_text`. Readback
   confirmed the unrelated Secret remained intact.
6. The disposable Worker was deleted by exact name; the account API
   subsequently returned **404 / Worker does not exist**.

**Production recovery condition:** retaining the original Secret value
in an approved secure source and pausing writes remain necessary. CLI
reversibility with dummy values is not evidence that production Secret
values can be fetched from Cloudflare or that rollback after D1 divergence
is safe. Fail closed on missing values and binding type disagreement.

**Current eight-migration D1 rehearsal:** Two uniquely named disposable
D1 databases were created; the **exact migration directory from PR #206**
was applied to the source, producing names
`0001_s1.sql` through `0008_session_locator.sql`. The source
received one synthetic `workflows` record. Wrangler remote SQL export
(5,680 bytes) and remote SQL-file import to the empty target both
succeeded. Source and target agreed on **15 user Schema entries,
9 table row counts, all 8 migration-history names, the complete test
record and zero foreign-key errors**. A normalized user-data/schema
snapshot yielded matching SHA-256
`54e000f1984c5b74` (prefix). Both disposable D1 databases were
deleted, and account inventory confirmed both absent.

Cloudflare rejected `PRAGMA integrity_check` with
`SQLITE_AUTH` (code 7500) even on these disposable D1 databases.
**Do not report that specific PRAGMA as passed or try to access
provider-owned tables with bypasses.** The successful native export/import,
user Schema/data comparisons and `foreign_key_check` are the documented
reproducible validation evidence. Internal provider metadata such as
`_cf_KV` remains under the platform's supported import/export semantics.

The Workflow old/new export coexistence and old-instance lookup were
already verified in disposable Workflows on 2026-10-23 (above). Their
retention behavior still requires a fresh pre-cutover check of active
instances before a production resource name change.

## Current integration boundary

The old branch-local `mcp-portal-cloud-e2e.mjs` was deleted by main and must
**not** be reintroduced. The current GitHub workflows are split into
`ci.yml` (checks), `release.yml` (explicit production-only release) and
`acceptance.yml` (main-only Workflow acceptance). Offline CI success and
Wrangler `--dry-run` do not prove the same-name Secret → Variable transition
or a production-shaped D1 import.

#199's disposable-Worker CLI conversion and failure-recovery gate has now been
verified (above) without changing the real GitHub Environment. Do not add the
real Environment `MCP_PORTAL_CLIENT_ID` Variable, remove its current Secret or
run main-only production acceptance just to satisfy a Draft PR. Credential
cutover and production deployment remain separate owner-authorized operations.

## Gates after isolated verification

- **#199 technical gate:** tested Secret→Variable→Secret under the pinned
  Wrangler CLI, failed deploy retention, supported complete export/import of
  the current 8 migration files with synthetic data, and old/new Workflow
  coexistence. No permanent fixtures or extra services remain.
- **Before #204 production cutover:** independently verify current source
  D1 backup/export correctness, all business tables and provider-supported
  import behavior, remote GitHub Task/Session/Callback quiescence, no active
  Workflow instances, source/target record counts and exact new UUID.
  This must use the actual state *at cutover*, not test data from #199.
- **Production Workflow history:** preserve the legacy export until historical
  instances pass their retention cutoff, then request separate approval for
  destructive retirement. Do not assume that the isolated coexistence test
  proves safe deletion.
- **No current production approval:** all credentials, deployments, D1/Workflow
  resource switches and old-Secret cleanup remain explicitly gated.

## Fail-closed release and rollback gates

- Stop if the readback contains duplicate binding names, wrong types, missing
  expected Variables or unexpected Secrets.
- Before a production reverse change, recover the original Secret from the
  separately protected secret store. Cloudflare cannot return its value.
  Removing plaintext then restoring the Secret creates a temporary outage;
  stop new work during that window, confirm Secret readback and only then resume.
- Stop if D1 source-to-target checks differ or platform-owned tables cannot be
  handled safely. Keep the original D1 and native Workflow untouched until
  successful end-to-end verification and separately approved cutover.
- Do not delete the old Workflow/class merely because new deployments or
  triggers succeed; preservation of historical instance lookup is an
  independent acceptance gate.

Issue evidence: #199 comments dated 2026-10-23. No fixture names or test
credentials from this document are production settings.
