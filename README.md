# mcp-workers

Private source monorepo for independently deployed Cloudflare MCP Worker apps.

## Applications

- [GitHub Actions MCP](apps/github-actions-mcp-worker/README.md)
- [Database MCP](apps/database-mcp-worker/README.md)
- [Email MCP](apps/email-mcp-worker/README.md)
- [HTTP MCP](apps/http-mcp-worker/README.md)
- [IMA MCP](apps/ima-mcp-worker/README.md)
- [OpenList MCP](apps/openlist-mcp-worker/README.md)
- [Raindrop MCP](apps/raindrop-mcp-worker/README.md)
- [Remote Control MCP](docs/remote-control/README.md)
- [SSH MCP](apps/ssh-mcp-worker/README.md)
- [Workflow MCP](apps/workflow-mcp-worker/README.md)

Each app owns its upstream domain, credentials, runtime, tests, and deployment. Source changes do not automatically delete or update any deployed Cloudflare Worker or MCP Portal connection.

## Ingress policy

The maintained Workers do **not** share a universal hostname: Email and Workflow use custom domains with `workers_dev: false`; Remote Control has `workers_dev: true` plus a custom domain; other Workers use `workers.dev`. All disable preview URLs. Obtain the actual Portal target from the Worker's configuration, not from its name.

Each Worker requires runtime Secret `MCP_ACCESS_TOKEN`. The GitHub Repository Secret supplies a release-time default; a same-name Worker Environment Secret may override it. Matching Secret names never prove matching deployed values. See [ingress policy](docs/ingress-policy.md), [runtime configuration](docs/runtime-configuration.md), [manual bootstrap](docs/MANUAL-WORKER-BOOTSTRAP.md) and [token runbook](docs/mcp-shared-token-runbook.md).

## MCP smoke runner

Use the root smoke runner to verify one explicitly selected safe/read-only MCP tool over Streamable HTTP. The bearer token is read only from an environment variable, and tool result bodies are not printed.

```bash
MCP_ACCESS_TOKEN='<token>' pnpm smoke:mcp -- \
  --url 'https://example.workers.dev/mcp' \
  --tool 'explicit_safe_tool'
```

The runner also supports `--args-json` for explicit tool arguments and `--token-env` for a different environment variable name. The caller—not tool annotations—must select an operation known to be safe.

## Remote Control public installation entry (Spec #24)

The existing `remote-control-mcp-worker` is the intended host for the public
`https://rca.lirtual.dpdns.org/` landing page, `/install.sh` (Linux/WSL2) and
`/install.ps1` (Windows). These anonymous **GET-only** resources share the
configured origin but never grant MCP permissions, expose device data or
accept pairing approvals. `/mcp` and signed Agent/WebSocket endpoints retain
their separate authentication.

This source provides reviewed immutable Agent installer pins for Linux and Windows; the Windows route now has a non-null `REVIEWED_WINDOWS_INSTALL_PIN` with commit, script SHA-256 and release-asset SHA-256 checks. These source bindings do **not** independently prove which version is live or that an installation succeeded. Publishing a Release, changing Cloudflare and upgrading paired devices remain separately authorized operations with the normal GitHub Actions gates.
