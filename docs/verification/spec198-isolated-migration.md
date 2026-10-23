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
- Production was queried **read-only**: D1 `workflow-mcp-worker` had no business
  rows, five `d1_migrations` entries, four explicit indexes and provider-managed
  `_cf_KV`. The old native `workflow-mcp-runner` showed six completed instances.

- Repository-pinned Wrangler **4.130.0** was run locally under temporary Node
  **24.21.0** without changing the system Node installation. Release script
  tests passed **46/46**, Workflow Worker tests **95/95**, TypeScript
  typecheck and `wrangler deploy --dry-run` passed. Dry-run reports existing
  `WorkflowRunner` and old D1 bindings: it is a build/preflight check, **not**
  an authenticated isolated deployment or a migration test.

## Current isolated Wrangler E2E prerequisite

The existing GitHub Actions isolated Workflow E2E now runs on the #198
implementation branch and deploys a disposable Worker using
`MCP_PORTAL_CLIENT_ID` as a Wrangler `vars` plaintext binding, asserting
its type through Cloudflare readback. It cannot be run successfully yet:
GitHub Environment `workflow-mcp-worker` currently holds the Client ID only
as a **Secret**, while `${{ vars.MCP_PORTAL_CLIENT_ID }}` is missing. The
previous GitHub dispatch token key also remains in that Environment.

Before live E2E, authorize the targeted GitHub Environment change and set
`MCP_PORTAL_CLIENT_ID` as a Variable using its existing actual ID. Never
print, guess, or replace the ID with a fixture value for the Portal E2E.
Do not delete the existing Secret until the new release path and rollback
are validated. The E2E job does not publish the production Worker.

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
