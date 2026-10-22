# Browser MCP — current implementation and acceptance

Updated: 2026-10-22 · SPEC #152

## Scope and implementation

- Worker: [Draft PR #143](https://github.com/lirtual/mcp-workers/pull/143), source commit `03114f4`. Agent: [Draft PR #20](https://github.com/lirtual/remote-control-agent/pull/20), source commit `79dec253`.
- Existing paired-device MCP route and Owner Durable Object; no extra Worker, browser CLI, proxy, database, or generic script executor.
- **Isolated Preview only:** when `V2_OWNER` is bound, `DEVICE_COORDINATOR` is absent, `REMOTE_CONTROL_V2_PREVIEW_ONLY=true`, and owner Access identity/origin configuration is present, the MCP advertises and dispatches **10** tools: `browser_start`, `browser_status`, `browser_navigate`, `browser_snapshot`, `browser_close`, `browser_tabs`, `browser_click`, `browser_fill`, `browser_press_key`, `browser_select_option`.
- The legacy test switches `SPEC152_PREVIEW_BROWSER_TOOLS`, `BROWSER_APPROVAL_ENABLED`, and fixed `SPEC152_PREVIEW_BROWSER_DEVICE_ID` restriction have been removed. Tool availability depends on Preview identity and Access configuration, not these variables.
- **Production remains off:** `DEVICE_COORDINATOR` never advertises or dispatches browser tools through this Preview-only implementation. Do not interpret a successful Preview deployment as a production browser release.
- Existing MCP token, explicit paired `device_id`, signed Ed25519 Agent WebSocket, per-operation durable IDs, bounded reads, and fail-closed uncertain receipt semantics remain in force.
- The Worker requires one-use owner approval via Cloudflare Access JWT + CSRF for `browser_click`, `browser_fill`, `browser_press_key`, and `browser_select_option`, tied to the exact operation. The `browser_fill` approval display hides entered form text while binding its SHA-256 parameters digest; a changed value needs new approval. Approval of a device is **not** approval of an individual website action.
- **Risk boundary:** `browser_navigate` and tab changes can have external effects and do not receive the same separate owner-approval prompt in the current implementation. Initial URL screening and Playwright route checks do **not** establish DNS/redirect/LAN/loopback SSRF isolation. The owner accepted this residual network risk for a personal device, not unrestricted consequential website actions. Keep production disabled until the remaining acceptance and action-authorization scope are resolved.
- Agent candidate uses one managed Playwright browser session with an independent Profile, headed Windows Edge/Chrome chosen from agreeing HTTP and HTTPS defaults, explicit selected tabs, versioned semantic snapshots and rejection of stale targets. Never attach to a personal browser Profile or claim a complete human-handoff/resume implementation.

## Verified evidence

- Worker application and database CI passed at `03114f4`; source/fixture approval tests passed. Actual phone Cloudflare Access approval succeeded for an exact operation sent to a **simulated** signed Agent, which recorded exactly one effect and acknowledgement. Live cloud replay rejection was not confirmed; local single-use enforcement tests passed.
- Actual Windows desktop, Agent `79dec253`: produced unpublished native preview package `v0.0.4-spec152`; manifest verified **34/34** files against pinned hashes, including Playwright 1.64.1.
- **Real headed Edge, native/local only:** opened a disposable private Profile, navigated the public Playwright TodoMVC test page, read semantic snapshot, filled a role/name target, pressed Enter, verified the result and closed successfully (exit 0).
- A second real Edge test opened/selected/closed multiple tabs and proved stale-snapshot rejection after switching tabs (exit 0). Both tests left zero test-profile Edge processes and cleaned their temporary Profiles. Installed Windows RCA was unchanged.

## Open release blockers

1. **Not yet verified:** one continuous, owner-approved, signed `MCP tools/call → Worker Durable Object → Ed25519 WebSocket → actual Windows Agent → real browser` E2E operation with receipts, replay rejection, revocation and cleanup. An earlier disposable pairing approval request was blocked by the execution environment's security review. Do not reroute, re-create substitute credentials, or infer success from separate native and mock tests.
2. **GitGuardian:** one suspected secret was reported across the Worker PR history; GitHub checks expose no finding path/type. Inspect the actual GitGuardian alert and remediate/rotate if genuine before merging. Never expose a secret in evidence or comments.
3. **Release not authorized:** both browser PRs remain Draft. No production Worker activation, browser Agent release, installed-Agent upgrade, or merged PR is implied. Human takeover/resume and remaining desktop lifecycle behaviors require separate verification.

The previous stage-by-stage design and risk discussions remain available in Git history and the [architecture review](https://github.com/lirtual/mcp-workers/pull/117). This file is the concise current-state contract, not a chronological transcript.
