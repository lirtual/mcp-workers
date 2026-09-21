# Cloudflare runtime configuration

Each Worker in this repository is deployed independently, but they share the same runtime-configuration contract.

## Source of truth

`wrangler.jsonc` is the source of truth for non-sensitive runtime configuration, Cloudflare bindings, required secret **names**, and Workers Observability settings.

Secret **values** stay in Cloudflare Runtime Variables and Secrets and must not be committed to Git or copied into `vars` just to silence a Dashboard synchronization warning.

Cloudflare Builds variables/secrets are a different scope: they are available while the Git build/deploy job runs. The MCP Workers do not need their upstream API credentials at build time, so runtime credentials must not be duplicated into Build variables/secrets.

| Configuration | Scope | Store here |
| --- | --- | --- |
| Wrangler `vars` | Worker runtime | Non-sensitive runtime settings |
| Wrangler bindings | Worker runtime | R2, Hyperdrive, Rate Limit, and other Cloudflare bindings |
| Wrangler `secrets.required` | Worker runtime contract | Names of mandatory secrets only |
| Cloudflare Runtime Secrets | Worker runtime | Actual tokens, API keys, OAuth credentials, passwords, secret JSON configuration |
| Cloudflare Build variables/secrets | Build/deploy process | Only values genuinely required during build/deploy |

## Common MCP access-token name

All seven MCP Worker entry points use the runtime Secret name `MCP_ACCESS_TOKEN` and, for this **single-user deployment**, the **same token value** for MCP client/Portal entry authentication. This is a deliberate shared **MCP caller credential**, not a shared upstream, platform, administrator, executor, or webhook credential. Worker deployments remain independent: every deployed Worker must receive its own runtime Secret binding containing that same value. A matching name does not automatically distribute or synchronize Secret values between Workers.

Do not add worker-prefixed MCP runtime aliases (such as `WORKFLOW_MCP_ACCESS_TOKEN`) or a second runtime Secret solely for an automated smoke test. Keep the shared value out of Git, plaintext Wrangler `vars`, logs, execution manifests, and workflow definitions. Do not silently replace it on routine deployment; initialize it once and rotate it deliberately across all seven Workers and the MCP clients that depend on it. Since compromising one MCP entry credential now grants access to **every** MCP Worker, protect the token as a cross-application credential and revisit this decision if ownership, users, or exposure diverge.

The single shared MCP caller token does **not** supersede `docs/adr/0022-separate-user-admin-executor-and-webhook-trust-surfaces.md`: the Workflow admin, GitHub executor, and real webhook surfaces remain separately authenticated. Keep each app's upstream credential independent. See `docs/adr/0028-share-single-user-mcp-entry-token-and-minimize-runtime-configuration.md` for the accepted scope and deployment consequences.

## Required secrets

Every production Worker configuration declares its mandatory runtime secret names with `secrets.required`. A missing secret is an intentional deployment blocker: `wrangler deploy` must fail and list the missing secret instead of publishing a Worker that fails later at runtime.

