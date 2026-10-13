# Manual Cloudflare Worker release — operator acceptance

Implements the code-only publishing contract in [Spec #19](https://github.com/lirtual/mcp-workers/issues/19) and the separately authorized cutover in [T06 #27](https://github.com/lirtual/mcp-workers/issues/27).

## Preconditions (not authorized by this document)

- Review and merge the implementation PR to trusted `main` only with separate maintainer approval. Pushes/PRs **run checks only**. `workflow_dispatch` is the only publisher.
- Confirm the private repository actually supports GitHub `production` Environment Secrets, required reviewers and main-branch deployment restrictions. If not, stop; do not fall back to repository-wide credentials.
- Separately authorize the Cloudflare deploy token and configure **only** `CLOUDFLARE_API_TOKEN` (Environment Secret), `CLOUDFLARE_ACCOUNT_ID` (Environment Variable) and `REMOTE_CONTROL_VPC_SERVICE_ID` (Environment Variable for Remote Control). Limit token scope to the account and needed Worker edit/read operations.
- Keep `MCP_ACCESS_TOKEN`, upstream credentials, device credentials and Database configuration **only in Cloudflare**; never copy their values to GitHub.
- For the selected Worker, record current active version, required binding/Secret **names**, live observability and any competing automatic publisher. Disable an actual competing publishing trigger only with separate approval.
- Authorize **one Worker at a time** in this order: Raindrop → IMA → Database → Remote Control. The current GitHub workflow cannot itself grant production or token-rotation permission.

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
