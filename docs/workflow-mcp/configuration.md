# Workflow MCP deployment configuration

This document describes the staged migration in [v0.1 §27.1](v0.1-spec.md).
Do not enable the production schedule before the stable-credential release checks and manual Raindrop acceptance pass. The real production tracer runs as part of the deployment job, so the post-deploy acceptance evidence cannot exist before its first deployment.

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
Before any D1 migration or Worker deployment, a read-only preflight checks the
existing live Workflow MCP token (except first-time `bootstrap=true`) and the
Raindrop token via authenticated `tools/list`. It verifies required tool names
without logging credential values or bookmark contents. Missing or mismatched
credentials fail closed; the check cannot establish that the independent lease,
GitHub Actions or R2 keys match the currently deployed secrets. Those are
covered by the subsequent actual executor/artifact tracers.

The webhook/scheduled smoke definition now lives only under
`tests/fixtures/`; the production workflow registry has no retired smoke
schedule or webhook secret reference. Legacy Connection aliases remain
available for pinned nonterminal Plans until compatibility checks and live
tracers authorize their removal. The Raindrop Connection needs a sixth,
independent business secret `RAINDROP_MCP_ACCESS_TOKEN`, matching the
Raindrop Worker's `MCP_ACCESS_TOKEN`, before its manual production tracer.
Cloudflare exposes only secret names, not values: do not rotate the existing
Raindrop token or guess its value. Use secure provisioning of the existing
credential, or coordinate an explicit rotation when no dependent clients
will be interrupted.
Do not mistake these transitional business/test bindings for the five
platform credentials. The Actions token is **not**
the deploy job's ephemeral `github.token`. Never print credentials or upload
the generated secret file as deployment evidence.

The new `workflow-self` Connection uses the stable `MCP_ACCESS_TOKEN` and a
fixed production endpoint. Its heavy and self-connection tracers must pass
before removing obsolete **deployed** Cloudflare secrets. The source-level
connection aliases are retained for older pinned Plans. R2 remains a direct
runner-to-R2 signed upload/download path.

Keep credential values unchanged across ordinary deployments. Explicit rotation
must consider connected MCP clients, in-flight Claims, leases, pending callbacks,
and presigned artifact transfers; coordinate cutover and use a verified release
rather than regenerating secret values on each push.

## Explicit Raindrop manual acceptance

After five stable platform secrets and the separate
`RAINDROP_MCP_ACCESS_TOKEN` are provisioned consistently in the protected
GitHub environment, use the existing **Workflow MCP Deploy** manual dispatch
with `verify_raindrop_manual=true` and
`WORKFLOW_MCP_ENABLE_SCHEDULE=false` (default). This verifies the heavy
GitHub→R2 and self-MCP release tracers first, then admits a real manual
`raindrop-daily-snapshot` Run. It checks `workflow_list`/`workflow_get`
digest, `workflow_status` provenance and terminal success,
`workflow_result` structured outputs (0–20 returned items, separate upstream
total), and `workflow_logs`. The summary and artifact
`workflow-mcp-raindrop-evidence.json` contain Run ID, version/digest,
timestamps, counts and SHA-256 of the actual records; **bookmark titles, URLs,
secrets, and signed URLs are not printed**. The real record set remains
available from authenticated `workflow_result`.

The verifier can also be invoked independently with
`pnpm --filter workflow-mcp-worker release:raindrop-manual` when
`WORKFLOW_MCP_URL` and `WORKFLOW_MCP_ACCESS_TOKEN` are supplied securely.
It does not activate Cron or mutate bookmarks; upstream failures keep the
manual acceptance open. Do not claim T16 success from compiled fixtures.

## Release and activation gate

The initial migration is **not** complete merely because the generated config
builds. T15 must pass two successive production deployments with stable
credentials, compatibility checks, and all three real tracers: heavy GitHub, self-MCP,
and a manual Raindrop run with valid structured result (T16). Record the three
Run IDs from deployment evidence. The generated configuration leaves Cron disabled by default. After the T16
manual production tracer succeeds, set the protected GitHub environment variable
`WORKFLOW_MCP_ENABLE_SCHEDULE=true` and dispatch the deployment workflow.
Only then does the generator add exactly one `* * * * *` Cloudflare Cron.
Keep the flag set for later ordinary pushes. Set it to `false` (and redeploy)
to suspend new ticks during recovery. T17 requires a real post-job 09:00
Asia/Shanghai occurrence, correlated with D1 and MCP evidence.
Follow [the post-job schedule verification procedure](schedule-verification.md)
before closing #108.

Never claim a real scheduled occurrence succeeded from compiler tests or a
manual run. Keep #105–#108 open until their respective acceptance evidence
exists.
