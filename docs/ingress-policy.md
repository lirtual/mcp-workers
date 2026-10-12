# MCP Worker ingress policy

This is the ingress policy for the three MCP Workers maintained in this repository.

## Unified policy

Each MCP Worker uses its Cloudflare `workers.dev` origin:

- `workers_dev: true`
- `preview_urls: false`
- no custom domain or zone route for MCP ingress
- the MCP Portal points to the Worker's `workers.dev` `/mcp` endpoint
- each Worker binds the runtime Secret named `MCP_ACCESS_TOKEN`

The Cloudflare account workers.dev subdomain is `aiyaya.workers.dev`.

## Target endpoints

| App | Worker | MCP origin |
| --- | --- | --- |
| IMA | `ima-mcp-worker` | `https://ima-mcp-worker.aiyaya.workers.dev/mcp` |
| Raindrop | `raindrop-mcp-worker` | `https://raindrop-mcp-worker.aiyaya.workers.dev/mcp` |
| Database | `database-mcp-worker` | `https://database-mcp-worker.aiyaya.workers.dev/mcp` |

An endpoint listed here is not evidence of a successful production deployment. Deployment, Portal discovery, representative safe tool execution, and logs must be verified separately.

## Cutover rule

When replacing another publisher, deploy, verify health and fail-closed MCP authorization, update MCP Portal, verify a safe call and logs, then retire the previous publisher. Do not keep two active production publishers for the same Worker.
