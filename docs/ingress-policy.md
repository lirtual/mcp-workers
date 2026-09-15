# MCP Worker ingress policy

This document is the current post-migration ingress policy for the six MCP Worker apps. It supersedes the Phase B migration rule that preserved pre-migration runtime addresses while source snapshots were being moved.

## Unified policy

Every MCP Worker uses its Cloudflare `workers.dev` origin as the production Worker endpoint:

- `workers_dev: true`
- `preview_urls: false`
- no custom domain or zone route for MCP ingress
- Cloudflare MCP Portal points to the Worker's `workers.dev` `/mcp` endpoint
- each Worker keeps its own `MCP_ACCESS_TOKEN`

The Cloudflare account workers.dev subdomain is `aiyaya.workers.dev`.

## Target endpoints

| App | Worker | MCP origin |
| --- | --- | --- |
| WeRead | `weread-mcp-worker` | `https://weread-mcp-worker.aiyaya.workers.dev/mcp` |
| IMA | `ima-mcp-worker` | `https://ima-mcp-worker.aiyaya.workers.dev/mcp` |
| Raindrop | `raindrop-mcp-worker` | `https://raindrop-mcp-worker.aiyaya.workers.dev/mcp` |
| OpenList | `openlist-mcp-worker` | `https://openlist-mcp-worker.aiyaya.workers.dev/mcp` |
| Instapaper | `instapaper-mcp-worker` | `https://instapaper-mcp-worker.aiyaya.workers.dev/mcp` |
| Database | `database-mcp-worker` | `https://database-mcp-worker.aiyaya.workers.dev/mcp` |

An app that is not currently deployed is not considered production-ready merely because its target endpoint is defined here. Deployment, Portal discovery, representative safe tool execution, and logs must still be verified before final acceptance.

## Cutover rule

When replacing a previous custom-domain, tunnel, or old-repository publisher:

1. deploy the monorepo Worker with `workers_dev: true` and `preview_urls: false`;
2. verify `/health` and fail-closed `/mcp` behavior on the workers.dev origin;
3. point MCP Portal to the workers.dev `/mcp` endpoint;
4. verify tool discovery and a representative safe call;
5. inspect logs for secret leakage;
6. only then remove the old custom-domain/route/tunnel publisher and retire the old repository publisher.

Do not keep two active production publishers for the same Worker.
