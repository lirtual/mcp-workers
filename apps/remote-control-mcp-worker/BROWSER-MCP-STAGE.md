# Browser MCP tools — inactive first-stage contract

## P13 latest acceptance ledger — code and runtime (2026-10-21)

**Source gate:** [Worker Draft PR #143](https://github.com/lirtual/mcp-workers/pull/143)
keeps `BROWSER_TOOLS_ACCEPTED = false`; no production browser tools are listed or
callable. The source-only [Agent Browser Draft PR #20](https://github.com/lirtual/remote-control-agent/pull/20)
depends on the [Windows full-tools Draft #13](https://github.com/lirtual/remote-control-agent/pull/13)
and [Windows native Draft #7](https://github.com/lirtual/remote-control-agent/pull/7).
On 2026-10-21, their branch heads `93cc40d`, `ff29a89`, and `57d3182`
were all GitHub CLEAN/MERGEABLE and passed Windows x64, Ubuntu x64 and ARM64
CI. All remain Draft; green CI is not approval to merge, release, install or
activate the browser tools.

**Passed independently:** A SHA-pinned portable native Windows Agent
started real Chrome, navigated the harmless public TodoMVC page, returned
semantic Snapshot, closed its isolated Profile, and recorded actual
`completed` SQLite start/navigation/close receipts with duplicate-ID
deduplication. Separately, an explicitly owner-approved 24-hour disposable
Ed25519 device connected over real signed WSS; an MCP read-only `stat_file`
reached that Windows Agent via the running production Owner DO. The
disposable identity was then revoked and removed; no installed Agent or
scheduled task was modified.

**Local-only test feasibility passed, browser positive path not passed:**
Existing `wrangler.v2-preview.jsonc` supported a separate loopback-only
Wrangler and local SQLite DO, with its own bearer token. A disposable source
copy listed the five browser tools and enforced a fixed TodoMVC navigation
target, bad-token rejection, and missing-device rejection. This was not a
production deploy or a signed browser operation. The most recent attempt to
recreate the local owner-authentication test was blocked by tool safety review;
the stopped loopback service, disposable key/token and local DO/worktree
were cleaned. Do not retry by a different credentialed endpoint, internal
DO call, or Shell-to-browser substitution.

**Still unpassed (P13):** a single genuine `browser_start → browser_navigate
→ browser_snapshot → browser_close` sequence over authorized MCP
`tools/call → DO → Ed25519 WSS → portable Windows Agent → Chrome`, with
operation receipts and cleanup verified *in that same run*. It requires a
supported owner-authenticated, non-production acceptance path and fresh
explicit consent for any new temporary pairing; earlier revoked identities
cannot be reused. Consequential/ambiguous navigation additionally requires
target-specific user approval, not merely device pairing.

**Native ChatGPT confirmation vs trusted execution:** ChatGPT app permission
settings can ask before a tool call, and `destructiveHint`/`openWorldHint`
communicate risk to the host. These are useful review UX, but an MCP tool
descriptor, a model-supplied `approved` field, device pairing, and ordinary
Portal authentication are **not** a server-verifiable, one-use authorization
for the exact URL and consequential effect. OpenAI's plugin reference and
MCP-server guidance explicitly require server-side authorization and do
not treat annotations as enforcement. Current Worker `initialize` does
not advertise an action-bound approval protocol; do not claim that plugin
permission preferences prove such a protocol was executed. First verify
a supported owner confirmation path independently; otherwise the browser
gate stays false. This requires no new approval service while disabled.

OpenAI references:
[Tool annotations and approvals](https://developers.openai.com/plugins/reference),
[Build an MCP server](https://developers.openai.com/plugins/build/mcp-server),
[App permission controls](https://developers.openai.com/plugins/changelog).

**Release hold:** No merge, release, installed-Agent upgrade, production
browser enablement, or Cloudflare deployment has been authorized. Reuse the
existing Worker, DO, and Agent; do not add proxies, approval databases,
or more simulated tests solely to bypass the remaining gate.

---

## P9 owner-accepted Windows Goal A, not network isolation (2026-10-21)

**Current authoritative scope (supersedes P4's strict-private-network activation condition only):** The owner has explicitly accepted the risk that pages and redirects executing within the personally paired native Windows Chrome can reach host loopback, LAN and internal destinations. **Do not present the existing first-hop / context filters as an SSRF sandbox or demand zero internal-server hits as Goal A release proof.** P5 observed `attempted=1`, `blocked=0`, `localHits=1` on redirect-to-local; it remains true and is classified **NOT ISOLATED / OWNER-ACCEPTED RISK**, not a PASS.

**Keep the actual tool gate disabled:** `BROWSER_TOOLS_ACCEPTED = false`, five staged tool names only. No direct private initial URL, unsupported scheme, arbitrary JS/CDP/CLI or custom Profile input is added; preserve all existing argument checks, owner-device binding and Agent-local no-replay receipts. An arbitrary `browser_navigate` must not be assumed read-only: consequential/ambiguous website effects remain blocked without real one-use action/target-bound user approval at the execution boundary. ChatGPT tool confirmation, client Elicitation capability, Portal auth and operation IDs must not be misreported as verified proof.

**Remaining acceptance:** (1) source-negative checks/disabled public MCP surface, (2) reuse P3/P5 disposable Windows Chrome Profile and signed DO/WSS *separate* evidence without conflating them with an end-to-end browser operation, (3) inspect actual client approval capability without enabling the production browser tools, (4) independently authorize one disposable full-path browser MCP test if and when confirmation and the test-only route can be enforced. No additional Worker, network proxy, firewall or confirmation service chosen. No merge, deployment, installation or production activation.

See [P9 architecture decision](https://github.com/lirtual/mcp-workers/blob/docs/browser-automation-grilling-20261020/docs/remote-control/BROWSER-ARCHITECTURE-REVIEW-20261020.md#p9-acceptance-reconciliation--trusted-windows-goal-a-2026-10-21).

---
This Draft adds only the explicit, minimal `browser_start`, `browser_status`, `browser_navigate`, `browser_snapshot`, `browser_close` schemas and compatible **existing** device owner Durable Object / WSS read and operation paths. There is no additional Worker, table, proxy, job system, generic command dispatcher or browser runtime here.

`BROWSER_TOOLS_ACCEPTED = false` is a source-level acceptance gate. All five browser tools are **excluded from public `tools/list` and fail public `tools/call`**, including for already paired devices, until a packaged Agent and platform-security acceptance explicitly justify enabling them. This is not a user-configurable additional deployment variable. The active Windows-first Agent implementation is staged in `lirtual/remote-control-agent` **Draft PR #20**. Earlier PRs #15/#19 are exploratory work, not the selected release path.

Staged tests check strict arguments, explicit `device_id` and effectful `operation_id`, no executable/Profile/JS/CDP passthrough and public deny-by-default. An isolated internal Durable Object ↔ signed Agent socket ↔ existing SQLite receipts fixture passed against the new Agent Draft code, but is **not** a live ChatGPT client/production plugin test and is not kept as a cross-repository CI dependency before the Agent candidate is integrated.

Do not claim `browser_navigate` read-only: even an HTTP GET or page subresource can have effects. The current CLI URL hygiene cannot guarantee redirect/DNS/private-network isolation. Consequential/ambiguous actions remain disallowed without genuinely verifiable owner approval. Native CLI packaging, 5-second reply reconciliation via original `get_operation_status`, crash/revocation cleanup and full Windows Agent-installed E2E must be proven before enabling the five tools. Historic MXC/WFP hostile-execution P0 remains deferred and unpassed.


## P4 initial-target contract review (2026-10-21)

**Keep disabled:** `BROWSER_TOOLS_ACCEPTED = false` remains unchanged. The five staged tool names are neither listed nor callable through the authenticated MCP boundary, including when a paired Device Coordinator is configured. No Worker deployment, Agent upgrade or new permission service is required to run this Draft's tests.

The typed `browser_navigate` parser now refuses local-looking **initial** HTTP(S) URLs at the owner/DO boundary, consistent with the already packaged Agent's first-hop validation: loopback and direct IPv4/IPv6 addresses (including canonicalized integer IPv4), `localhost`, `.localhost`, `.local`, `.internal`, single-label hosts, credentials, control characters, spaces and non-HTTP(S) schemes. It validates **before** the DO can admit a durable operation; an obvious bad initial target therefore cannot create an ambiguous browser operation receipt. Its positive public-host case and negative examples are covered by `browser-tools.test.ts`.

**This is not a complete SSRF boundary.** Public DNS names may resolve to private IPs, browsers may follow redirects to them, and pages may initiate separate subresource requests. The current browser profile can access the host's network and these paths have not been safely contained. A name/hostname check does **not** prove that DNS, redirects or subresources are restricted. Do not switch on navigation based solely on these tests. Also, a GET navigation may affect website state; no claim is made that `browser_navigate` is read-only.

**Reuse the existing permission and receipt chain:** Portal owner authentication, explicit device_id, signed Ed25519 WSS and device revocation, per-operation durable `operation_id`, and no automatic replay already cover the first-stage five-tool shape. No click, form-fill, scripting, download or upload tools are part of this stage. An additional general-purpose confirmation system, network proxy, Worker, database or all-platform browser installer is not justified just to keep a Draft disabled; consequential future browser actions must receive separate explicit user approval and verified enforcement before implementation.

**Verification:** scoped browser schema/denial tests 4/4 PASS and Worker TypeScript production+test compilation PASS with the independently staged Agent fixture. The broad Worker suite encountered one `v2 write_file` receipt test failure (`failed` rather than `running|completed`); **the exact same test also failed when the browser URL change was temporarily removed**, so do not attribute the failure to this P4 validation patch, but do not mark the full Worker suite green. The independent GitHub branch CI remains the acceptance gate for this Draft.

**Activation hold:** independently demonstrate a credible private-network/redirect/subresource policy appropriate to trusted owner-operated Windows Chrome, and verify the user approval story for navigation that may have side effects. Then explicitly authorize a disposable browser-MCP end-to-end test; do not bypass this source gate or use a locally altered Worker as a surrogate for approval. Installed Windows Agent and production Worker keep their current settings until a later separate release decision.

## P11 tool hint and protocol compatibility audit (2026-10-21)

Owner-selected Goal A accepts residual browser-to-loopback/LAN access for a personally paired Windows device; **it does not authorize consequential or unclassifiable website effects**. Native Chrome network isolation has not passed and must not be claimed.

- The five **disabled** tool descriptors now supply all three explicit OpenAI risk hints. `browser_navigate` is open-world, non-read-only, and potentially destructive because initial GETs/redirects can produce irreversible site effects. `browser_close` may lose unsaved browser state and is marked destructive; `browser_start` is a local non-read-only, non-destructive lifecycle operation; `browser_status` and `browser_snapshot` are read-only and non-destructive. None of these annotations constitutes verified permission or one-use consent.
- Local WSL isolated source check for `ca6f383`: **7/7** `browser-tools.test.ts` tests PASS, Worker production source TypeScript check PASS. The 2026-07-28 capability hint probe returns legacy `2025-11-25` and tools-only capabilities, so the newer input-required multi-round-trip elicitation channel is **not implemented here**.
- Only a real client ↔ disposable authenticated MCP connection can establish actual ChatGPT elicitation support. Even then, high-impact execution needs actor/device/session/operation/target-specific authorization and one-use enforcement verified at the Agent boundary. This has **not** been achieved. No new approval broker or MCP-version migration is approved.
- `BROWSER_TOOLS_ACCEPTED = false` remains unchanged; no browser tools are advertised or dispatched, no deployed/installed Agent has changed, and no source-only result is a production or signed browser-MCP end-to-end acceptance.
