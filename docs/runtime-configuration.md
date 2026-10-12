# Cloudflare runtime configuration

The three MCP Workers maintained here deploy independently but share an ingress-authentication and runtime-configuration contract.

## Source of truth

`wrangler.jsonc` owns non-sensitive configuration, Cloudflare bindings, required Secret **names**, and Workers Observability settings. Actual secret **values** belong in Cloudflare Runtime Secrets, not committed code, Wrangler `vars`, Cloudflare Build credentials, or logs. Runtime credentials must not be copied into build-time variables simply to make Builds succeed.

## MCP entry authentication

All three Workers require runtime Secret `MCP_ACCESS_TOKEN`. For the current single-user deployment, its value is intentionally shared across the three independently configured Worker bindings and the affected MCP Portal clients. Shared MCP entry authentication does not imply shared upstream credentials.

| Worker | Required runtime Secrets |
| --- | --- |
| `ima-mcp-worker` | `MCP_ACCESS_TOKEN`, `API_KEY`, `CLIENT_ID` |
| `database-mcp-worker` | `MCP_ACCESS_TOKEN`, `DATABASE_CONFIG` |
| `raindrop-mcp-worker` | `MCP_ACCESS_TOKEN`, `RAINDROP_ACCESS_TOKEN` |

The Database app stores its logical connection catalog in `DATABASE_CONFIG`. Secret names in `secrets.required` are deployment preconditions; do not remove a name to bypass missing runtime configuration.

See [shared-token rotation runbook](./mcp-shared-token-runbook.md).

## Workers Observability

The maintained Workers use the existing logging baseline:

```jsonc
"observability": {
  "enabled": true,
  "logs": {
    "invocation_logs": true,
    "head_sampling_rate": 1
  }
}
```

Tracing is not automatically part of the baseline. Never emit `Authorization` values, `MCP_ACCESS_TOKEN`, `DATABASE_CONFIG`, upstream credentials, or private upstream responses into logs.

## Deployment verification

1. Configure each Worker's required runtime Secrets under Cloudflare Worker Settings → Variables and Secrets.
2. Deploy the selected app using its current package script or configured Cloudflare Build.
3. Verify the public health endpoint where implemented.
4. Confirm unauthorized `/mcp` calls fail closed.
5. Perform authenticated Portal initialization/tool discovery and an explicitly selected safe read-only tool call.
6. Check Workers Observability without exposing tokens or private data.

Removing source from this repository does not decommission a live Cloudflare deployment or its portal connection. Live resource retirement is a separate authorized action.
