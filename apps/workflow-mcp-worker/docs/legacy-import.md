# T10 — guarded v0.1 registry import and rollback

Implementation baseline: `src/legacy-import.ts` (read-only preflight) and
`src/legacy-import-storage.ts` (additive D1 seed). They **do not enable**
`DYNAMIC_WORKFLOW_REGISTRY_ENABLED` or
`DYNAMIC_WORKFLOW_ADMISSION_ENABLED`, activate any definition, modify
`scheduler_state`, or deploy the Worker. The test suite uses actual SQLite
migrations. It does **not** prove Cloudflare managed-D1 or external Workflows
binding behavior.

## Owner-approved live-target topology

The owner permits testing the existing, not-yet-in-service
`workflow-mcp-worker` and its current D1/Workflows resources, rather than
creating another Worker. This is a **shared live-target test**, not independently
isolated acceptance under the original AC15; report that variance explicitly.
The owner **has already authorized** v0.2 testing on this unused live target,
including necessary controlled deployment, schema migration and reversible D1
writes. No additional per-step owner permission is required for these tests.
Before mutations, verify the exact deployed Worker HEAD and D1 schema, take a
recoverable D1 export and inventory nonterminal Runs/instances and scheduler
cursor. Stop on unexpected pre-existing business data or incompatible schema.
Final go-live, real upstream business writes and enabling a real production
Cron schedule remain separate decisions. Do not use a locally simulated SQLite
result as Cloudflare managed-D1 evidence.

## Import prerequisites

1. Record the exact running v0.1 engine SHA and its compiled Registry. Confirm
   four IDs and their original 64-character canonical digests match the frozen
   baseline. Do not treat the current checked-in Registry as proof of what an
   unknown production SHA is running.
2. Use only the explicitly approved test target and verify its actual D1 and
   Workflows bindings. After baseline backup, apply any required approved
   additive v0.2 migrations as part of this authorized test (without dropping
   existing data); verify resulting schema. Stop on unexpected drift or failed
   migration. Keep both dynamic feature gates OFF until cutover tests.
   Take a read-only snapshot of immutable definitions, active pointers,
   Connection policy revision and controls, *all* nonterminal Run/manifest
   records, and the `raindrop-daily-snapshot:daily-nine` scheduler row.
3. Run the nonterminal compatibility check. Any missing pinned definition,
   unknown historical Connection mapping, malformed/unsupported execution
   manifest, policy mismatch, unexpected active version or missing/invalid
   scheduler high-water mark is a **stop**, not permission to create a new Run
   or reinitialize its cursor.
4. Obtain the *fresh* authoritative snapshot with `readLegacyImportState(db)`
   immediately before import, including all nonterminal Run/manifest rows.
   Pass it and the exact policy revision to `prepareLegacyImport` /
   `seedLegacyDefinitions` in the approved test target after the backup and
   preflight checks. Verify all four original digests/source paths and exact normalized
   plans, current D1 tool approval and unchanged `daily-nine` values. An
   identical seed is idempotent; a collision on the same digest must fail.
   Re-read the D1 snapshot and nonterminal Run records after the operation.
5. The additive seed **does not** create `definition_publications`. The
   independent T09 publisher must separately stage the exact approved catalog
   source SHA and matching original digest before any `/admin/definitions/activate`
   request can succeed. Never synthesize a fake publication, repository ID,
   source commit or publisher run identity to bypass the T05 activation guard.
   Run the read-only `verifyLegacyPublicationReadiness(db, { workflowId,
   approvedSourceSha, trustedPublisherRepositoryId, expectedPolicyRevision })`
   for each definition targeted for activation, using owner-approved exact
   Catalog SHA and the Engine repository's numeric publisher ID. A matching
   immutable D1 digest alone is not proof of an authorized publication.
   If the protected publisher/catalog is unavailable, stop before cutover.
6. Perform controlled Registry CAS and reader-gate cutover tests **only after**
   required managed D1/Workflows, manual/webhook/scheduled and old-Run continuation
   compatibility checks. The import must not implicitly activate anything. Preserve
   the old static read path until the switch is authorized.

## Fallback and release gate

Before cutover, keep the v0.1 static reader and Cron functional. After enabling
v0.2 active definitions, do **not** blindly deploy an older engine binary: it
may ignore new active records, pinned Connection scopes or the updated
scheduler semantics. A rollback requires an explicit compatible target
engine, saved active definition revision/digest, durable Run/manifest
compatibility evidence and a controlled reverse cutover during tests. Do not
delete historical definitions, Runs or scheduler rows to make a rollback pass.

The owner has authorized test migrations, test deployment and feature-gate
validation on the currently unused existing Worker; do not repeat a blanket
permission request for those operations. Final go-live and enabling actual
production business traffic remain separate. Do not treat CI SQLite results
or this runbook as evidence that those live tests were completed. Real platform acceptance remains Open
until captured with managed D1 and Workflows binding. Successful live-target
results cannot be labeled independent-isolation PASS; record the deviation
and obtain a separate acceptance decision.
