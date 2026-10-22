# Workflow MCP Worker

Versioned durable workflows using the existing MCP Portal, Cloudflare D1 and
Cloudflare Workflows. No extra scheduler, private queue or credential issuer.

## Current production contract (verified 2026-10-22)

| Stage | Enabled capability | Acceptance |
| --- | --- | --- |
| S1 | Draft → validate → Publish → Run → result | Production PASS |
| S2 | Exact owner-approved, read-only MCP call via Portal | Production PASS |
| S3 | Registered GitHub Actions `heavy.github.echo` + OIDC Claim/callback | Production PASS |

The authenticated owner MCP endpoint is
`https://workflow.lirtual.dpdns.org/mcp`. Production S2 calls
`https://mcp.lirtual.dpdns.org/mcp`. D1 stores Drafts, immutable Published
Versions, Runs/Steps, GitHub Attempts and callback receipts; Cloudflare
Workflows handles DAG progression. The dedicated S3 executor is
`.github/workflows/workflow-s3-executor.yml` in `lirtual/mcp-workers` on
`refs/heads/main`. Its only registered operation is a fixed, no-side-effect
Echo — no user-supplied shell, script, repository, ref or arbitrary action.

**Evidence**

- [S3 production release](https://github.com/lirtual/mcp-workers/actions/runs/39717083160):
  success; S2 and S3 bindings and active version read back from Cloudflare.
- [Production S3 Echo E2E](https://github.com/lirtual/mcp-workers/actions/runs/39717266457):
  `S3_PRODUCTION_SMOKE_OK` and `CLEANUP_OK` — authenticated Publish/Run,
  confirmed dispatch, GitHub OIDC Claim, immutable callback, result, physical
  Job completion and scoped D1 cleanup.
- [Actual S3 Job cancellation](https://github.com/lirtual/mcp-workers/actions/runs/39717834242):
  one registered Echo Job with a **nonexistent** Attempt reached `in_progress`,
  then its Run, Job and main step reached `completed/cancelled` after a GitHub
  cancellation request. The Job could not claim a production Attempt and D1
  remained empty.
- [S2 production read-only smoke](https://github.com/lirtual/mcp-workers/actions/runs/39708841147):
  pinned Portal/IMA integration, durable result and cleanup.

**Cancellation boundary:** physical cancellation of a GitHub Job is verified,
but Workflow MCP does **not** expose `workflow_cancel` or automatically cancel
the child GitHub Job when a Workflow stops. `workflow_pause` blocks *new*
Run admissions only. `indeterminate` never means an external Job was stopped;
a terminal outcome cannot be overwritten by a late callback.

## MCP owner tools

`workflow_list` / `workflow_get` list and inspect Workflows. `workflow_create` /
`workflow_update` write YAML/JSON Drafts with optimistic revision checks.
`workflow_validate` reports invalid DAGs and necessary approval grants without
side effects. `workflow_publish` explicitly publishes an immutable version.
`workflow_run` asynchronously admits one idempotent Run of the pinned version.
`workflow_status` / `workflow_result` return bounded safe Step/business
outcomes (and may reconcile durable state). `workflow_pause` /
`workflow_resume` control *new* admissions, not running jobs.

S2 Publish requires the **exact** `workflow_validate.required_approvals`:
`endpoint`, `tool`, `scope: read`, `schema_digest`, plus
`accept_target_risks: true`. This is an authenticated API assertion, not proof
of a human confirmation UI. A remote `readOnlyHint` is untrusted: **private
network/SSRF isolation and actual no-side-effects are not guaranteed**. The
runtime only accepts the pinned production Portal; arbitrary direct public MCP
targets and write-scope targets are not available.

S3 Publish requires `approve_heavy_execution: true` for a `github.run` Step
with `with: { capability: heavy.github.echo }`. Dispatch is server-pinned to
one repository/workflow/ref and uses a separate repo-scoped GitHub token; GitHub
OIDC and a confirmed D1 Attempt must match the same physical Run and attempt
before Claim. Results are stored immutably before signaling the Workflow.

Not provided by this production slice: generic heavy GitHub tasks, arbitrary
commands, Cron/Webhooks, external MCP writes, R2 artifacts or automatic GitHub
Job cancellation. These need separate scoped implementations and acceptance.

## Release and smoke (existing CI only)

The existing [GitHub Actions CI](https://github.com/lirtual/mcp-workers/actions/workflows/ci.yml)
is the only production release route. Only an explicit manual `main` dispatch
can publish; PR/push CI never deploys. Release validates the trusted main
commit, GitHub Environment, exact runtime bindings, D1 migrations, active
version and required credentials. All production enable/deploy flags default **false**.

For an authorized release that **retains both S2 and S3**:

```text
worker=workflow-mcp-worker
deploy_to_production=true
enable_workflow_s2=true
enable_workflow_s3=true
```

The later release must explicitly retain previously enabled stages.
A read-only preflight rejects accidental S2/S3 downgrades **before** Secrets,
D1 migrations or deployment. To deliberately disable a currently active
stage, additionally select `confirm_workflow_stage_disable=true` in the
manual Workflow release. This option defaults false and never bypasses
release binding, schema or active Run checks.

The S3 release gate verifies exact callback origin/audience and checks the
dedicated token against the registered GitHub Workflow. The permission
probe dispatches to a deliberately nonexistent branch and requires rejection;
it cannot create an executable Job.

Existing GitHub Environment `workflow-mcp-worker` contains Secrets
`S3_GITHUB_TOKEN`, `S2_PORTAL_CLIENT_ID` and `S2_PORTAL_CLIENT_SECRET`,
plus variables
`S3_CALLBACK_ORIGIN=https://workflow.lirtual.dpdns.org` and
`S3_GITHUB_AUDIENCE=workflow-s3-claim:production`. Existing shared release
credentials include `MCP_ACCESS_TOKEN` and `CLOUDFLARE_API_TOKEN`.
S3 uses its own single repo-scoped Actions read/write token, **not** the
`github-actions-mcp-worker` multi-PAT `GH_TOKEN`.

For **one production S3 Echo smoke without deployment**, dispatch `ci.yml`
on `main` with:

```text
worker=workflow-mcp-worker
smoke_only=true
s3_production_smoke=true
deploy_to_production=false
enable_workflow_s2=false
enable_workflow_s3=false
```

It creates a random disposable Workflow, validates explicit heavy-operation
approval and idempotent admission, verifies the final Workflow result and
independent GitHub Job completion, then removes only its matching D1 data.
Ambiguous/running external Jobs block automatic cleanup; inspect their
actual identifiers rather than deleting potentially live records.

For S2's independent read-only production smoke, use `smoke_only=true`,
`s2_production_smoke=true`, `enable_workflow_s2=true` and
`deploy_to_production=false`.

## Safety invariants

- Bounded DAG size, parallelism, output size and Run capacity. Rejected work
  does not enter a second hidden queue.
- Each Run is pinned to its Published Version. Idempotent admission and
  `UNIQUE(run_id,step_id)` prohibit duplicate external dispatch.
- External calls with unknown outcome are not blindly retried.
- S3 signed Claim/callback is correlated to the **original D1 Attempt**
  repository ID, workflow ref, physical Run ID and attempt number. A late
  callback cannot rewrite terminal business state; notification alone is
  not proof of success.
- Before rotating S3 repository identity, workflow family or OIDC audience,
  drain active physical jobs. A failed release does not automatically roll
  back D1 schema.

Superseded rollout and Draft experiments are available in Git history. This
README describes the present operational contract, not the implementation
chronology.
