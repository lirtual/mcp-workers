# T16 — Manual Raindrop daily snapshot acceptance

`raindrop-daily-snapshot` is a single Cloudflare-local `mcp.call` using the
fixed `raindrop` Connection, endpoint
`https://raindrop-mcp-worker.aiyaya.workers.dev/mcp`, and read-only
`list_raindrops`. Its arguments are exactly:

```json
{"collectionId":0,"page":0,"perPage":20,"sort":"-created","skipCache":true}
```

There are no workflow inputs to select an arbitrary endpoint, secret, or
bookmark operation; the Connection's local Effective Operation Policy is
explicitly `read`.

## Authentication and live contract

The Raindrop Worker requires `Authorization: Bearer <MCP_ACCESS_TOKEN>`
at `/mcp` and separately uses its own `RAINDROP_ACCESS_TOKEN` to reach
Raindrop.io. The operator previously confirmed that the seven MCP Workers
already share the MCP ingress token. The Workflow caller therefore uses its
existing `MCP_ACCESS_TOKEN`; no new credential or rotation is needed for this
source-level contract. Actual token values cannot be inferred from Secret
names. Before acceptance, authenticate to the *live* Raindrop endpoint,
discover `list_raindrops`, verify its input and output schemas, and stop if
they disagree with the source. Do not log the token or bookmark contents.

Before deployment, an operator with an already-authorized ingress token can run
`pnpm --filter workflow-mcp-worker release:raindrop-discovery` with
`WORKFLOW_MCP_ACCESS_TOKEN` securely supplied. This command sends only an
authenticated, read-only `tools/list` to the **fixed** Raindrop endpoint.
It verifies the fixed input types and required structured bookmark fields,
failing on an incompatible or missing tool. It prints only the endpoint, tool,
time, and SHA-256 schema digest; it never invokes `tools/call`, changes
Secrets, fetches bookmarks, or deploys any Worker. Missing credentials or
HTTP/auth/schema errors are blockers, not successful empty responses. Record
the sanitized discovery evidence separately from the manual Run evidence.

## Manual acceptance, only after separately authorized deployment

1. Confirm #106/#123 release evidence and compatibility with nonterminal Runs.
   Do **not** change production Secrets or enable a business schedule.
2. Verify `workflow_list` and `workflow_get` expose the same
   `raindrop-daily-snapshot` definition digest, manual and schedule triggers,
   and only the `mcp.call` capability.
3. Submit an authenticated `workflow_run` with
   `{"workflow":"raindrop-daily-snapshot","input":{}}`, then poll
   `workflow_status`. A succeeded Run exposes
   `workflow_result.outputs.bookmarks` as 0–20 structured records and
   `outputs.count` as the upstream total (not necessarily the page length).
   An empty array is valid; tool, schema, authorization, and network errors
   must be observable failures, never a fabricated empty success.
4. Correlate the Run and definition digest with `workflow_logs`, and
   preserve sanitized result evidence. An operator may use
   `pnpm --filter workflow-mcp-worker release:raindrop-manual`
   with securely supplied `WORKFLOW_MCP_URL` and
   `WORKFLOW_MCP_ACCESS_TOKEN`. The verifier writes a JSON evidence file
   containing count and record hash, not bookmark URLs/titles or credentials.
   This verifier is **not** a default deploy probe.

The definition includes `0 9 * * *` in `Asia/Shanghai` and
`misfire: latest`. Its first actual scheduled occurrence and activation
belong to #108; T16 only verifies a real manual Run. Do not claim T16
production acceptance solely from source or fixtures.
