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
The owner has **not** approved an automatic D1 migration, production cutover,
Cron change, live upstream write, Secret rotation or final release. Before any
write, verify the exact deployed Worker HEAD and D1 schema, take an independently
recoverable D1 export, inventory nonterminal Runs/instances and scheduler cursor,
and obtain separate authorization for the specific mutation. Do not use a
locally simulated SQLite result as Cloudflare managed-D1 evidence.

## Import prerequisites

1. Record the exact running v0.1 engine SHA and its compiled Registry. Confirm
   four IDs and their original 64-character canonical digests match the frozen
   baseline. Do not treat the current checked-in Registry as proof of what an
   unknown production SHA is running.
2. Use only the explicitly approved test target and verify its actual D1 and
   Workflows bindings and approved v0.2 schema before an authorized test. If
   required migrations are missing, **stop** rather than silently applying
   them. Keep both dynamic feature gates OFF.
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
   `seedLegacyDefinitions` in an isolated test
   harness only after authorization. Verify all four original digests/source paths and exact normalized
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
6. Separately approve active Registry CAS and reader gate cutover **only after**
   required managed D1/Workflows, manual/webhook/scheduled and old-Run continuation
   acceptance. The import must not implicitly activate anything. Preserve
   the old static read path until the switch is authorized.

## Fallback and release gate

Before cutover, keep the v0.1 static reader and Cron functional. After enabling
v0.2 active definitions, do **not** blindly deploy an older engine binary: it
may ignore new active records, pinned Connection scopes or the updated
scheduler semantics. A rollback requires an explicit compatible target
engine, saved active definition revision/digest, durable Run/manifest
compatibility evidence and a separately authorized reverse cutover. Do not
delete historical definitions, Runs or scheduler rows to make a rollback pass.

For production, a separate owner authorization is required for exact-SHA D1
migration, feature gate change and deployment. Do not treat CI SQLite results
or this runbook as such authorization. Real platform acceptance remains Open
until captured with managed D1 and Workflows binding. Successful live-target
results cannot be labeled independent-isolation PASS; record the deviation
and obtain a separate acceptance decision.