| Worker | Required runtime secrets |
| --- | --- |
| `ima-mcp-worker` | `MCP_ACCESS_TOKEN`, `API_KEY`, `CLIENT_ID` |
| `openlist-mcp-worker` | `MCP_ACCESS_TOKEN`, `OPENLIST_TOKEN` |
| `weread-mcp-worker` | `MCP_ACCESS_TOKEN`, `WEREAD_API_KEY` |
| `database-mcp-worker` | `MCP_ACCESS_TOKEN`, `DATABASE_CONFIG` |
| `raindrop-mcp-worker` | `MCP_ACCESS_TOKEN`, `RAINDROP_ACCESS_TOKEN` |
| `instapaper-mcp-worker` | `MCP_ACCESS_TOKEN`, `INSTAPAPER_CONSUMER_KEY`, `INSTAPAPER_CONSUMER_SECRET`, `INSTAPAPER_OAUTH_TOKEN`, `INSTAPAPER_OAUTH_TOKEN_SECRET` |
| `workflow-mcp-worker` | `MCP_ACCESS_TOKEN`, `EXECUTOR_LEASE_SECRET`, `GITHUB_ACTIONS_TOKEN`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` |

`database-mcp-worker` stores its complete logical database catalog in the single `DATABASE_CONFIG` Secret. Direct SQL URLs therefore remain secret without requiring separate `DATABASE_URL` / `DATABASE_WRITE_URL` variables. Hyperdrive entries still refer to Wrangler bindings by name.

For local development, use uncommitted `.dev.vars` or `.env` files with keys matching `secrets.required`.

## Workflow v0.1 configuration reduction (approved design; not yet deployed)

| Setting group | Decision |
| --- | --- |
| MCP caller | One shared `MCP_ACCESS_TOKEN` value across all seven Workers. No `WORKFLOW_MCP_ACCESS_TOKEN` runtime alias and no duplicate `SMOKE_READONLY_MCP_TOKEN`. |
| Routine deployment verification | Check health and reject unauthenticated MCP requests without using the production MCP token. Full authenticated MCP/heavy/connection smoke tests are manual, separately invoked acceptance checks, not mandatory steps of every production push. Keep test-only credentials in the explicit test context and never create an auto-rotating production MCP secret. |
| Dedicated smoke webhook | Remove the smoke-only webhook and `TRIGGER_SMOKE_WEBHOOK_TOKEN` from the production runtime contract. Do not remove real webhook support: real configured triggers have distinct, scoped authentication and are not authenticated by `MCP_ACCESS_TOKEN`. |
| Static configuration | Fixed repository/ref/workflow, GitHub OIDC URLs/audience, resource names, and safe non-sensitive defaults live in version-controlled configuration or code. Avoid duplicate Cloudflare dashboard overrides and duplicated CI inputs. Keep actual Cloudflare resource IDs in the deployment configuration as needed; they are identifiers, not secrets. |
| Platform credentials | Keep `GITHUB_ACTIONS_TOKEN` (repository-scoped long-lived authorization, **not** a deployment-job `github.token`), `EXECUTOR_LEASE_SECRET`, and the credentials required by the **current** R2 direct-upload signing implementation separate. Consider the latter for reduction only after verifying equivalent signed-upload behavior. |
| Runtime resources | Keep the D1, Workflows, R2, and version-metadata bindings as needed by implemented behavior. Do not classify bindings as optional merely to lower a dashboard count. |
| Cron scheduler | Preserve the intended scheduler tick. Generated deployment configuration keeps the checked-in `* * * * *` Cron. Live 09:00 business occurrence remains #108. |
| Ownership and consistency | `wrangler.jsonc` and audited code defaults own non-sensitive settings; Cloudflare runtime owns secret values; CI owns only genuine deployment/test credentials. Never rotate or delete a live Secret just to reconcile naming before code and clients are ready. |

**Implementation specification:** [`docs/workflow-mcp/runtime-config-simplification-spec.md`](./workflow-mcp/runtime-config-simplification-spec.md) governs the cross-Worker rollout and end-to-end acceptance. Its four-Secret Workflow platform baseline also keeps `R2_ACCESS_KEY_ID` as a separately required non-secret credential identifier; real integrations may require additional Secrets. Do not optimize for a raw dashboard count.\n\nThe source contract no longer requires production-only smoke webhook/MCP secrets. Ordinary deploys still must not rotate live platform credentials; #106 owns the remaining deploy-workflow credential persistence work. Shared-value cutover is #123.

## Workers Observability baseline

All seven Workers use the same Cloudflare Workers Logs baseline:

```jsonc
"observability": {
  "enabled": true,
  "logs": {
    "invocation_logs": true,
    "head_sampling_rate": 1
  }
}
```

This intentionally captures 100% of invocation logs for the current low-volume deployment. Tracing is not part of the common baseline; enable it only for a specific investigation with an explicit sampling rate.

Do not deliberately log `Authorization` values, `MCP_ACCESS_TOKEN`, `DATABASE_CONFIG`, upstream API/OAuth credentials, credential-bearing request objects, or full private upstream responses. Prefer structured metadata such as operation/tool name, request ID when available, upstream status, and error category.

## Deployment behavior

Before deploying an existing Worker, configure its required values under **Worker Settings → Variables and Secrets** as **Secret** values. Then deploy from the app directory with its normal `pnpm run deploy` command or through the configured Cloudflare Build.

A successful deployment means all names in `secrets.required` already exist on the target Worker. Do not remove a required name merely to make a deployment green; add the missing runtime secret instead.

After deployment, verify the Worker at the public seams:

1. Check `/health` and `/ready` where the app exposes them.
2. Call `/mcp` without valid Portal authorization and confirm it returns an authorization failure rather than `portal_auth_not_configured`.
3. Connect MCP Portal with `Authorization: Bearer <MCP_ACCESS_TOKEN>` and complete MCP initialization/tool discovery.
4. Confirm the invocation appears in Workers Observability logs.
5. Confirm logs do not expose the access token or upstream credentials.

Use the root `pnpm smoke:mcp` runner for a representative explicitly selected safe/read-only MCP tool after Portal discovery succeeds.

### Workflow derived configuration (T14) and smoke isolation (T19)

Generated production Wrangler config derives `GITHUB_REPOSITORY`, `GITHUB_REPOSITORY_ID`, `R2_ACCOUNT_ID`, and `R2_BUCKET_NAME` from the GitHub/Cloudflare deployment context and R2 bucket binding. `src/platform-config.ts` pins executor ref/workflow and GitHub OIDC trust anchors. Dedicated smoke webhook/connection fixtures live under `apps/workflow-mcp-worker/acceptance/` and are not compiled into the production registry. The default deploy probe is `/health` plus unauthenticated `/mcp` denial; the authenticated heavy tracer runs only when `full_acceptance` is set on a manual dispatch.
