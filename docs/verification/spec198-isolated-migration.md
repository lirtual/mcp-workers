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
- An isolated Worker exported both `Spec198Old` and `Spec198New` after an
  update. The old Workflow instance had reached `complete` with output `ok`
  before the update and remained queryable by its original ID afterward. A
  new Workflow instance completed with output `new-ok`. Both temporary
  Workflows and the temporary Worker were removed after verification. **This
  proves coexistence and retention while the old export remains**, not safe
  deletion of the old export.
- Production was queried **read-only**: D1 `workflow-mcp-worker` had no business
  rows, five `d1_migrations` entries, four explicit indexes and provider-managed
  `_cf_KV`. The old native `workflow-mcp-runner` showed six completed instances.

## Still required before #204 or production change

1. Using the pinned Wrangler release toolchain, repeat same-name Secret to
   Variable conversion and reverse recovery against a disposable Worker. Test
   deployment failure after the binding change and confirm readback/rollback.
2. Verify the **production-shaped** export/import handling for the existing
   five migration files and any provider-owned `_cf_KV` state before cutover;
   the isolated source/target SQL transfer and full integrity comparison above
   now pass. Stop if the platform-owned table requires unsafe import handling.
3. The isolated old/new Workflow coexistence and historical lookup test now
   passes. For production, keep the old class exported until the required
   history retention horizon and any in-flight instances have expired; verify
   old instance lookup and new dispatch again before and after cutover.

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
