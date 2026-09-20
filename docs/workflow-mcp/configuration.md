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

## Pending production contract migration (T15)

Four *independent, stable* platform secrets are required:
`MCP_ACCESS_TOKEN`, `GITHUB_ACTIONS_TOKEN` (repository-scoped fine-grained
Actions token), `EXECUTOR_LEASE_SECRET`, and `R2_SECRET_ACCESS_KEY`.
`R2_ACCESS_KEY_ID` is the separate required non-secret credential identifier.
Provision the credentials as protected GitHub environment secrets
for deployment and Cloudflare Worker secrets. The Actions token is **not**
the deploy job's ephemeral `github.token`. Never print credentials or upload
the generated secret file as deployment evidence.

During the Expand phase, existing smoke-only connections and webhook secrets
remain valid. Removing them requires migrating workflow definitions and tracer
verification first; avoid leaving registered workflows with missing Connection
references. R2 remains a direct runner-to-R2 signed upload/download path.

Keep credential values unchanged across ordinary deployments. Explicit rotation
must consider connected MCP clients, in-flight Claims, leases, pending callbacks,
and presigned artifact transfers; coordinate cutover and use a verified release
rather than regenerating secret values on each push.

## Release and activation gate

The initial migration is **not** complete merely because the generated config
builds. T15 must pass two successive production deployments with stable
credentials, compatibility checks and both real heavy/MCP tracers. Then T16
must prove a manual Raindrop result; T17 owns independently observing a real
post-job 09:00 Asia/Shanghai occurrence. T14 already preserves the one-minute
Cron in generated config. Production deployment and credential migration remain
blocked until the independent release gates are satisfied.

Never claim a real scheduled occurrence succeeded from compiler tests or a
manual run. Keep #105–#108 open until their respective acceptance evidence
exists.
