# mcp-workers

Private source monorepo for independently deployed Cloudflare MCP Worker apps.

Implementation is tracked on `feat/mcp-workers-monorepo`.

## Ingress policy

All MCP Worker apps use their Cloudflare `workers.dev` origin as the production Worker endpoint:

- `workers_dev: true`
- `preview_urls: false`
- no custom domain or zone route is required for MCP ingress
- Cloudflare MCP Portal points to each Worker's `https://<worker-name>.<workers-subdomain>.workers.dev/mcp` endpoint

Worker names remain app-specific (`<app>-mcp-worker`) and each Worker keeps its own `MCP_ACCESS_TOKEN`.

## MCP smoke runner

Use the root smoke runner to verify one explicitly selected safe/read-only MCP tool over Streamable HTTP. The bearer token is read only from an environment variable, and tool result bodies are not printed.

```bash
MCP_ACCESS_TOKEN='<token>' pnpm smoke:mcp -- \
  --url 'https://example.workers.dev/mcp' \
  --tool 'explicit_safe_tool'
```

Pass a JSON object when the selected tool needs arguments:

```bash
MCP_ACCESS_TOKEN='<token>' pnpm smoke:mcp -- \
  --url 'https://example.workers.dev/mcp' \
  --tool 'explicit_safe_tool' \
  --args-json '{"limit":1}'
```

For a differently named secret, set that environment variable and pass its name with `--token-env`. The runner never chooses a tool from `readOnlyHint` or other annotations; the caller must select a tool that is known to be safe for the target application.
