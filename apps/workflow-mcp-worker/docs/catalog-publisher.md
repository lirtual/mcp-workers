# T09 — trusted catalog publisher: live-test handoff

This runbook documents setup and **uncompleted** acceptance; it is not a record
of a successful platform publication. The owner approved using the existing,
not-yet-in-service Cloudflare `workflow-mcp-worker` **as a test target**, instead
of provisioning an additional Worker. This changes the test topology, **not**
the independently required security, evidence or production release gates.
Live-target tests cannot be reported as independent isolated-environment proof.

The trusted publisher runs only from the **Engine** repository; the independent
catalog holds declarative YAML and business tests. Catalog scripts, Actions
and package manifests are never executed with publisher authority. Changing
YAML must not require deploying the Engine.

## Verified GitHub identity

- Engine: `lirtual/mcp-workers`, numeric repository ID `1371085786`.
- Catalog: `lirtual/workflow-catalog`, numeric repository ID `1382132570`.
- Catalog `main` was initialized at `9fba40497623e33ac9ec3d8612334736b25c7ee4`.
  Initial Raindrop YAML is pending review in catalog PR #1, branch
  `feat/initial-raindrop-catalog`, commit
  `1d0dd05d8ced607891c7eb7a9024222c46f22270`.
  The copied file has the same Git blob SHA as the Engine baseline:
  `4a2967eb683447224cc424d264cfef5cfb79a27b`.
- By owner decision, **do not configure Catalog branch protection**. Record this
  as a deviation from the approved T09 protection requirement, not a passing
  test. Require explicit review, exact approved source SHA, canonical digest
  and protected Engine-side publisher authorization as compensating controls.
  An open Draft PR is **not** a publishable approved source revision.

## Owner-authorized validation on the existing Worker

1. Record the current Worker deployment, D1 schema, active registry, schedule
   cursor, nonterminal Runs and Workflows instance state. Export a verifiable
   D1 backup and prepare an actionable rollback **before any live mutation**.
   Never reset an existing table, replay an old Cron tick or reuse a real
   webhook Secret as a test fixture.
2. The source-controlled publisher allows **only the owner-approved live-test
   HTTPS origin**. A dashboard-selected arbitrary HTTPS endpoint must never
   receive the GitHub OIDC token; adding a different test target requires
   reviewed source changes rather than only an environment variable.
   Existing test target:
   `https://workflow-mcp-worker.aiyaya.workers.dev`. Its D1 and Workflows
   bindings must be inspected, not assumed to be v0.2-compatible. The Worker
   must actually expose protected admin endpoints and approved schema before
   any dry-run can succeed. The owner has **already authorized** using this
   currently unused Worker and its existing D1/Workflows for v0.2 validation,
   including necessary controlled test deployments, schema migrations and
   reversible test writes. Do not request another per-step permission for
   those validation operations. First verify the live baseline and a usable
   backup; stop on incompatible schema, missing credentials or unexpected
   existing business data. Actual external writes, changing production Cron,
   and final go-live remain outside this testing authorization.
3. Owner-configured Cloudflare admin publisher identity must trust the Engine,
   **not the catalog**: `ADMIN_PUBLISHER_REPOSITORY_ID=1371085786`,
   `ADMIN_PUBLISHER_WORKFLOW_REF=lirtual/mcp-workers/.github/workflows/workflow-mcp-publisher.yml@refs/heads/main`,
   and `ADMIN_PUBLISHER_REF=refs/heads/main`. An optional
   `ADMIN_PUBLISHER_WORKFLOW_SHA` must track the explicitly approved Engine
   workflow SHA. Keep normal MCP access separate from the OIDC admin audience.
4. In the **Engine** repository, create protected Environment
   `workflow-mcp-publisher-live-test`. Require actual owner approval for
   publication; single-user approval must be achievable in the selected
   GitHub account/plan. If effective approval is unavailable, do not enable
   `stage` or `activate`. Set environment variables:
   - `WORKFLOW_CATALOG_REPOSITORY=lirtual/workflow-catalog`
   - `WORKFLOW_CATALOG_REPOSITORY_ID=1382132570`
   - `WORKFLOW_MCP_TARGET_URL=https://workflow-mcp-worker.aiyaya.workers.dev`
   - `WORKFLOW_MCP_ALLOW_LIVE_TEST_TARGET=true` to allow **read-only dry-run**
     against this exact known live hostname. Leave this unset/false otherwise.
   - `WORKFLOW_MCP_ALLOW_LIVE_TEST_MUTATIONS=false` initially. Change to
     `true` after baseline backup and schema compatibility checks to execute
     the **already owner-authorized** stage/activate tests. This flag is a
     technical safety gate, not a request for another owner decision. Retain
     any GitHub workflow-enforced approval and do not equate test activation
     with authorization to run live business schedules or final go-live.
5. The current publisher is a Draft PR based on an unmerged v0.2 chain. Its
   workflow is intentionally `main`-only, and the Engine's deploy workflow
   automatically deploys changes under `apps/workflow-mcp-worker/**` when
   pushed to `main`. Testing on the existing Worker is already authorized;
   still verify the exact deployed SHA, migrations and recovery controls when
   integrating. Do not bypass the trusted ref check or treat Draft-branch CI
   as live publisher evidence. The final release decision remains separate.

## Ordered test protocol

- Confirm review, exact Catalog SHA and matching canonical digest; record
  the intentionally unprotected Catalog branch as an acceptance variance.
  Use only the trusted Engine publisher, with read-only catalog checkout;
  do not run any catalog-authored script or use catalog admin secrets.
- With live-test mutation opt-in **false**, request `mode=dry-run` from the
  approved Engine `main`; confirm its exact source SHA, policy revision,
  canonical digest and trusted GitHub run identity. An unavailable or
  incompatible live admin endpoint is **Blocked**, not Pass.
- After verified backup and D1 compatibility checks, satisfy any configured
  GitHub publisher gate and request `mode=stage` under the existing owner
  test authorization. Verify immutable D1
  provenance, idempotent retry and unchanged active registry.
- Require actual approval before `mode=activate` with exact
  `expected_revision` and `expected_digest`. Check CAS failure, normal
  MCP/HTTP admission, old pinned Run recovery and rollback. Do not activate a
  scheduled Raindrop business change until the schedule transition is
  independently verified; testing authorization does not imply enabling a
  real recurring production job.
- Change only reviewed Catalog YAML, publish with a new exact SHA, and compare
  Engine deployment SHA before/after to prove definition-only updates need no
  Engine redeployment. Preserve sanitized Actions and managed D1/Workflow
  evidence; never copy credentials into public logs or this repo.

**Not yet proven:** effective Engine environment protection, real publisher
OIDC exchange, compatible live schema, managed D1 CAS/recovery, full isolated
AC15, Raindrop business acceptance or production AC16. Keep #157/#159/#160
open until their individual evidence and approvals are satisfied.
