# mcp-workers

Private source monorepo for independently deployed Cloudflare MCP Worker apps.

Source consolidation, workspace migration, Portal-auth convergence, and post-migration pruning are complete in this repository. Production deployment, MCP Portal cutover/discovery, publisher retirement, and old source-repository archival remain separate operational acceptance steps and must not be inferred from source/CI status alone.

## Migration completion rule

A frozen source snapshot is migration evidence, not the final repository shape. A migrated app is not considered complete until it runs from the monorepo, its active files have a current runtime/verification/build-deploy/documentation/legal/provenance responsibility, obsolete standalone-repository artifacts have been pruned, current documentation is internally consistent, and the applicable monorepo checks pass. Historical material remains recoverable from Git history and the frozen source commit rather than being kept indefinitely in the active tree.

Source-repository retirement and production cutover remain separate final actions after source/CI acceptance.

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
