# MCP Worker ingress policy

This records the maintained Wrangler ingress configuration, **not** proof of deployment or the exact One-MCP Portal inventory. The actual Cloudflare deployment and Portal registration must be verified independently.

## Ingress contract

- All maintained Workers use runtime Secret name `MCP_ACCESS_TOKEN` for MCP entry authentication. Upstream credentials remain separate.
- All have `preview_urls: false`.
- `workers_dev` is **not uniform**: Workflow and Weixin have `workers_dev: false`; Remote Control declares both `workers_dev: true` and the `rca.lirtual.dpdns.org` custom domain.
- The `workers.dev` subdomain is `aiyaya.workers.dev` for Workers where enabled.

## Configured MCP ingress endpoints

| App | Worker | Wrangler route | Configured MCP URL |
| --- | --- | --- | --- |
| IMA | `ima-mcp-worker` | workers.dev | `https://ima-mcp-worker.aiyaya.workers.dev/mcp` |
| Raindrop | `raindrop-mcp-worker` | workers.dev | `https://raindrop-mcp-worker.aiyaya.workers.dev/mcp` |
| Database | `database-mcp-worker` | workers.dev | `https://database-mcp-worker.aiyaya.workers.dev/mcp` |
| SSH | `ssh-mcp-worker` | workers.dev | `https://ssh-mcp-worker.aiyaya.workers.dev/mcp` |
| GitHub Actions | `github-actions-mcp-worker` | workers.dev | `https://github-actions-mcp-worker.aiyaya.workers.dev/mcp` |
| HTTP | `http-mcp-worker` | workers.dev | `https://http-mcp-worker.aiyaya.workers.dev/mcp` |
| Remote Control | `remote-control-mcp-worker` | workers.dev + custom domain | `https://rca.lirtual.dpdns.org/mcp` |
| Workflow | `workflow-mcp-worker` | custom domain only | `https://workflow.lirtual.dpdns.org/mcp` |
| Weixin Action Provider | `weixin-mcp-worker` (existing physical Worker) | Access owner setup domain + internal Service Binding | No public MCP ingress; `weixin.lirtual.dpdns.org` is owner administration only |

These are configured ingress addresses, not evidence of a successful production release, a live Portal mapping or an authenticated ChatGPT tool call. Verify every release and actual Portal target independently.

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

The shared `register-mcp-portal-server.mjs` helper (used by OpenList
and HTTP) checks this invariant **before** Portal attachment. The existing
registration script for Workflow also invokes the same
read-only verifier before its Portal attachment steps. Other
new registration scripts must adopt this gate before their first onboarding. The guard does **not** add or
modify policies automatically, because changes to Access grants require a
separate reviewed authorization. Re-run registration only after the
missing policies are explicitly configured and the exact gate passes.

After Portal and Access checks pass, perform actual ChatGPT tool discovery
and representative scoped read + out-of-scope denial tests. Log and report
each gate separately; do not call a service production-ready based on
Portal sync alone.

Browser T8：`browser-mcp-worker` 使用独立 `MCP_ACCESS_TOKEN`（同名 GitHub Environment Secret，不沿用共享值），无额外 Variable。Manifest Key 是公开安装标识，不是 Secret。当前 `workers_dev: false`、`preview_urls: false` 且没有生产路由；现有手动 Release 的 Browser 预检将阻断发布。不得以本次接线创建资源、写 Portal/Access 或切换凭据；参见 [T8 发布与验收边界](../apps/browser-mcp-worker/docs/t8-release.md)。
