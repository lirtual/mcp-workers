# GitHub Actions MCP Worker

A standalone Cloudflare Streamable HTTP MCP server that uses **only the GitHub REST API** to manage GitHub Actions. Repositories such as `autoactions/tsrv` and `autoactions/tsvc` are ordinary workflow repositories; no dependency on Session Deck, runner agent, session service, D1, R2 or Durable Objects exists.

## Configuration

| Name | Type | Usage |
| --- | --- | --- |
| `MCP_ACCESS_TOKEN` | Required runtime Secret | Reuse existing single-user MCP Portal Bearer token |
| `GITHUB_TOKEN` | Required runtime Secret | GitHub fine-grained PAT with Actions Read & Write in permitted repositories; `repository_dispatch` also requires Contents Write |
| `GITHUB_REPOS` | Wrangler variable | Comma-separated repository allowlist |

The default allowlist is `autoactions/tsrv,autoactions/tsvc`. Add another `owner/repo` to this single variable when needed. Do not check tokens into source control. A GitHub App installation token is short-lived; the first release uses a PAT, avoiding token-generation machinery.

## Tools

| Tool | Purpose |
| --- | --- |
| `repositories_list` | Show allowed repositories |
| `workflows_list` | List GitHub Actions workflows |
| `runs_list` | List recent runs with optional workflow/status filter |
| `run_get` | Get one run's status and URL |
| `run_jobs_list` | Get job and step outcomes (not logs) |
| `run_artifacts_list` | List run artifact metadata |
| `workflow_dispatch` | Trigger a workflow on an explicit branch or tag |
| `repository_dispatch` | Emit a custom repository event |
| `run_cancel` | Cancel one run with `confirm: true` |
| `run_rerun` | Rerun all jobs or failed jobs |

Examples:

- `workflow_dispatch(repo="autoactions/tsrv", workflow="linux.yml", ref="main", inputs={"access_profile":"mini","session_profile":"developer"})`
- `workflow_dispatch(repo="autoactions/tsrv", workflow="windows.yml", ref="main", inputs={"session_profile":"core","enable_wsl":"false"})`
- `workflow_dispatch(repo="autoactions/tsvc", workflow="tsvc.yml", ref="main", inputs={"service":"code-server"})`

`workflow_dispatch` opts in to the GitHub API's run details response (`workflow_run_id`, `run_url`, `html_url`) for exact follow-up. Query `run_get` for actual run state, then use `run_cancel` if necessary. A legacy 204 response indicates acceptance without a run ID. The MCP does not claim session readiness, exclusivity, or a working SSH/HTTP endpoint. It deliberately does **not** replicate Session Deck's session catalog, readiness observer, locator parsing or decryption features. Artifact names, IDs and sizes can be queried, but artifact content and raw runner logs are outside this MVP.

## Local checks

At monorepo root:

```bash
pnpm install --frozen-lockfile
pnpm --filter github-actions-mcp-worker check
```

`check` covers typecheck, Node/MCP protocol tests and Cloudflare bundling dry-run. It is safe and does not invoke GitHub workflow mutations.

```bash
pnpm --filter github-actions-mcp-worker dev
```

All `/mcp` requests require the shared Bearer token; `/health` returns only basic service liveness. Github credentials are never returned through MCP results.

## Release boundary

This draft PR is **source-only**. It registers application CI checks but intentionally leaves this app out of the existing production Worker release choices. No Cloudflare Worker, Secrets, Portal plugin, or GitHub Actions run is provisioned by merging this source alone. Deployment is a separate reviewed action.
