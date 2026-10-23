# Shared MCP entry token: operator runbook

The three maintained MCP Workers authenticate MCP/Portal callers with runtime Secret name `MCP_ACCESS_TOKEN`. In this single-user deployment the **value** is intentionally shared; upstream application credentials remain separate.

| Worker | MCP entry Secret | Independent credentials |
| --- | --- | --- |
| `ima-mcp-worker` | `MCP_ACCESS_TOKEN` | `IMA_API_KEY` (Secret), `IMA_CLIENT_ID` (Variable) |
| `database-mcp-worker` | `MCP_ACCESS_TOKEN` | `DATABASE_CONFIG` |
| `raindrop-mcp-worker` | `MCP_ACCESS_TOKEN` | `RAINDROP_ACCESS_TOKEN` |

Live Secret values must never be read, written, printed, or compared by the repository. Matching Secret names do not prove matching values.

## Rotation and verification

1. Inventory the three deployed Workers and their MCP Portal/client connections.
2. Confirm required Secret **names and presence only**. Preserve independent upstream credentials.
3. Generate a replacement in an operator-controlled secret store; never store it in Git or issue comments.
4. Apply the shared entry-token value to each Worker and update every affected client. This cutover is non-atomic.
5. Verify authorized MCP discovery, unauthorized `/mcp` denial, and the public health endpoint for each deployed Worker.
6. If verification fails, stop and restore the previous per-Worker value and client configuration.

A source-tree deletion does **not** remove a Cloudflare Worker, rotate its Secret, or disconnect an existing MCP Portal client. Decommissioning a live Worker is a separately authorized operation.
