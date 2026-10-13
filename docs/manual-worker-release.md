# Manual Cloudflare Worker release — operator acceptance

Implements the code-only publishing contract in [Spec #19](https://github.com/lirtual/mcp-workers/issues/19) and the separately authorized cutover in [T06 #27](https://github.com/lirtual/mcp-workers/issues/27).

## Preconditions (not authorized by this document)

- Review and merge the implementation PR to trusted `main` only with separate maintainer approval. Pushes/PRs **run checks only**. `workflow_dispatch` is the only publisher.
- Confirm the private repository actually supports GitHub `production` Environment Secrets, required reviewers and main-branch deployment restrictions. If not, stop; do not fall back to repository-wide credentials.
- Separately authorize the Cloudflare deploy token and configure **only** `CLOUDFLARE_API_TOKEN` (Environment Secret), `CLOUDFLARE_ACCOUNT_ID` (Environment Variable) and `REMOTE_CONTROL_VPC_SERVICE_ID` (Environment Variable for Remote Control). Limit token scope to the account and needed Worker edit/read operations.
- Keep `MCP_ACCESS_TOKEN`, upstream credentials, device credentials and Database configuration **only in Cloudflare**; never copy their values to GitHub.
- For the selected Worker, record current active version, required binding/Secret **names**, live observability and any competing automatic publisher. Disable an actual competing publishing trigger only with separate approval.
- Authorize **one Worker at a time** in this order: IMA → Raindrop → Database → Remote Control. The current GitHub workflow cannot itself grant production or token-rotation permission.

## Design-branch sequencing note (cross-Worker Q16=A)

This proposed runbook update aligns sequencing with [client-owned tool approval ADR](./tool-authorization/adr/0001-delegate-tool-approval-to-client.md). It changes **only the sequence for later independently authorized rollouts**, not the currently deployed Worker, tool permissions, credential grants, or GitHub Actions trigger. For Raindrop, future cleanup tool calls retaining old names will become immediately destructive (ADR-0003); require a separate breaking-change review and client tool refresh before that Worker is released. For Database, the new single-connection format is a breaking Cloudflare Secret migration requiring separate authorization. Remote Control write/Shell gating and existing T07/T09/T10 acceptance requirements remain in force until a separate production decision. This branch document is not operationally active until reviewed and merged.

## Design decisions for future tool-approval migration (Q17–Q19)

These acceptance requirements apply **only after** the relevant code has been reviewed and separately approved for deployment; this design-branch runbook does not authorize any publish or runtime configuration change.

- **Raindrop Q17=A:** verify conservative duplicate selection, annotated/highlighted-item skip rules where implemented, bounded batch/partial results, and no blind retry. The existing `empty_trash`, `cleanup_collections`, and `remove_duplicates` names become immediately destructive after migration. No preview smoke test or actual production delete is authorized.
- **Raindrop Q18=A:** require a real ChatGPT MCP reconnect/refresh and observe a new tool list with direct-destructive semantics, correct input schemas and risk annotations. If the client keeps preview-era definitions, **do not accept the cutover**; investigate the client connection/cache rather than invoking deletion for evidence.
- **Database Q19=A:** a future separately authorized one-time `DATABASE_CONFIG` migration may include a short fail-closed maintenance interruption. No zero-downtime dual-format parser. Preserve `MCP_ACCESS_TOKEN` and `DATABASE_CONFIG` Secret **names**, existing RATE_LIMITER policy, and separate review of any target-database grants. Do not copy Secret values to GitHub Actions, commits or acceptance logs.
- **Remote Control Q15=A:** an in-place test plan for the existing Agent requires read-only preflight and a *new explicit owner approval* before any production gate change, fixture file write or Shell invocation. A documentation merge is not test permission. Preserve the independent ingress credential, private VPC link, safe logging and outstanding T07/T09/T10 release blockers. Gate-removal source must not be deployed to the live Remote Control endpoint without its special acceptance and approval.
- Use [the scoped implementation plan](./tool-authorization/IMPLEMENTATION-PLAN.md) to track code-only PRs and per-stage release evidence; `workflow_dispatch` remains the only publisher.

## Each separately authorized release

1. In GitHub Actions, open the existing **CI** workflow → **Run workflow**, select current `main` and exactly one allowlisted Worker. The run must reject a stale commit, branch other than `main`, invalid target, failed application checks, or Database integration not `success`.
2. Confirm `production` Environment approval and that checks ran on the same SHA. Worker-scoped concurrency serializes releases without cancelling an active deployment.
3. Confirm read-only Cloudflare preflight passed; it checks existing required Runtime Secret names and mandatory resource/security bindings without reading Secret values. Wrangler deploy uses only the selected app's source/config and the dedicated deploy token.
4. Require **exact** Wrangler Version ID = Cloudflare 100%-active Version ID, along with required post-release bindings. A successful upload alone is not acceptance. Unauthenticated synthetic `/mcp` must not disclose tool/data access; an Edge 403 alone does not prove Portal connectivity.
5. From the **existing Portal/client**, use existing credentials outside Actions to verify MCP initialize, tools/list and one explicitly safe read-only operation. Record only Worker, source SHA, CI run, active version, non-secret binding status and human outcome—never Authorization headers, live file content or secrets.
6. Mark this Worker's production cutover accepted only after both automation and Portal checks pass. On failure, stop this Worker's rollout and investigate; **no automatic rollback**. Recovery is a reviewed commit on the latest `main` and a newly authorized manual release, not a historical Cloudflare Version restore.

## Worker-specific constraints

- **Raindrop:** preserve `MCP_ACCESS_TOKEN` and `RAINDROP_ACCESS_TOKEN` Secret names. The bounded retry setting has a source default and is not a new GitHub variable.
- **IMA:** `IMA_IMAGE_REFRESH_SHARD` (SQLite Durable Object) and `MCP_ACCESS_TOKEN`, `API_KEY`, `CLIENT_ID` remain mandatory. Initial production still uses legacy R2; current source exports with **explicit public Litterbox upload (24-hour URL, 32 MiB maximum)**. When the old R2 Worker binding is present, the manual checkbox must explicitly acknowledge this functional/privacy cutover **in addition to separate production authorization**. Normal binary reads must not upload. Portal acceptance may use a *non-confidential synthetic fixture* to verify explicit upload, public URL/expiry, expected safe errors and no implicit uploads. Do **not** upload private material or delete the old Cloudflare R2 bucket/domain/objects.
- **Database:** `database-integration` must actually succeed with PostgreSQL 17 and MySQL 8.4; `skipped`, `failure` and `cancelled` are not acceptable. Preserve `RATE_LIMITER` namespace `1001`, 120 requests / 60 seconds and Runtime Secret names `MCP_ACCESS_TOKEN` and `DATABASE_CONFIG`. Do not log database rows.
- **Remote Control:** compare the supplied `REMOTE_CONTROL_VPC_SERVICE_ID` to the live `REMOTE_CONTROL_DEVICE` **VPC Service** identity without logging its value. Publish with a temporary ignored Wrangler config; remove it afterward. Preserve `MCP_ACCESS_TOKEN`, `REMOTE_CONTROL_DEVICE_TOKEN`, **independently approved** `REMOTE_CONTROL_ENABLE_FILE_WRITES="true"` and `REMOTE_CONTROL_ENABLE_SHELL="true"` ([Issue #14](https://github.com/lirtual/mcp-workers/issues/14)), and **Invocation Logs disabled**. Human acceptance is limited to safe read-only marker verification. Do not run Shell, file mutation or device management as automatic smoke tests.

Runtime `MCP_ACCESS_TOKEN` value unification/rotation and logging-policy changes across Workers are **outside** this migration and require a separate security review and owner authorization.

Manual Actions workflow dispatch **deploys the selected Worker to production** after checks and production Environment approval; it is not a check-only operation. After version/binding readback, existing IMA and Raindrop /health endpoints must return HTTP 200 and the expected JSON status. Wrangler failures expose only a whitelisted numeric code and generic failure summary, not raw deploy logs. Production Portal acceptance remains a separate manual gate.
