# GitHub Actions MCP Worker

A separate Cloudflare Streamable HTTP MCP app to control GitHub Actions in explicitly approved repositories. It also supports an optional bridge to the existing Session Deck control plane for tsrv, tsvc and later session projects.

## Source of truth

GitHub owns workflows, run state, jobs, status and artifacts. Session Deck owns exclusive session startup, target discovery, input validation, readiness, Locator Artifacts and decryption of Sensitive Facts. This worker reuses those APIs rather than duplicating their application logic.

## Configuration

| Name | Type | Usage |
| --- | --- | --- |
| MCP_ACCESS_TOKEN | Required runtime Secret | Reuse the shared single-user MCP Portal bearer token |
| GITHUB_TOKEN | Required runtime Secret | Token for GitHub API (permitted repositories only) |
| GITHUB_REPOS | Wrangler variable | Comma-separated exact repository allowlist |
| SESSION_DECK_URL | Optional Wrangler variable | URL such as https://sd.lirtual.dpdns.org |
| SESSION_PASSWORD | Optional runtime Secret | Existing Session Deck password for authenticated API calls |

Default allowlist in wrangler.jsonc is autoactions/tsrv,autoactions/tsvc. GitHub fine-grained token or GitHub App installation token needs Actions Read & Write on those repos. The repository_dispatch endpoint additionally needs Contents Write permission. No credentials are checked into source control.

Missing Session Deck configuration disables only Session Deck tools; GitHub Actions operations remain functional. Do not add a user-provided target URL or bypass the allowlist.

## Tools

| Tool | Purpose |
| --- | --- |
| repositories_list | Show allowed repos |
| workflows_list | List workflow files and states |
| runs_list | Recent runs, optionally filtered |
| run_get | Run state and URL |
| run_jobs_list | Job and step status, not raw logs |
| run_artifacts_list | Run artifact metadata |
| workflow_dispatch | Trigger a workflow on an explicit ref |
| repository_dispatch | Emit a custom event on default branch |
| run_cancel | Cancel a specified run after confirm=true |
| run_rerun | Rerun all or failed jobs |
| session_targets_list | Session Deck targets and masked locators |
| session_target_get | Session state, optionally reveal sensitive facts |
| session_target_start | Start selected Session Deck target |
| session_target_stop | Stop selected Session Deck target after confirm=true |

Workflow dispatch examples:

- Repo: autoactions/tsrv; workflow: linux.yml; ref: main; inputs: {"access_profile":"mini","session_profile":"developer"}.
- Repo: autoactions/tsrv; workflow: windows.yml; ref: main; inputs: {"session_profile":"core","enable_wsl":"false"}.
- Repo: autoactions/tsvc; workflow: tsvc.yml; ref: main; inputs: {"service":"code-server"}.

For temporary sessions, prefer session_targets_list followed by session_target_start/stop; only Session Deck handles exclusive target admission and session readiness. An accepted GitHub dispatch does not prove that the runner is ready.

## Development

At monorepo root, install frozen workspace dependencies and run the app checks:

    pnpm install --frozen-lockfile
    pnpm --filter github-actions-mcp-worker check

For local testing:

    pnpm --filter github-actions-mcp-worker dev

The app uses only a stateless /mcp endpoint and a credential-free /health endpoint. Tool output is bounded; arbitrary GitHub logs and artifact ZIP payloads are intentionally not exposed. The bearer gate applies to all /mcp methods. Any supplied Origin must be allowlisted by the shared ingress package (current allowlist is empty, matching the other private Workers).

## Deployment boundary

This PR adds CI checks only. It does not add this app to the existing GitHub Actions production deployment selection, does not create production secrets or Portal connections, and does not publish a Cloudflare Worker.

After a separate deployment change and runtime configuration, the expected endpoint would be https://github-actions-mcp-worker.aiyaya.workers.dev/mcp. Do not treat it as live before deployment and authenticated testing.
