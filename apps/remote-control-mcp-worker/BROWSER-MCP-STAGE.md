# Remote Control browser MCP — paired-device authorization

Updated: 2026-10-23

## Decision and scope

A device is approved **once** through the existing ten-character pairing code and authenticated
`pairing_lookup` → `pairing_approve` workflow. After the Agent proves possession of its
Ed25519 key, browser commands use the ordinary Portal-authenticated MCP → Owner Durable Object
→ signed WSS → Agent operation path. Browser navigation, clicking, filling, pressing keys,
and selecting options **do not require a separate Cloudflare Access webpage**.

This simplification changes the browser consent policy, not device enrollment or the
Agent execution protocol. The following safeguards remain:

- Explicit `device_id` on each MCP call; current server-side permanent/temporary grant check;
  expiration/revocation enforcement; fresh signed WSS session/epoch.
- Typed browser arguments, URL first-hop hygiene, tab identity and fresh snapshot checks
  where required, bounded observations and managed independent browser Profile.
- Durable `operation_id` receipts, failure/unknown-result handling and no blind replay.
  The Agent's existing OS rights and browser isolation limits do not change.
- Preview and production use their own owner DO namespaces. No extra browser approval
  configuration, feature switch, identity store, scheduler or service is introduced.

Temporary grants still expire 24 hours after approval. Changing an *existing temporary
grant into a permanent grant* is a distinct increase in device privilege and continues
to require the existing independently Cloudflare Access-verified owner page at
`/browser-approve/grant/<device_id>`. Permanent onboarding requires no such promotion.

## Security trade-off

An authenticated MCP actor can now initiate a browser action on an approved device
without another human approval. The earlier one-use website-action authorization is
removed, including its dispatch/inspect/approve endpoints and pending intent storage.
This increases the impact of a stolen MCP credential, a compromised client, or prompt
injection that causes the assistant to invoke browser tools.

**There is no proven DNS/redirect/private-network/SSRF isolation.** First-hop screening
and Playwright route checks must never be presented as comprehensive isolation. Use only
the owner's trusted personal Windows device; do not claim safe unrestricted browsing.
Retain revocation, grants, Agent boundaries and conservative tool handling of untrusted
page content.

## Implementation and validation

- Worker browser tools: `browser_start`, `browser_status`, `browser_navigate`,
  `browser_snapshot`, `browser_close`, `browser_tabs`, `browser_click`,
  `browser_fill`, `browser_press_key`, `browser_select_option`.
- [PR #192](https://github.com/lirtual/mcp-workers/pull/192) merged into `main`
  at `223222bea9c7e22edcd56a39ebf236b417f861c0`. Main CI
  [#39910085749](https://github.com/lirtual/mcp-workers/actions/runs/39910085749) passed.
- Manual GitHub Actions release
  [#39910167712](https://github.com/lirtual/mcp-workers/actions/runs/39910167712)
  deployed exactly `remote-control-mcp-worker`. Cloudflare confirmed
  active Version `e54022e2-b8f4-48f9-8c62-972a3ec04452` at **100%**,
  without resetting the existing paired-device Durable Object.
- A real already-paired Windows Agent `v0.1.13-windows.1` completed
  `browser_start` → `browser_status`/`browser_tabs` →
  `browser_navigate` (example.com, then Playwright TodoMVC) →
  `browser_fill` → `browser_press_key` (Enter) → `browser_click`
  (complete and clear disposable todo) → `browser_close`.
  Operation receipts confirmed each effect; no separate webpage approval was
  requested. The disposable test item was removed and final
  `browser_status` returned `null`.
- The initial headed-browser launch exceeded the Worker’s five-second
  response window and reported `timeout_unknown`; querying the **same**
  `operation_id` confirmed completed, avoiding unsafe duplicate dispatch.
  This timeout behavior is a known latency limitation, not a failed operation.
- Cloudflare MCP Portal server `remote-control` re-synced successfully
  (`ready`, 33 tools) with updated browser descriptions on
  2026-10-23 06:23 UTC. Existing ChatGPT sessions may retain their
  cached tool descriptions until the connection refreshes.
- Safety bounds are unchanged: browser redirects/DNS/private-network SSRF
  isolation remain unproven; this acceptance is for the personal approved
  Windows device, not a guarantee of arbitrary site/network safety.

## Previous acceptance (historical)

Spec [#152](https://github.com/lirtual/mcp-workers/issues/152) records the earlier
approved-browser-operation E2E, Worker [PR #143](https://github.com/lirtual/mcp-workers/pull/143)
and its published release. Agent [PR #20](https://github.com/lirtual/remote-control-agent/pull/20)
is independently tracked. Those earlier results show the browser transport and receipt
path, not this new one-time device-authorization policy.
