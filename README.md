# mcp-workers

Private source monorepo for independently deployed Cloudflare MCP Worker apps.

## Applications

- [GitHub Actions MCP](apps/github-actions-mcp-worker/README.md) — repository-scoped Actions and optional Session Deck controls (source only; not production deployed).

- [Database MCP](apps/database-mcp-worker/README.md)
- [IMA MCP](apps/ima-mcp-worker/README.md)
- [Raindrop MCP](apps/raindrop-mcp-worker/README.md)

Each app owns its upstream domain, credentials, runtime, tests, and deployment. Source changes do not automatically delete or update any deployed Cloudflare Worker or MCP Portal connection.

## Ingress policy

Each maintained MCP Worker uses its Cloudflare `workers.dev` origin:

- `workers_dev: true`
- `preview_urls: false`
- no custom domain or zone route is required for MCP ingress
- the MCP Portal points to `https://<worker-name>.<workers-subdomain>.workers.dev/mcp`

The maintained Workers use the runtime secret name `MCP_ACCESS_TOKEN`; for the single-user deployment the token value is shared across these three Worker bindings. Upstream credentials remain independent. See [ingress policy](docs/ingress-policy.md), [runtime configuration](docs/runtime-configuration.md), and [token runbook](docs/mcp-shared-token-runbook.md).

## MCP smoke runner

Use the root smoke runner to verify one explicitly selected safe/read-only MCP tool over Streamable HTTP. The bearer token is read only from an environment variable, and tool result bodies are not printed.

```bash
MCP_ACCESS_TOKEN='<token>' pnpm smoke:mcp -- \
  --url 'https://example.workers.dev/mcp' \
  --tool 'explicit_safe_tool'
```

The runner also supports `--args-json` for explicit tool arguments and `--token-env` for a different environment variable name. The caller—not tool annotations—must select an operation known to be safe.
