# GitHub Actions MCP context

This bounded context owns an independently deployed, stateless MCP ingress that calls **only GitHub REST API** endpoints for GitHub Actions. It never calls Session Deck or any other management API. GitHub is the source of truth for workflows, runs, jobs and artifacts; `tsrv` and `tsvc` require no special adapter.

Runtime inputs are `MCP_ACCESS_TOKEN`, primary `GH_TOKEN` and `GITHUB_REPOS`, plus optional second-account `GH_TOKEN_SECONDARY` and `GITHUB_REPOS_SECONDARY`. Each repository is assigned to exactly one token; unknown or overlapping repository-to-credential assignments fail closed, and upstream auth failures never trigger cross-account fallback. Existing one-account deployments remain compatible. No database, queue, background state, session password, cloud executor, D1, R2 or Durable Object is introduced.

MCP tool boundaries: allowlisted workflow/run discovery, metadata-only job/artifact reads, explicit-ref workflow dispatch, repository dispatch, individual run cancellation with force-cancel escalation, and reruns. Upstream acceptance does not prove a run started, a cancellation completed, or a run finished. A `run_cancel` or `run_force_cancel` receipt is only a request acknowledgment; inspect `run_get` for final state. Force cancel is reserved for runs unresponsive to normal cancellation because it may bypass `always()` cleanup. For runner address or session readiness, this MCP does not interpret artifacts; that remains outside this generic Actions manager.

Never log upstream bodies, tokens, or repository private data. Production deployment is a separate approval step.
