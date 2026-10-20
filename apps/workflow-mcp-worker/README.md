# Workflow MCP Worker — S1 only

Implementation branch for [Issue #141](https://github.com/lirtual/mcp-workers/issues/141).
This is an **isolated S1 implementation** of Draft → Validate → Publish → Run → Result,
not a deployment or acceptance of S2/S3. It must not be deployed to production
without provisioning and reviewing the actual D1 database, binding and Portal secret.

## Boundaries

- Reuses the existing Portal bearer authentication on `/mcp`.
- YAML or JSON Drafts; optimistic revision CAS; atomic explicit Publish of immutable Plans.
- Finite DAG (32 nodes, at most 8 ready independent Steps), restricted references and conditions.
- Manual asynchronous Run ID; D1 and Cloudflare Workflows state and result.
- **Only** `s1.readonly_mcp` / `echo` through a fixed private Service Binding
  and `result.emit`. No dynamic Internet URL, external write, Shell, code evaluation,
  webhook, Cron, OAuth, stored target credential or GitHub heavy execution.
- D1 Run admission idempotency, fixed instance IDs and bounded lookup after ambiguous create.
  S1 does not add an overflow queue, a second DAG engine or an external lock service.
- Runtime execution must not be labeled production-proven based on unit tests or local Wrangler alone.

## Setup for local smoke tests only

Use Node 24, `corepack pnpm install`, then
`corepack pnpm --filter workflow-mcp-worker run check` and
`corepack pnpm --filter workflow-mcp-worker run deploy:dry-run`.

The Wrangler configuration deliberately contains an invalid placeholder D1 ID,
`workers_dev: false` and no production credentials. Never deploy that configuration as-is.

For local tests:
1. From the app directory, `wrangler d1 migrations apply workflow-mcp-worker --local`
   (use matching `--persist-to` for the dev server).
2. Start the read-only fixture with `wrangler dev --local --config tests/fixtures/wrangler.jsonc --port 8790`.
3. Start the S1 Worker with `wrangler dev --local --port 8787 --var MCP_ACCESS_TOKEN:<local-test-only-token>`.
4. Call `/mcp` with a matching local Bearer token; use `tools/list`, `workflow_create`,
   `workflow_validate`, `workflow_publish`, `workflow_run`, `workflow_status`
   and `workflow_result`. Never use real secrets or production D1.

Only two fixed app bindings are necessary: `DB` and `WORKFLOW`, plus
`READONLY_TARGET` for the isolated test seam. Actual deployment and live edge
validation need separate authorization.

## Evidence and remaining work

Local Wrangler E2E (2026-10-20) returned an immutable Published Version,
an idempotently replayed Run ID, two successful Steps and the read-only
`hello S1` MCP output. This is **local evidence only**; no S1 production deployment
or Cloudflare-edge end-to-end acceptance has been performed.

Still required before S1 is complete: comprehensive public-MCP-tool seam integration
cases (revision conflict, concurrent Publish, Run pinning after republish, restart/instance
create ambiguity, capacity overflow), full repo test suite, independent standards/spec
code review, isolated Cloudflare real Run acceptance and an explicit release decision.

Q1–Q50 design remains in [Draft PR #135](https://github.com/lirtual/mcp-workers/pull/135);
new S2/S3 facilities are not to be provisioned here.
