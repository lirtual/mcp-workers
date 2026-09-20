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

The generator rejects missing/malformed context before Wrangler deployment.
Keep the D1 database ID, Worker name, R2 bucket and callback base URL tied to
the same real deployment. Do not manually edit the generated file.

## Stable deployment credentials (T15, staged; production activation pending)

Five *independent, stable* platform secrets are required:
`MCP_ACCESS_TOKEN`, `GITHUB_ACTIONS_TOKEN` (repository-scoped fine-grained
Actions token), `EXECUTOR_LEASE_SECRET`, `R2_ACCESS_KEY_ID`, and
`R2_SECRET_ACCESS_KEY`. Provision the five values as protected GitHub environment secrets for
`workflow-mcp-worker` (names exactly as above) before making the PR mergeable.
The deploy job now consumes these persisted values, validates that none are
missing and never generates or derives new values during an ordinary run.
The production Worker already has bindings named for the five platform
credentials; their values cannot be recovered from metadata or assumed to
match GitHub's. The GitHub environment must contain the **same effective
values** as the existing live Worker to preserve active MCP clients and
in-flight Attempt leases. A missing environment secret intentionally blocks
deployment before D1 migrations rather than regenerating it.

The legacy `TRIGGER_SMOKE_WEBHOOK_TOKEN` remains an additional temporary
migration prerequisite until the smoke trigger replacement is implemented.
The Raindrop Connection also needs an independent
`RAINDROP_MCP_ACCESS_TOKEN` secret before its manual production tracer.
Do not mistake these transitional business/test bindings for the five
platform credentials. The Actions token is **not**
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
must prove a manual Raindrop result; T17 owns enabling exactly one minute-level
Cron and observing a real post-job 09:00 Asia/Shanghai occurrence.

Never claim a real scheduled occurrence succeeded from compiler tests or a
manual run. Keep #105–#108 open until their respective acceptance evidence
exists.
