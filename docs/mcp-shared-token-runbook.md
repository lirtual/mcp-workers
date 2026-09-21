# Shared MCP entry token: operator runbook

This runbook covers the seven core MCP Workers that authenticate MCP/Portal callers with the runtime Secret **name** `MCP_ACCESS_TOKEN`. For this single-user deployment the **value** is intentionally the same across those Workers. The name is not an alias, not an upstream credential, and not a webhook/admin/executor/R2 credential.

Live Secret values are **not** read, written, printed, or compared by this repository. Matching names do not prove matching values.

## Scope

| Worker | MCP entry Secret | Independent credentials (do not share with MCP entry) |
| --- | --- | --- |
| `ima-mcp-worker` | `MCP_ACCESS_TOKEN` | `API_KEY`, `CLIENT_ID` |
| `openlist-mcp-worker` | `MCP_ACCESS_TOKEN` | `OPENLIST_TOKEN` |
| `weread-mcp-worker` | `MCP_ACCESS_TOKEN` | `WEREAD_API_KEY` |
| `database-mcp-worker` | `MCP_ACCESS_TOKEN` | `DATABASE_CONFIG` |
| `raindrop-mcp-worker` | `MCP_ACCESS_TOKEN` | `RAINDROP_ACCESS_TOKEN` |
| `instapaper-mcp-worker` | `MCP_ACCESS_TOKEN` | Instapaper consumer and OAuth Secrets |
| `workflow-mcp-worker` | `MCP_ACCESS_TOKEN` | `EXECUTOR_LEASE_SECRET`, `GITHUB_ACTIONS_TOKEN`, R2 signing pair, per-trigger webhook Secrets |

Rotating the shared MCP value changes access to **all seven** Workers and every MCP client/Portal connection that presents it.

## Trust boundary

- Shared value: MCP caller / Portal entry only.
- Separate: Workflow admin, GitHub executor, real webhook admission, executor leases, Worker→GitHub, R2, and each app's upstream API.
- Do not install CI `github.token` as `GITHUB_ACTIONS_TOKEN`.
- Do not use `MCP_ACCESS_TOKEN` as a webhook or connection secret.

## Preflight (presence only)

Record **names and presence**, never values:

1. Confirm each Worker still lists `MCP_ACCESS_TOKEN` in `secrets.required`.
2. Confirm each MCP Portal/client connection that should keep working is inventoried.
3. Confirm independent upstream/platform Secrets are present and are **not** the MCP token.
4. For Workflow: note nonterminal runs, scheduler Cron, and that ordinary deploys must not synthesize replacement MCP/lease/GitHub/R2 credentials.
5. Choose a strong replacement value in an operator-controlled secret store. Do not commit it, log it, or paste it into GitHub issues.

Stop before any mutation if a required Secret is missing. Do not generate an emergency fallback.

## Non-atomic cutover

Worker Secret updates are independent. Expect a short mismatch window.

1. Install the chosen value on each of the seven Workers (Cloudflare Runtime Secret `MCP_ACCESS_TOKEN`).
2. Update MCP Portal/client connections to the same value.
3. For each Worker: authenticated tool discovery succeeds; unauthenticated `/mcp` is rejected; `/health` stays public.
4. Keep the previous value in the operator recovery store until all seven and all clients are verified.

## Verification (no values in evidence)

Evidence may include Worker name, timestamp, HTTP status, tool-discovery success/failure, and “token present: yes/no”. It must not include tokens, hashes of tokens, presigned URLs, or lease material.

## Rollback

If any Worker or client fails verification, stop further mutations. Restore the previous per-Worker MCP value and the previous client configuration through an authorized coordinated operation. Do not rotate `EXECUTOR_LEASE_SECRET` while claims may still be in flight.

## Ordinary vs full acceptance

- Ordinary Workflow release: health plus unauthenticated MCP denial. No production MCP token in CI.
- Full GitHub/R2/OIDC tracer: separately invoked (`full_acceptance` on the deploy workflow) with a test-context credential. It is not a second Worker runtime Secret.
