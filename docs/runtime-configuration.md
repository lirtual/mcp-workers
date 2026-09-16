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
| Cloudflare Runtime Secrets | Worker runtime | Actual tokens, API keys, OAuth credentials, passwords |
| Cloudflare Build variables/secrets | Build/deploy process | Only values genuinely required during build/deploy |

## Required secrets

Every production Worker configuration declares its mandatory runtime secret names with `secrets.required`. A missing secret is an intentional deployment blocker: `wrangler deploy` must fail and list the missing secret instead of publishing a Worker that fails later at runtime.

| Worker | Required runtime secrets |
| --- | --- |
| `ima-mcp-worker` | `MCP_ACCESS_TOKEN`, `API_KEY`, `CLIENT_ID`, `IMA_DOWNLOAD_SIGNING_KEY` |
| `openlist-mcp-worker` | `MCP_ACCESS_TOKEN`, `OPENLIST_TOKEN` |
| `weread-mcp-worker` | `MCP_ACCESS_TOKEN`, `WEREAD_API_KEY` |
| `database-mcp-worker` | `MCP_ACCESS_TOKEN` |
| `raindrop-mcp-worker` | `MCP_ACCESS_TOKEN`, `RAINDROP_ACCESS_TOKEN` |
| `instapaper-mcp-worker` | `MCP_ACCESS_TOKEN`, `INSTAPAPER_CONSUMER_KEY`, `INSTAPAPER_CONSUMER_SECRET`, `INSTAPAPER_OAUTH_TOKEN`, `INSTAPAPER_OAUTH_TOKEN_SECRET` |

The Database app currently keeps its production binding template in `wrangler.jsonc.example` until real Hyperdrive IDs are supplied. The template still declares the same runtime-secret and observability contract; do not commit placeholder Hyperdrive IDs as a production configuration.

For local development, use uncommitted `.dev.vars` or `.env` files with keys matching `secrets.required`.

## Workers Observability baseline

All six Workers use the same Cloudflare Workers Logs baseline:

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

Do not deliberately log `Authorization` values, `MCP_ACCESS_TOKEN`, upstream API/OAuth credentials, credential-bearing request objects, or full private upstream responses. Prefer structured metadata such as operation/tool name, request ID when available, upstream status, and error category.

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
