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

## One-MCP Access policy gate (MCP server registration)

A successful MCP server `sync`, `ready` status, and Portal attachment do
**not** prove that ChatGPT can securely authenticate to the server. Cloudflare
also creates an Access application (`type=mcp`) for each MCP server. Before
attaching a server to One-MCP, verify that its Access application has the same
two **reusable** policies, in the same order, as the trusted One-MCP
(`type=mcp_portal`) application:

1. `WORKFLOWS`: `non_identity` service-token selector (precedence 1).
2. `Default Allow Rule`: `allow` for the approved email selectors (precedence 2).

Verify reusable **policy IDs**, not just display names. Never add an
`Everyone`, bypass, or unrestricted Allow rule. Missing, ambiguous or
misordered policies and failed Access API reads are **release blockers**,
not an acceptable partial success. Do not print selector email addresses,
service tokens, or any upstream credentials.

The shared `register-mcp-portal-server.mjs` helper (currently used by
OpenList and HTTP) checks this invariant **before** Portal attachment.
Other independently implemented registration scripts must gain an equivalent
gate before their next onboarding; successful legacy operations are not proof
that those scripts already include this guard. The guard does **not** add or
modify policies automatically, because changes to Access grants require a
separate reviewed authorization. Re-run registration only after the
missing policies are explicitly configured and the exact gate passes.

After Portal and Access checks pass, perform actual ChatGPT tool discovery
and representative scoped read + out-of-scope denial tests. Log and report
each gate separately; do not call a service production-ready based on
Portal sync alone.
