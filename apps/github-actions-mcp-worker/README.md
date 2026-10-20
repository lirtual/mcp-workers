# GitHub Actions MCP Worker

Cloudflare Streamable HTTP MCP server using only GitHub REST API for workflow and run management. No Session Deck API, D1, R2 or background runner service.

## Configuration

Only these GitHub Environment Secrets are used:

| Secret | Purpose |
| --- | --- |
| `MCP_ACCESS_TOKEN` | Existing Portal Bearer authentication |
| `GH_TOKEN` | First fine-grained GitHub PAT (required) |
| `GH_TOKEN_SECONDARY` | Second fine-grained GitHub PAT (optional) |

The two PATs can belong to different GitHub accounts. Select repositories using each token's own GitHub fine-grained repository access settings; grant **Actions Read and Write** when dispatching, cancelling or rerunning runs. Add **Contents Write** only when `repository_dispatch` is needed. Metadata Read is required for repository discovery and is normally included with fine-grained PATs.

**There is no `GH_ACTIONS_REPOS`, `GITHUB_REPOS` or per-repository token map.** The server queries GitHub `GET /user/repos` independently for each PAT, and `repositories_list` returns the combined accessible repository list. Existing tools continue accepting `repo: "owner/repo"`, and the server selects the correct PAT before sending the operation.

If both tokens enumerate the same repository, the repository appears in `ambiguous_repositories` and the server refuses actions on it. Narrow one PAT's repository selection rather than allowing fallback. If repository discovery, validation, or an upstream request fails, operations fail closed. A failed mutation is **never** replayed through another PAT. No token value, raw GitHub error body or private response content is returned to MCP clients.

To keep discovery bounded, the current implementation supports at most 200 enumerated repositories per PAT; exceeding this limit reports `repository_discovery_limit` instead of silently using a partial list. The current version provides a maximum of two PAT slots, with no multi-user OAuth, database, token vault, JSON secrets or extra MCP tools.

### Setup

In the GitHub Environment `github-actions-mcp-worker`, retain `GH_TOKEN` and optionally add `GH_TOKEN_SECONDARY`. The existing selected-Worker GitHub Actions deployment stages these named Secrets for only this Worker. Do not place real tokens in variables, configuration files, Issues, PR descriptions or source code. Repository selection and PAT expiry/rotation remain managed directly at GitHub.

This Draft change does not itself publish a Worker. Merge and production release are separate actions; existing Worker operation is unchanged until the selected-Worker deployment executes.

## MCP tools

| Tool | Action |
| --- | --- |
| `repositories_list` | Discover GitHub repositories through configured PATs |
| `workflows_list` | List workflows in a permitted repo |
| `runs_list` | List workflow runs |
| `run_get` | Read a run's status and source |
| `run_jobs_list` | List jobs and step statuses |
| `run_artifacts_list` | List artifact metadata only |
| `workflow_dispatch` | Start a workflow on a specified ref |
| `repository_dispatch` | Emit repository event |
| `run_cancel` | Request a cancellation with confirmation |
| `run_force_cancel` | Force cancellation with confirmation |
| `run_rerun` | Restart failed or all jobs |

For example: `workflow_dispatch(repo="lirtual/mcp-workers", workflow="ci.yml", ref="main", inputs={"worker":"remote-control-mcp-worker"})`. Only when that repository is accessible to a configured PAT with the required GitHub Actions permission can GitHub accept the dispatch.

Cancellation and dispatch acknowledgements are **not** completed-run evidence; verify using `run_get`. Force cancellation may bypass cleanup. No raw logs or artifact downloads are exposed.

## Local checks

Run from the monorepo root:

```bash
pnpm install --frozen-lockfile
pnpm --filter github-actions-mcp-worker check
```

These checks are synthetic; they do not call the user's actual GitHub Actions or change live devices.
