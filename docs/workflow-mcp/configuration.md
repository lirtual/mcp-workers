# Workflow MCP deployment configuration

This document describes the staged migration in [v0.1 §27.1](v0.1-spec.md).
Do not merge or deploy a partial migration until the full release gate passes.

## Source-controlled trust configuration

`apps/workflow-mcp-worker/src/platform-config.ts` pins the executor workflow
name/ref and GitHub OIDC issuer, audience, and JWKS URL. Dashboard variables
must not override these trust anchors. The optional workflow SHA pin remains
a separate explicit security constraint if configured.

The deployment config generator obtains **four non-secret runtime values**:

| Runtime binding | Source at deployment |
| --- | --- |
| `GITHUB_REPOSITORY` | GitHub `github.repository` |
| `GITHUB_REPOSITORY_ID` | GitHub `github.repository_id` |
| `R2_ACCOUNT_ID` | `CLOUDFLARE_ACCOUNT_ID` |
| `R2_BUCKET_NAME` | `WORKFLOW_MCP_R2_BUCKET`, also used for the R2 binding |

The generator rejects missing, malformed, or wrong-repository context before Wrangler deployment. It preserves the canonical checked-in `* * * * *` Cron and fails if the schedule is absent or inconsistent.
Keep the D1 database ID, Worker name, R2 bucket and callback base URL tied to
the same real deployment. Do not manually edit the generated file.

## Code-level contract (PR #125; production cutover pending)

The code-level platform baseline declares four **independent** Worker Secrets:
`MCP_ACCESS_TOKEN`, `EXECUTOR_LEASE_SECRET`, `GITHUB_ACTIONS_TOKEN`
(repository-scoped long-lived authorization), and `R2_SECRET_ACCESS_KEY`.
`R2_ACCESS_KEY_ID` is still required by the S3 presigner but is a **non-secret**
identifier supplied by the protected GitHub deployment environment variable
`R2_ACCESS_KEY_ID` and compiled into a normal Worker `vars` binding. It must
match its independently provisioned `R2_SECRET_ACCESS_KEY`. No runtime credential
may be regenerated on an ordinary deployment or copied to CI just to pass tests.
The GitHub Actions `github.token` cannot replace the Worker's long-lived
`GITHUB_ACTIONS_TOKEN`.

The default deploy checks required configuration and the **names** of persisted
Worker Secrets, runs the app checks and compatibility gate, deploys without a
`--secrets-file`, and verifies `/health` plus an unauthenticated `/mcp`
rejection. The dedicated webhook smoke fixture is local to tests, and the
optional manual MCP self-connection uses the same `MCP_ACCESS_TOKEN`, not a
second production smoke token. Full authenticated MCP, GitHub Claim/OIDC and
R2 verification is explicitly initiated separately, using an authorized test
context and `scripts/run-deploy-tracer.ts`.

Before production deployment, #123 requires an explicit operator-approved
**Workflow configuration migration, not a shared-token cutover**. The operator
confirmed on 2026-09-20 that all seven production Workers already share the
same `MCP_ACCESS_TOKEN` value: **preserve all seven installed bindings and
existing MCP clients/Portal connections**. Verify independent persistent
Workflow platform credentials, convert the legacy `R2_ACCOUNT_ID` and
`R2_ACCESS_KEY_ID` Secrets into non-secret configuration and the deployment
variable respectively without changing the effective R2 credential pair, and
safely remove obsolete smoke-only bindings **after** the new registry and
compatibility checks are accepted. The deployment intentionally fails closed if
the GitHub environment's R2 access ID is absent, a required runtime Secret is
missing, or a legacy conflicting `R2_ACCOUNT_ID` or `R2_ACCESS_KEY_ID` Secret remains. Do not
remove or rotate a live token merely because this code branch exists.

See [the full spec](runtime-config-simplification-spec.md),
[the operator runbook](shared-mcp-token-cutover.md), and
[ADR 0028](../adr/0028-share-single-user-mcp-entry-token-and-minimize-runtime-configuration.md)
for dependent-client coordination and rollback. Preserve the checked-in
`* * * * *` Cron. Do not confuse this scheduler tick with an observed 09:00
business occurrence; #108 verifies that occurrence separately.

## Acceptance boundary

#105, #121, #122 and #106 are code/configuration slices. Only #123 covers
an **explicitly authorized live Workflow configuration** migration and actual post-job acceptance;
#107 and #108 remain separate business verification. A green code-only CI run
does not establish that seven live Secret values match, that the GitHub
runtime credential works after CI exits, or that any schedule executed.
