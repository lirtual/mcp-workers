# Browser automation P0 feasibility research — owner confirmation and network egress

**Research date:** 2026-10-20  
**Status:** source/specification review only; **no live client or browser traffic acceptance performed**, no implementation decision, no deployment authorization.  
**Method:** Matt Skills `research` using the project's existing code and primary OpenAI/MCP/Playwright references. This is **one technical research note**, not an ADR, product decision (Q53), implementation Ticket or replacement for the [Q1–Q52 accepted design](./BROWSER-AUTOMATION-DESIGN.md).

## A. Owner confirmation: capabilities, actual runtime gap, and the minimum useful proof

### Primary-source findings

1. **ChatGPT/plugin approval exists at the host layer.** OpenAI plugin references explain that approval-gated tool arguments are released to a UI widget after host approval. OpenAI's MCP Responses API describes individual `mcp_approval_request` and `mcp_approval_response` items. **Neither published example establishes an authenticated, action-specific human-approval attestation that the current Remote Control Worker receives and can pass to the Agent.** Host execution-gating is a valuable safeguard; it must not be silently equated to the stronger verification required by accepted Q23/Q27/Q38/Q51. [ChatGPT plugin reference](https://developers.openai.com/plugins/reference); [OpenAI MCP tool approval](https://developers.openai.com/api/docs/guides/tools-connectors-mcp).
2. **MCP elicitation is conditional on client capability.** MCP 2025-11-25 allows `elicitation/create` only when the client advertised an elicitation capability; form responses can report `action: "accept"`, but the protocol does **not** itself establish a cryptographic guarantee of human identity/presence. The URL form is for out-of-band sensitive information/third-party authorization; it is not an automatically required or approved local browser-operation approval portal. [MCP elicitation spec](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation).
3. **Tool hints are not an authority boundary.** `readOnlyHint`, `destructiveHint`, and `openWorldHint` help ChatGPT show risk/approval but cannot replace MCP server checks; browser navigation to arbitrary public webpages is open-world. [OpenAI plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines); [OpenAI tool definition guidance](https://developers.openai.com/plugins/plan/tools).
4. **Current project code has no evidenced human-action approval protocol.** [Worker `worker.ts`](https://github.com/lirtual/mcp-workers/blob/main/apps/remote-control-mcp-worker/src/worker.ts) advertises `capabilities: { tools: ... }` at `initialize`, handles `tools/list`/`tools/call`, and uses authenticated portal + exact device routing. The [DO dispatch code](https://github.com/lirtual/mcp-workers/blob/main/apps/remote-control-mcp-worker/src/v2-pairing.ts) and [Agent WSS parser](https://github.com/lirtual/remote-control-agent/blob/main/apps/remote-control-agent/src/v2-connection-lifecycle.ts) accept an allowlisted operation name, arguments, request/operation ID; they do not provide an existing browser `proposed_action`/verified-human-consent handshake. [Agent receipts](https://github.com/lirtual/remote-control-agent/blob/main/apps/remote-control-agent/src/operations.ts) persist operation identity/status, **not** an independent proof of the owner's approval. This is an observation about the inspected source, **not** proof that a particular hosted ChatGPT client can never implement a suitable flow.

### Minimal end-to-end acceptance proof — not executed

The first question to test on the **actual connected ChatGPT plugin**, before implementing any high-impact action, is **what evidence arrives at the Worker/Agent after a real user approval and whether an Agent can verify the approved action is exactly the action dispatched**:

| Case | Expected evidence/outcome |
| --- | --- |
| Capability discovery | Record whether this exact ChatGPT/MCP client supports server-to-client elicitation or exposes a verifiable, authenticated tool-confirmation envelope to the Worker. API Responses approval items and ChatGPT widget notifications must not be assumed interchangeable |
| Positive (safe synthetic consequential action) | Owner sees complete device/session/tab/action/material args and explicitly approves. Execution boundary verifies binding for **one** synthetic invocation; no real payment, deletion, upload or external send |
| Negative: deny/missing | Decline, missing approval, unsupported client, or unverifiable user origin ⇒ **deny**, never fall back to model recollection or bearer token |
| Negative: tamper/replay | Changed tab/target/arguments, expired approval, reused token, concurrent requests, lost response and reconnect ⇒ reject changed/replayed invocation; consult existing Agent receipt, do not replay effects |
| Audit & data minimization | Only safe intent identifiers, outcome and non-sensitive evidence are retained; no chat transcript, raw page content or bearer secrets in logs |

**Current evidence status:** unverified. Until a live supported-client-to-Agent path meets the accepted Q27/Q38 requirement, **all genuinely high-impact browser effects remain disabled**. Ordinary low-impact browser tools could have a separate acceptance gate if genuinely proven safe under Q36/Q37/Q41. We **do not** approve a new approval portal, custom human-authentication service, a numeric approval TTL, or an unverified synthetic “approval token” as a workaround. If the required proof is impossible with the current client, that is a **product feasibility limitation requiring owner review**, not permission to weaken Q27 or silently build more infrastructure.

## B. Browser network boundary: documented gaps and minimum useful proof

### Primary-source findings

1. [Playwright Network](https://playwright.dev/docs/network#redirects) explicitly says ordinary request-route handlers are called **once on the original URL** of a redirect chain, not for every redirect hop. Therefore Q49's effective-destination validation **cannot be claimed satisfied by a single initial `browserContext.route()` callback**.
2. [Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext#browser-context-route) says ordinary routing does not intercept requests handled by Service Workers and recommends `serviceWorkers: "block"` for reliable routing; [Playwright Service Workers](https://playwright.dev/docs/service-workers) documents additional request-routing limitations. A dedicated *persistent* Profile can retain browser state, so verify old service-worker behavior as well as registration blocking when upgrading an existing Profile.
3. [Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context) supports `launchPersistentContext` with `serviceWorkers: "block"`; the setting is a useful *candidate*, not proof of a comprehensive network sandbox. [Playwright BrowserContext routeWebSocket](https://playwright.dev/docs/api/class-browsercontext#browser-context-route-web-socket) provides separate WebSocket interception, but HTTP routing alone cannot be presumed to cover all socket protocols or external browser process traffic.
4. [Remote Control Agent](https://github.com/lirtual/remote-control-agent/tree/main/apps/remote-control-agent/src) currently runs under the target OS account and exposes file/process operations. No browser-process-restricted outbound network boundary was identified in the inspected browser-less Agent source. An OS account being permitted to access local or metadata endpoints does **not** make every browser-origin request safe.

### Minimal falsifiable acceptance matrix — not executed

Use harmless, controlled local/test endpoints (including **simulated** metadata endpoints and a private test address; **never** access real cloud metadata secrets) to verify **effective outbound destination** denial:

| Case | Expected behavior |
| --- | --- |
| HTTP(S) direct | Ordinary approved public endpoint works; loopback, link-local, private/sensitive/admin/metadata target is denied unless separately authorized under Q45 |
| Redirect chain | Public URL → private/simulated metadata hop and multiple chained redirects are denied **before** the sensitive destination receives a request |
| Resolution and rebinding | Domain that changes resolved address from public to local/sensitive remains denied; no DNS check/use timing gap silently grants access |
| Subresources | Page-loaded images/scripts, XHR/fetch, iframe and prefetch to a sensitive address are denied rather than bypassing top-level navigation checks |
| Service Worker & persistent Profile | Existing or newly registered service-worker-mediated requests cannot bypass the boundary; disabling workers must not be assumed sufficient without runtime test |
| WebSocket | `ws://`/`wss://` sensitive destination denied in line with network policy; separate route/coverage measured |
| DNS error/unsupported scheme/aborted session | Fail closed, with an unambiguous safe error. No access attempt goes through on uncertainty |
| Explicitly authorized internal site | Approved target is narrowly scoped and does not become a blanket bypass for its subresources, redirects or later destinations |

**Current evidence status:** unverified. First determine whether the *actual* Playwright/Chromium process can enforce all needed requests without a bypass. If it cannot, **do not** claim the policy works or quietly introduce a privileged proxy, OS firewall, container/network namespace, separate egress service or global site allowlist. Compare the least-invasive process/OS egress restriction with the requirement and return the genuine architecture/security trade-off to the owner for an explicit decision. Navigation/open-world tools must remain disabled wherever this boundary is required but unproven.

## C. No overengineering / relationship to existing accepted design

- **Keep:** existing Worker/DO/WSS, paired device ID, Agent-local operation receipts, local file tools, isolated persistent Playwright Profile, a curated atomic browser tool inventory, and independently accepted Linux/WSL2/native Windows targets.
- **Don't add without evidence and later owner approval:** independent Browser MCP Worker, public CDP, generic JavaScript executor, custom approval portal, browser-specific authorization database, download file-manager service, R2 media store or new distributed transaction coordinator.
- **Not included in this P0 proof:** screenshot image round-trip within bounded Agent→DO→MCP messages; safe upload destination authorization; real Chromium artifact provenance; full browser user-flow and platform acceptance. These remain the separate documented P1/evidence gates in the design doc.
- **One critical boundary:** A browser tool being *defined* or *advertised* is not the same as a browser action being *accepted, enabled or owner-authorized*.

**Next appropriate step:** a **separately scoped non-destructive real-client and isolated test-browser acceptance session**, only after its proposed device/environment, synthetic test endpoints and scope have been approved. Completing this document does **not** perform those tests or grant permission to implement, deploy, merge or create Tickets.


## D. Non-destructive feasibility observations — same-session local probe (2026-10-20)

**Environment boundary:** The following checks used a **separate ephemeral local sandbox**, not either real Remote Control device, the project repository, Cloudflare Worker, or production. No project code was changed; no remote Shell, CI or deployment was run. This is **not** a platform/browser acceptance test.

| Check | Observed result | What it proves / does not prove |
| --- | --- | --- |
| Connected MCP tool discovery | The connected Remote Control plugin exposes paired-device/file/process tools, **not** any browser automation or verifiable one-use owner-confirmation test tool. Read-only `list_devices` reported **two online devices with identical display names**. | The plugin is reachable for read-only discovery. It provides no supported way to test browser approval, and ambiguous labels must not select a device implicitly. No device commands were issued |
| Sandbox Chromium startup | The local sandbox's installed Playwright Python package launched `/usr/bin/chromium` headlessly. | A local browser executable runs in this sandbox. **Not** evidence of the remote Linux, WSL2 or native Windows Agent browser, provenance, or version-match acceptance |
| Controlled direct sensitive HTTP URL | Navigating Chromium to a **synthetic** `127.0.0.1` local test endpoint returned `net::ERR_BLOCKED_BY_ADMINISTRATOR`. The browser route callback saw **zero** requests and the local server saw **zero** requests. | This sandbox already enforces a separate administrator/network restriction before the Playwright route can be meaningfully tested. It does **not** prove our Q45/Q49 policy or confirm Agent egress safety |
| Controlled redirect to sensitive URL | The initial `127.0.0.1` test URL returned the same browser administrator block; route callback and local server again saw **zero** requests. | **Inconclusive** for redirect per-hop routing/bypass: the browser could not reach the initial test endpoint. Do **not** claim PASS or FAIL for project network interception |
| Offline screenshot | A new synthetic HTML page rendered without network requests. Result: **PNG 12,063 bytes** and **JPEG (quality 65, CSS scale) 10,553 bytes**. | Screenshot generation/compression works in this sandbox for a **tiny** page. This is not a realistic-image-size benchmark and does **not** test WSS/DO/MCP image delivery, which has different framing and existing message bounds |

The local synthetic probe had no interaction with real metadata services, real user sites, any credentials, or remote devices. Do **not** disable the sandbox's browser security just to make a test pass. If a true redirect/egress test is authorized later, run it only in a **separately identified isolated target** with controlled local HTTP endpoints and explicit permission for that environment.

### E. Additional actual transport constraint: existing read call timeout

The [current Durable Object dispatch](https://github.com/lirtual/mcp-workers/blob/main/apps/remote-control-mcp-worker/src/v2-pairing.ts) uses a **5,000 ms** per-read/operation response timeout; [the Agent socket handler](https://github.com/lirtual/remote-control-agent/blob/main/apps/remote-control-agent/src/v2-connection-lifecycle.ts) validates bounded JSON/text frames and returns bounded read text. Browser navigation/screenshot work could naturally exceed five seconds, so **simply renaming a file read tool into a browser tool is not evidence it will work**.

At later interface design time, prefer the *existing* stable Operation ID/local Receipt and explicit status-query pattern for uncertain or genuinely long-running browser effects, and define timeouts/cancellation for safe reads. **Do not** blindly increase every timeout, replay an effectful action after `timeout_unknown`, or create a second workflow/execution service without evidence. This is a source-grounded implementation issue, not a new owner-approved design choice.

**Status after local probe:** P0 owner approval **BLOCKED / untestable with available plugin tools**; P0 browser network interception **INCONCLUSIVE due to sandbox administrator policy**; remote-device/platform acceptance **NOT RUN**. A result remains **unverified** until run in the actual supported client and approved isolated browser environment.
