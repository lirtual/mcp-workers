# mcp-workers

Private source monorepo for six independently maintained MCP applications. Each app keeps its own Cloudflare Worker/runtime boundary, credentials, bindings, deployment history, rollback path, and domain behavior; the monorepo only centralizes source maintenance, dependency resolution, ordinary CI, and the narrow shared Portal-auth mechanism.

## Applications

| Application | Source directory |
| --- | --- |
| IMA | `apps/ima-mcp-worker` |
| OpenList | `apps/openlist-mcp-worker` |
| WeRead | `apps/weread-mcp-worker` |
| Database | `apps/database-mcp-worker` |
| Raindrop | `apps/raindrop-mcp-worker` |
| Instapaper | `apps/instapaper-mcp-worker` |

Architecture and implementation decisions are documented in [`docs/mcp-workers-spec.md`](docs/mcp-workers-spec.md). Migration source baselines are in [`docs/migration-baseline.md`](docs/migration-baseline.md). Current production/cutover and old-repository retirement evidence is tracked in [`docs/final-acceptance.md`](docs/final-acceptance.md).

## Development

The repository uses Node 24 and pnpm 10. Each app owns its local `dev`, `deploy`, `typecheck`, `test`, and `check` behavior. Production deployment remains app-specific; there is no default deploy-all command.

Run an individual app gate with its workspace package name, for example:

```bash
pnpm --filter ima-mcp-worker check
```

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
