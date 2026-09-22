# T09 — isolated, trusted catalog publisher handoff

This is an **implementation runbook**, not a record of completed live acceptance.
The public Engine repository contains the trusted publisher code and GitHub
Actions workflow. The separately approved catalog contains only definition YAML
and business tests; catalog scripts, Actions and package manifests are **never**
executed by the publisher. Editing YAML must not redeploy the Engine.

## Owner-only setup (no production resources)

1. Create or select one *independent* public Git catalog repository and record
   its exact `owner/repo` and immutable numeric GitHub repository ID. Establish
   the agreed protected main/review policy. Keep engine publisher authority and
   secrets out of this repository. Do not treat a proposed repository name as
   an existing or approved identity.
2. Create an **isolated** Worker and managed D1/Workflows test bindings, with
   approved migrations and non-production data. Verify its own admin publisher
   OIDC settings for the trusted **engine** repository:
   `ADMIN_PUBLISHER_REPOSITORY_ID` (engine ID),
   `ADMIN_PUBLISHER_WORKFLOW_REF` =
   `lirtual/mcp-workers/.github/workflows/workflow-mcp-publisher.yml@refs/heads/main`,
   `ADMIN_PUBLISHER_REF` = `refs/heads/main`. Optionally pin the engine
   workflow SHA with `ADMIN_PUBLISHER_WORKFLOW_SHA`, updating it through the
   owner-controlled configuration process when the trusted workflow changes.
   Never use the catalog repo ID as the authorized OIDC publisher ID.
3. In the **engine** GitHub repository create environment
   `workflow-mcp-publisher-isolated`. Configure an explicit owner approval
   rule before granting stage/activate authority. For a single-user setup,
   self-review must not be forbidden if that user is the only reviewer; if
   account/plan protection cannot provide a real approval, do not enable remote
   mutations pending an alternative approved review path.
4. Set the following engine environment variables (non-secret):
   `WORKFLOW_CATALOG_REPOSITORY`, `WORKFLOW_CATALOG_REPOSITORY_ID` and
   `WORKFLOW_MCP_ISOLATED_URL`. The last one must name only the isolated
   HTTPS Worker; the production workers.dev endpoint is expressly rejected.
   The workflow's `GITHUB_TOKEN` has read-only contents scope. A private
   cross-repository checkout is not supported by this minimal public-catalog
   workflow and must not be simulated as accepted.

## Reproducible acceptance sequence

- Run the **engine** `Workflow MCP Catalog Publisher` manually from protected
  `main` with an exact 40-character catalog commit SHA, e.g.
  `workflows/raindrop-daily-snapshot.yaml`, and `mode=dry-run`. This
  checks the real GitHub repository ID, checkout SHA, trusted snapshot/OIDC,
  compiler policy and generated digest; it performs no stage/activate.
- Inspect the exact source SHA, canonical digest, policy revision and run ID.
  Reject changed source, stale policy, unapproved Connection/tool/webhook or
  unexpected source path. The catalog's own Actions have no publisher authority.
- Following explicit isolated approval, run `mode=stage`. Verify immutable
  `workflow_definition_versions` and source provenance in D1; list/get
  remain unchanged. An identical retry **within the same trusted GitHub run**
  retains the same publication ID. A separate GitHub run receives a distinct
  publication ID to preserve verified publisher-run provenance.
- Following explicit isolated approval, run `mode=activate`, supplying the
  exact `expected_revision` and `expected_digest` (empty only for the first
  activation). Verify a CAS conflict does not change active digest or audit,
  then use the isolated MCP/HTTP path to check the published definition.
  Reconcile an ambiguous response from D1 action history; do not blindly
  repeat a potentially successful external operation.
- Edit **only YAML** in the catalog, repeat the isolated checks with the new
  exact catalog SHA, and compare the Engine SHA/deployment before and after.
  Prove Engine code and deployment did not change. Record actual Actions run,
  D1 digest/revision, live HTTP/MCP evidence and rollback separately.

**Not established by the public-repo CI:** a real catalog repository,
branch/environment protection, enabled isolated bindings, real OIDC exchange,
protected publication, D1 CAS under managed concurrency or production release.
T09 remains Open until those checks are evidenced. This workflow does not
apply D1 migrations, deploy the Worker, rotate Secrets, change Cron, dispatch
business work or merge any pull request.
