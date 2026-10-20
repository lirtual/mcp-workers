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


## F. User-selected paired device readiness — read-only check (2026-10-20)

**Owner-selected target:** one exact existing Remote Control device ID supplied in the conversation. For privacy and to avoid publishing a durable identifier for a personal device in repository documentation, the full UUID and machine label are **intentionally omitted here**. A second paired device has the same name, and **must never** be substituted based on label matching.

**Tools used:** only the connected Remote Control `list_devices`, `read_file`, `list_directory`, `stat_file` and `list_sessions` **read-only** capabilities; no Shell/process start, filesystem write, network browsing or browser launch. These results reflect the point-in-time connected tool response, not a platform diagnosis.

| Probe | Observed result | Inference boundary |
| --- | --- | --- |
| Exact device identity and connectivity | The intended UUID is in the paired device list as `online`; another device has the same label | The device-selection target is unambiguous by ID, but list-level online status **does not prove its file capabilities or OS** |
| Linux version/WSL clues | Reads of `/etc/os-release`, `/proc/sys/kernel/osrelease`, `/etc/wsl.conf`, `/proc/1/comm` all returned the remote file-read-failed error | OS type, whether WSL2, Agent account visibility and runtime remain **unknown**; an absent optional WSL config alone would not have proven incompatibility |
| Binary-directory existence | Read-only directory listing for `/usr/bin` returned remote directory-listing failure | No evidence for or against Chromium, Chrome, Node, Playwright installation |
| Path availability independent of text reading | `stat_file` for `/`, `/home`, `/etc/os-release` returned remote file-info failure | Not merely a text-content issue, but the provider's generic `read_failed` mapping **does not distinguish** missing Linux path, unsupported platform, permissions or Agent read implementation |
| Managed session status | Read-only `list_sessions` returned a generic managed-session failure, with possible Shell/session support missing | This does **not** prove the device is offline or identify the platform |

**Relevant source interpretation:** [Worker error mapper](https://github.com/lirtual/mcp-workers/blob/main/apps/remote-control-mcp-worker/src/worker.ts) renders a generic “read failed / check path and permissions” message when the DO read result is `read_failed`; [Agent WSS code](https://github.com/lirtual/remote-control-agent/blob/main/apps/remote-control-agent/src/v2-connection-lifecycle.ts) implements bounded allowlisted read operations but has no dedicated OS/browser readiness tool. The observed response alone cannot establish whether this UUID refers to a native Windows Agent, WSL distro, Linux host with path restrictions, or an Agent-version mismatch.

**Readiness verdict: BLOCKED / unknown environment.** The chosen device is the **only** approved target for future inspection, but **is not yet qualified as an isolated browser-test target**. There is no permission to assume that a personal/work machine is disposable. No browser or network acceptance was attempted there. Do not retry many arbitrary paths, run a mutation-capable Shell just because a command would be read-only, alter the remote Agent or silently select the identically named sibling.

## G. Conditional controlled acceptance sequence — planned, NOT run

**Stage 0 — unblock OS and read-only capability discovery first.**

1. Identify the **exact selected device's** native OS / WSL2-vs-Linux runtime and whether its installed Agent supports the existing Linux path/file protocol, through an available trustworthy **read-only** platform-capability indication. The current `list_devices` only reports identity/connection, not OS/Agent version.
2. Confirm non-sensitive browser-runtime facts (Playwright/Chromium package/binary presence, executable version/architecture and a *separate* writable ephemeral profile location) **without launching a browser or modifying the host**. A file existing is not sufficient proof of safe test setup.
3. If the existing connected plugin has no read-only OS/capability surface—as this probe suggests—**stop and return that instrumentation/diagnostic gap for separately scoped owner approval**. Do not promote `run_command` to “read-only” merely because a proposed command contains only `uname` or `stat`.
4. Establish that the eventual test will run inside a genuinely **isolated** user-selected environment rather than the owner's personal browser Profile; record disposable-profile and cleanup boundaries. **No sandbox qualification was shown by this read-only check.**

**Stage 1 — controlled browser network-target test, only after Stage 0 and separate scoped test authorization.**

- **Environment:** a disposable independent browser Profile with an isolated synthetic HTTP origin, a second simulated private/admin target, and a test-controlled DNS/redirect fixture. Test harness should capture whether requests actually hit the sensitive fixture. It must not access real cloud-instance metadata, personal LAN services, credentials, production accounts or devices other than the selected test instance.
- **Cases:** direct approved public-simulated HTTP(S); ordinary public → private redirect; multi-hop redirects; host DNS public→sensitive change; iframe, XHR/fetch, image/script, WebSocket; existing/new Service Worker or prefetch; unsupported-scheme and DNS-failure denial. An explicitly approved internal target must not grant blanket subresource permission.
- **PASS:** forbidden targets receive **zero requests**, with safe fail-closed errors; permitted test origin is still usable. **INCONCLUSIVE:** test browser is blocked by sandbox policy before reaching its first controlled public fixture, or the harness cannot distinguish request paths. **FAIL:** any forbidden fixture receives an unauthorized request. A Playwright `route()` callback count alone is not sufficient proof of network protection.
- Any need for process-level egress isolation, a proxy or privileged sandbox **requires a future owner architecture decision** and must not be smuggled into a document-only test.

**Stage 2 — real-client one-use owner-authorization verification, independent of Stage 1 but requiring an actual verifiable client execution path.**

- **Environment:** the supported ChatGPT plugin connected to the exact selected approved device/runtime, using a **synthetic local high-impact-labelled no-op**. The no-op must not send mail, transfer a file, make a purchase, delete data or invoke a production action.
- **First blocker:** the current plugin exposes **no** browser action proposal / verifiable human approval test tool, and its MCP implementation does not demonstrate a client-to-Agent approval proof. Without a separately authorized safe test seam or real supported capability, mark this **NOT TESTABLE**, not failed or passed.
- **Cases if available later:** owner sees exact selected device/session/tab/operation/meaningful parameters; explicit accept runs exactly once; rejection and absent/mismatched proof are denied; altered target/arguments, expired approval, duplicate/parallel replay, disconnection/restart and receipt uncertainty do **not** reauthorize or retry.
- **PASS:** the Agent execution boundary validates the original owner intent for one exact action and denies all invalid/replayed cases; only safe non-content identifiers retained. **FAIL:** a model-generated “yes” or ordinary MCP bearer credential alone permits a high-impact execution. **NOT TESTABLE:** client transport exposes no verifiable owner confirmation. High-impact browser actions stay disabled.

**After both stages:** separately evaluate screenshot MCP image round-trip, real-browser workflow gaps, Agent-local safe upload/download semantics, trusted browser provenance and Linux/WSL2/native Windows acceptance. **Do not extend or repeat a failed/blocked test loop without a material change in the target, instrumentation or policy.**

**Current checkpoint (2026-10-20):** Stage 0 **BLOCKED** at read-only OS/file capability. Stage 1 **NOT RUN** on selected device. Stage 2 **NOT TESTABLE** on current plugin surface. No selected device was modified, and no code, development Ticket, CI, merge or deployment was authorized.


## H. Follow-up: native Windows read-only readiness confirmed (2026-10-20)

**This section supersedes the initial Stage-0 “BLOCKED / unknown OS” finding in §F–G above.** Historical failed Linux-path probes are retained as evidence, not repeated or counted as a current defect.

**Read-only evidence on the exact selected paired device (no commands/process starts):**

| Evidence | Result | Interpretation |
| --- | --- | --- |
| [Worker PR #113](https://github.com/lirtual/mcp-workers/pull/113) | Already **merged**; its accepted problem statement identifies the exact selected UUID as a **native Windows Agent** and records that `C:\Windows\win.ini` had been incorrectly rejected by Worker URI-scheme parsing before the read-only Windows path fix | Corroborates the platform identification from actual project history, without inferring anything about the other same-named device |
| Native Windows filesystem | `stat_file("C:\Windows\win.ini")`, `stat_file("C:\Windows\System32")` and `read_file("C:\Windows\win.ini")` **succeeded**; content was the expected short Win.ini configuration | The **currently connected** Worker/Agent path accepts and can read normal drive-absolute Windows paths; earlier POSIX probe failures were non-diagnostic for this target |
| Other read-only tools | `list_directory("C:\Windows\System32\drivers\etc")` succeeded, returning a few system filenames without reading hosts contents | At least basic Windows read, stat and directory enumeration work. `list_sessions` may legitimately fail: [Windows preview source](https://github.com/lirtual/remote-control-agent/blob/feat/windows-native-preview/apps/remote-control-agent/src/windows-v2.ts) explicitly uses `capability: "read-only"` and does not enable remote Shell/file mutations |
| Browser installations | Windows-known system locations for Microsoft Edge and Google Chrome both contain `msedge.exe` / `chrome.exe` (verified by file attributes only) | Browsers **exist**, not proof they can launch in an isolated Agent context or meet the Playwright build compatibility requirement |
| Playwright managed browser cache | Under the selected Windows user's `%LOCALAPPDATA%\ms-playwright`, the directory contains `chromium-1200`, `chromium_headless_shell-1200` and auxiliary runtime files. The Chromium `chrome-win64\chrome.exe` and headless-shell `chrome-headless-shell-win64\chrome-headless-shell.exe` both passed `stat_file` | **Playwright-compatible browser binary candidates are present on disk**. The Node Playwright library version, OS execution rights, browser launch, real sandboxing, integrity and network boundary were **not** verified |
| Existing Windows Agent program | The user's Agent program store lists version directories `v0.1.10-windows-rc.1-windows-x64` and `v0.1.11-windows-rc.1-windows-x64`. The latter's bundled `bin\node.exe` exists | An Agent runtime including Node has been installed; **directory presence is not proof which version is currently executing**. No identity PEM, secrets, event logs or personal browser Profile content were opened |

**Updated Stage 0 status: `PARTIALLY QUALIFIED` (Windows OS identity and read-only binary presence verified).** The earlier “OS unknown / all file access blocked” summary is **obsolete** after using actual Windows paths. The selected device is **not yet** an approved isolated/browser-executable test fixture: running the browser, validating Playwright library/build compatibility, writable disposable Profile location, network isolation and capability restrictions are untested.

**Operational blocker from primary source, not a guessed error:** the native Windows preview runs `maintainAuthenticatedDeviceSession(..., { capability: "read-only" })` ([source](https://github.com/lirtual/remote-control-agent/blob/feat/windows-native-preview/apps/remote-control-agent/src/windows-v2.ts)). Its [release](https://github.com/lirtual/remote-control-agent/releases/tag/v0.1.11-windows-rc.2) is acceptance-only and states **no Shell or file mutation**, independently of which exact version this device is running. Therefore the existing connected Remote Control tools cannot safely execute a real Chromium network fixture/approval test on the selected Windows device. **Do not route around this via another device, preview process, OS task or mutable file API.**

**Smallest legitimate next gate:** obtain a separately authorized, genuinely **non-destructive test execution surface** for this exact Windows device and a dedicated disposable browser Profile/controlled test HTTP endpoints, or a safe local owner-run harness. Do **not** expand the Windows Agent's general remote Shell privileges merely to run browser tests. A browser-only narrow test entrypoint would itself be a later explicitly reviewed code/product change; nothing in Q1–Q52 authorizes implementing it now. Until the gate is met, network P0 remains `NOT RUN ON SELECTED DEVICE` and ChatGPT→Agent approval P0 remains `NOT TESTABLE` on the current plugin.

**Safety/governance checkpoint:** Only `list_devices`, `read_file`, `stat_file` and `list_directory` were used on the selected device during this follow-up. No Shell, executable start, process/session manipulation, filesystem writes, credential reads, network fixture calls, CI, deployment or implementation Tickets. This read-only evidence should **not** be repeated unless the relevant Agent version, Worker route, OS/binary installation or protocol changes.


## I. Live Windows isolated Chromium baseline and controlled redirect fixture (2026-10-20)

**This section supersedes the historical Windows preview restrictions noted in §F–H.** The owner approved progressing on the **same exact previously selected native Windows device** after installing `v0.1.12-windows-rc.1` and deploying [mcp-workers PR #136](https://github.com/lirtual/mcp-workers/pull/136). Real Agent PowerShell, managed process lifecycle and atomic Windows file operations had separately passed their own acceptance in that PR; the user identity was retained and no re-pairing was needed. **The current Chromium experiment still does not implement browser MCP tools or a network deny policy.**

**Execution boundary:** existing authenticated Remote Control `run_command` + Agent-owned Operation IDs on the selected device; temporary per-test profile and only **synthetic localhost** input. No user Chrome/Edge Profile, external website, credentials, production metadata endpoint, CDP/debugging port, browser package installation, Worker deployment or source code changes. The only test fixture code was a one-off local script stored in the Windows user's Temp directory and removed at the end.

| Probe | Actual observation | Evidence classification |
| --- | --- | --- |
| OS & installed agent | Native Windows/PowerShell 5.1, Agent-bundled Node **v24.21.0**; controlled execution succeeded | Supported *Agent command execution* exists now; older read-only block is obsolete |
| Chromium availability | Existing managed-cache `chromium_headless_shell-1200` executable found; Node's current process cannot resolve `playwright` from this runtime context | Chromium exists, but installed Playwright API/version matching and browser MCP interface are **not verified** |
| Offline isolated Chromium | Headless Chromium launched with a unique disposable `--user-data-dir`, no remote debugger, background-networking flags disabled. `data:text/html` page returned marker `RCA_OFFLINE_OK` | **PASS — Chromium can render a real offline page from this Windows Agent.** No assertion about Playwright automation, private Profile attachment, browser policy or end-to-end MCP screenshot transport |
| Controlled HTTP redirect baseline | Node's built-in HTTP listener bound **only** `127.0.0.1` on an ephemeral port. A synthetic `/public` endpoint returned HTTP 302 to `/simulated-sensitive`; Chromium followed it. Listener recorded **one** public request and **one** simulated-sensitive request; final page marker `RCA_SYNTHETIC_REDIRECT_ONLY` was observed; Chromium exited with code **0** | **PASS — controlled redirect fixture operates, and unguarded Chromium follows it. NOT a PASS for Q45/Q49 security.** No security interception/denial policy was present; this is a *negative baseline* demonstrating why unapproved sensitive-target traffic cannot be assumed blocked |
| Process and file cleanup | Final read-only check found **0** test-tagged headless Chromium processes, **0** `rca-p0-loopback-*` Temp directories, no one-off `rca-browser-p0-test-20261020-1516.js`, and no isolated offline Profile | **PASS — specific temporary test artifacts cleaned**. Personal Profiles and unrelated processes were not accessed or modified |
| Real owner approval proof | Existing Worker `initialize` still advertises `tools` only; no installed `browser_*` tools, action-proposal or Agent-verifiable one-use approval test protocol observed | **NOT TESTABLE** with current plugin surface; ChatGPT approval UI or MCP credential cannot be treated as proof of one-use owner authorization at the Agent |

**Superseded gate status:** §H previously recorded `Stage 0 PARTIALLY QUALIFIED` due the read-only Windows preview. On the now-upgraded Windows Agent, **Stage 0 browser launch is PASSED** for a disposable *offline Chromium* smoke. **Stage 1 synthetic loopback fixture works; policy-enforcement acceptance remains NOT IMPLEMENTED / NOT RUN.** Redirect request and marker counts establish the *baseline without a policy*, not the desired denial. **Stage 2 one-use approval remains NOT TESTABLE**, not a passed security feature.

**Next smallest technical design/acceptance work (not authorized here as a code task):**

1. Prefer reuse of official Playwright runtime integration inside the existing Agent; the current bundled Node process lacking resolvable `playwright` must **not** be “fixed” by an unaudited `npx` network install or a new Browser MCP Worker.
2. Propose the smallest **real browser-wide outbound request policy** with coverage for redirect-effective destinations, DNS/address changes, iframe/subresources, service workers and WebSockets, then exercise the now-working synthetic fixture with an explicit *deny* condition. A server's own 403/404 response is **not** evidence the browser blocked transmission; the sensitive fixture must record **zero inbound requests** to pass Q45/Q49.
3. Separately establish whether the connected ChatGPT/MCP host offers genuinely verifiable, action-bound owner approval delivered to Agent. Until established, consequential browser tools remain disabled. Do not create a custom approval portal or relax Q38/Q51 merely to achieve green tests.
4. The source-only [Browser Automation Design](./BROWSER-AUTOMATION-DESIGN.md) remains Draft #117. No new product decision, implementation Ticket, PR merge, production deployment or broadened privilege grant is made by these results.

**Do not re-run successful Windows read/write/Shell or offline browser tests without a relevant code, browser binary, OS/runtime or protocol change.** Focus any future acceptance on the still-unmet request-policy and verifiable approval gates.


## J. Draft offline-only core implementation checkpoint (2026-10-20)

A separate **unmerged source Draft**, [remote-control-agent PR #15](https://github.com/lirtual/remote-control-agent/pull/15), now contains a small **internal-only, injected Playwright-compatible** `BrowserOfflineCore` candidate on top of the existing Windows full-tools source branch. It is **not** a newly accepted design choice, not a Browser MCP Worker, and not an installed feature.

- **Included:** one Agent-private, persistent offline-profile session; explicit start/status/close; one fixed synthetic HTML tab; at most 8,000 characters from the page's ARIA snapshot; 30-minute idle close with profile retained.
- **Deny-first behavior:** `headless: true`, `offline: true`, disabled JavaScript, disabled Service Worker registration, disabled downloads and page permissions; fail-closed requirement for both HTTP route denial and WebSocket denial registered **before** the first page is created.
- **Intentionally excluded:** any public URL navigation; arbitrary user HTML/JavaScript; click/fill/keyboard/upload/download; live browser MCP exposure; new dependency installation or browser binary management; sensitive-effect owner approval; an assertion of complete network isolation. The driver is injected for type-safe contract tests, not loaded from an npm Playwright runtime; real Playwright integration remains untested.
- **Verification boundary:** the candidate's unit tests verify options, denial registration ordering, denial callbacks, bounded snapshot, no navigation method, duplicate-session refusal, and cleanup on setup failure. A unit test/mock passing is **not evidence** that an actual installed Chromium + Playwright process provides complete network isolation or that Client→Worker→Agent can execute browser tools.
- **Status:** source Draft, explicitly not deployed or merged. Treat the CI run referenced in PR #15 as ordinary source regression evidence, not security/network or client-to-Agent approval acceptance.

**Unchanged P0 blockers:** (1) actual effective-destination network safety across redirects/DNS/subresources/Service Workers/WebSockets is still unimplemented/unverified for any HTTP(S) navigation, and (2) Agent-verifiable exact-action one-use ChatGPT human approval has not been demonstrated. Do not enable new external browsing tools until these independent gates are met. Existing §I Windows offline Chromium and synthetic redirect baseline should be reused, not rerun without a relevant change.


## K. Real Playwright offline Chromium integration — source/test acceptance (2026-10-20)

Separate [remote-control-agent Draft PR #15](https://github.com/lirtual/remote-control-agent/pull/15) now includes **real, typed** Playwright adapter code, not only an injected fake contract. The tested `playwright-core@1.64.1` dependency is exact-pinned and its npm SHA-512 verified in `pnpm-lock.yaml`. The agent's signed release/installer runtime does **not** bundle this developer/test dependency or expose any browser tools.

- **Implementation in Draft only:** `createPlaywrightOfflineDriver(chromium)` maps actual persistent contexts, HTTP request routing, WebSocket routing, fixed offline HTML and ARIA snapshots to the existing offline-only core. Startup refuses a persistent Profile with restored non-`about:blank` tabs; there are no caller-supplied URLs or external actions.
- **Real smoke:** [Agent CI #39389438505](https://github.com/lirtual/remote-control-agent/actions/runs/39389438505) **3/3 passed** (Ubuntu x64, Ubuntu ARM64, native Windows x64). Its single Ubuntu x64 integration step downloaded the matching Chromium **headless shell into an ephemeral CI cache**, launched it with Playwright, rendered the fixed offline page, captured an ARIA snapshot, and closed the isolated context. Windows and Linux baseline typechecks/unit tests also passed. The Windows x64 job did **not** run a real Playwright smoke on the owner's device or stage a Playwright npm runtime into the Agent.
- **Environment/source distinctions:** The previously passed real native Windows Chromium smoke (§I) used Chromium's native CLI, not a Playwright Node runtime. The new real Playwright integration test passed on isolated Ubuntu CI, **not on the installed Windows Agent**.
- **Still unsupported:** Browser tool exposure via MCP, binary/screenshot transport, trusted/pinned browser distribution inside an Agent release, Windows/WSL2 real Playwright acceptance, public navigation, uploads, and high-impact actions. Existing Playwright `offline: true` and intercepted requests must **not** be represented as a complete OS-level egress firewall or SSRF protection (for example, Playwright offline emulation does not necessarily cover all traffic paths).
- **Unchanged product and security gates:** full redirect/DNS/subresource/Service Worker/WebSocket effective-target denial for any external web access remains **NOT IMPLEMENTED/UNVERIFIED**, and ChatGPT-to-Agent one-use action-bound owner approval remains **NOT TESTABLE**. PR #15 remains Draft and is not merged, shipped, or deployed.

**No need to repeat** unmodified Windows full-tool acceptance, synthetic redirect baseline or Linux offline smoke on future turns unless code, OS, browser version, installation or protocol changes materially require new evidence.

## L. Unpublished Windows browser-enabled candidate bundle — accepted in CI only (2026-10-20)

Separate [remote-control-agent Draft PR #15](https://github.com/lirtual/remote-control-agent/pull/15) now **supersedes §K's packaging limitation** for a **test-only, optional Windows x64 browser-enabled candidate**, without changing a production or installed Agent.

- The existing stock Windows Agent candidate is constructed and validated unchanged. On the dedicated PR-only Windows CI step, `stage-browser-runtime.mjs` takes an **isolated copy** of that stage and adds the exact-pinned `playwright-core@1.64.1`, the matching Chromium Headless Shell installed by the pinned Playwright CLI, and only the reviewed offline browser modules. There is **no automatic browser install on user devices**, no modification of the stock production build, no new Worker or release system.
- The optional candidate extends the existing `bundle.json` per-file SHA-256 inventory. `verify-windows-preview.mjs` enforces file presence, supported package version/headless revision, bounded size/entry count and rejects symlinks/unmanifested bytes. The candidate is compressed, **re-extracted**, reverified, then exercised with **the bundled `bin/node.exe`** and the included Playwright library and matching Chromium binary. An actual synthetic offline page produced a Playwright ARIA snapshot.
- Provenance distinction: the pinned npm `playwright-core` package has a registry-verified SHA-512 tarball integrity value; the headless browser is installed through the official pinned Playwright CLI matching a revision in `browsers.json` and its copied file bytes are hashed into this specific candidate. This does **not independently prove an upstream vendor-published SHA-256 for the browser binary** or qualify arbitrary user-supplied local browser executables.
- [Agent CI #39391737035](https://github.com/lirtual/remote-control-agent/actions/runs/39391737035) **3/3 passed**, including Windows x64 optional browser repackage+reopen+real browser smoke, native Windows existing installation identity/upgrade/rollback regression, and Linux x64/ARM64 tests. Earlier failures were not ignored: Windows output startup polling was made bounded, and CI copied the original stock candidate rather than allowing browser staging to contaminate the later version-switch test.
- **Only supported claim:** real offline Playwright inside an unpacked Windows CI candidate. The user's selected Windows device still runs the previously installed Agent **without Playwright tools**, and the full Agent+Worker+ChatGPT browser flow is not enabled or verified.

**Unchanged independent P0 blockers:** effective outbound network controls for redirects, DNS/rebinding, iframes/subresources, Service Workers and WebSockets are still unimplemented/unverified for external navigation; exact-bound Agent-verifiable one-use owner consent is unverified. Browser UI tools, arbitrary navigation, uploads and consequential actions **must remain disabled**. PR #15 and the design PR remain Draft; no new Tickets, source merges, production releases or device deployments.

## M. Real Chromium offline request-denial baseline — source-only CI acceptance (2026-10-20)

[remote-control-agent Draft PR #15](https://github.com/lirtual/remote-control-agent/pull/15) now adds `browser-network.test.ts`, a **real Playwright + Chromium network observation test**, to the existing isolated Ubuntu x64 smoke. This is distinct from §I's Windows command-line unguarded redirect baseline and §L's packaged Windows offline browser smoke.

**Trustworthy synthetic control:** a Node HTTP server bound only to `127.0.0.1` provides `/public` (302 → `/simulated-sensitive`). An unguarded real Chromium follows the redirect, and the server independently records exactly **one request for each URL**. The same server is then reset for the **offline-only BrowserCore** test, demonstrating the fixture was reachable from a browser rather than silently blocked by CI infrastructure.

**Adversarial test-only probes:** the genuine offline core starts with its own temporary persistent Profile, `offline: true`, route abort, WebSocket close hook, JavaScript disabled, Service Workers blocked, downloads disabled and a fixed local page. Test code (not a public Agent/MCP tool) accesses the underlying protected Playwright context and deliberately tries direct navigation to `/public` and embedded image, iframe and stylesheet loads targeting `/simulated-sensitive`. The fixture records **zero requests from the protected context**. The blocked navigation destroys its tab's execution context; tests use a *separate protected-context test page* for subresource checks, without relaxing network denial. Profiles, server and Chromium instances are closed/removed.

[Agent CI #39392823404](https://github.com/lirtual/remote-control-agent/actions/runs/39392823404) **3/3 success:** actual Linux x64 Chromium test with positive control and zero-hit negative probes, Linux ARM64 regression, Windows x64 stock/optional-browser-candidate checks including existing native upgrade/rollback. Unit-only injection checks and CI package validation remain separately scoped.

**What passed:** the exact tested offline Chromium page-network behavior prevented delivery to an otherwise reachable controlled loopback fixture. **What did not pass / is not implemented:** an allow-some-HTTP(S) mode that validates the *effective* destination at every new network connection; per-redirect reauthorization, DNS rebinding/resolved IP and same-origin connection reuse, iframe/subresource and WebSocket/Service Worker bypass under real browsing, independent OS-level egress enforcement (including WebRTC), and exact-bound ChatGPT-to-Agent one-time user approval. A route callback and `offline: true` do **not** replace an operating-system network control; Playwright documents that offline emulation does not stop WebRTC traffic.

**Decision continuity:** Q1–Q52 unchanged. Leave all arbitrary external navigation, clicks, uploads and high-impact actions **disabled**. Reuse the validated offline fixture as a regression test. Advance the remaining *public-network safety* P0 only with a separately reviewed enforcement boundary and a measurable **zero target hits with deliberately allowed source traffic** test; never mark the full P0 PASS from this offline-only proof. PR #15 and this design PR are Draft; no merge, deployment, Release or Tickets occurred in this acceptance.

## N. Effective network isolation: route-only bypass reproduced and native enforcement candidates (2026-10-20)

### Observed security failure — not a shipped production vulnerability

Separate [remote-control-agent Draft PR #15](https://github.com/lirtual/remote-control-agent/pull/15) now runs a second real Chromium network test. Two controlled `127.0.0.1` HTTP servers on **different ephemeral ports** model (A) an authorized starting origin and (B) a forbidden effective destination. An intentionally insufficient, *test-only* `browserContext.route("**/*")` handler allows A's initial URL and rejects all other URLs if it is called. Server A returns an **absolute cross-origin HTTP 302** to server B.

**Observed:** A receives exactly one request; **B also receives one request**, while the Playwright handler receives **no additional callback to authorize B**. The final browser page contains B's synthetic marker. This directly reproduces the [Playwright network redirect specification](https://playwright.dev/docs/network#redirects): `route.continue()` passes the redirect chain into the browser network stack. The separate earlier **offline-only** zero-hit regression (§M) still passes, but cannot be used to approve conditional public internet access.

[Agent CI #39393949998](https://github.com/lirtual/remote-control-agent/actions/runs/39393949998) **3/3 PASS** — Ubuntu x64 real Chromium positive/bypass/offline tests, Ubuntu ARM64 source regression, Windows x64 optional browser candidate and original native upgrade/rollback checks. The intentional route-only bypass test ran on **Linux CI**, not on the owner's Windows device. No external, personal, LAN or real metadata endpoint was contacted.

### Minimum viable enforcement boundary — platform candidates, **not** selected solutions

- **Windows native:** [Microsoft AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation) provides **kernel-level network isolation** and distinguishes Internet/private-network capabilities. Microsoft also documents [`Experimental_CreateProcessInSandbox`](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox), a Windows 11 **experimental, subject-to-change** API with AppContainer-backed restrictions. Its use with Chromium/Playwright multi-process launch, browser child inheritance, private Profile ACLs, DevTools pipe, ordinary non-admin Windows Agent account and link-local/metadata routing has **not** been demonstrated. Do not assume availability or silently add a native launcher/WFP firewall rule; AppContainer network categories alone do not prove all target/IP rules.
- **Linux / WSL2:** [Linux network namespaces](https://man7.org/linux/man-pages/man7/network_namespaces.7.html) isolate IPv4/IPv6 devices, routing and socket stacks, but [`CLONE_NEWNET`](https://man7.org/linux/man-pages/man2/unshare.2.html) requires suitable capabilities/user-namespace configuration. Existing Linux/WSL2 Agent installations have **not** passed a normal-user browser-in-namespace test. Do not assume unprivileged namespace creation or auto-elevate the Agent.
- **One process boundary, not two MCP systems:** The desired enforcement must apply to **all Chromium/browser child-process sockets**, not only page requests; it must block direct egress when a conditional request broker or proxy is bypassed. A user-level browser `--proxy-server` flag by itself is not proof of no-bypass enforcement. Reuse the existing Agent lifecycle and paired device; no additional Cloudflare Worker, browser CDP server, authorization database or general machine-wide firewall modification is approved.
- **Fail-closed first:** Keep browser external navigation absent until a platform-specific enforcement mechanism is proven, and return an explicit unavailable/not-accepted status if the chosen mechanism cannot be established. Keep the current offline-only tool-free core as a known safe subset, **without claiming it is an OS network sandbox**.

### Read-only Windows API availability probe on the previously authorized device

The exact previously selected native Windows Agent was queried through an **Agent-owned, short-lived read-only PowerShell command**. The probe dynamically loaded only the known System32 `processmodel.dll` with `LOAD_LIBRARY_SEARCH_SYSTEM32`, checked exports with `GetProcAddress`, unloaded the module, and exited with status 0. Its bounded output was:

```text
PROCESSMODEL_LOAD=True
CREATE_IN_SANDBOX_EXPORT=True
CREATE_AS_USER_IN_SANDBOX_EXPORT=True
NOTE=Export availability only; no sandbox process launched
```

This is **ABI symbol availability only** on the owner's currently selected Windows installation. It rules out a missing DLL/export, **not** unsupported sandbox semantics, multi-process Chromium startup, required FlatBuffer `SBOX` policy compilation, non-admin permissions, Playwright IPC, effective link-local/private-network filtering, or revocation. No sandbox was created, no file/registry/firewall setting changed, and no other paired device was contacted. Microsoft explicitly marks this API [experimental](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox). Do not implement based solely on the export check.

### Smallest platform acceptance contract for any future public-browsing enablement

1. A **positive** synthetic public HTTP(S) target must receive a request and render a page. A **different** forbidden fixture, reached via a cross-origin 302 or new resolved/private/link-local IP, must receive **zero** requests—not merely a Playwright blocked event. Include IPv4 and IPv6.
2. Prove redirects (including several hops), DNS/public-to-private rebinding, background/subresources, iframe, JavaScript fetch, Service Workers, WebSockets, WebRTC UDP, proxy-bypass attempts and Chromium subprocesses cannot reach a forbidden listener. Detect both TCP and UDP target hits. Unsupported transports must be demonstrably blocked by a *lower* boundary.
3. Demonstrate the ordinary Windows/WSL2/Linux user account can **actually launch, use and revoke** Chromium under the restriction, including private Profile, worker processes and Playwright IPC, *without modifying global host rules or requiring unapproved elevation*. Abort startup on absent/failed isolation.
4. Only after that, define bounded authorized public target scopes and retest **every effective target**; preserve Q45/Q49 explicit internal-target authorization and Q38/Q51 high-impact approvals. OS egress controls and Agent authorization are **complementary**, not substitutes.
5. Reuse this exact synthetic fixture and previous Linux/Windows acceptance evidence; do not add a new general-purpose proxy or complex declarative policy engine speculatively. If the platform's suitable isolation is not possible with current Agent privileges, seek an explicit owner architectural trade-off instead of weakening the network P0.

**Status:** route-only allowlisting is **disqualified**, offline-only negative regression **passed**, cross-platform OS-backed conditional external access **not implemented or accepted**; one-use owner confirmation separately **not testable**. This is a research and CI evidence update inside existing Draft PRs; no product decision Q53, new ADR/Ticket, production code merge, release or deployment.

## O. Ordinary-user Linux namespace feasibility and reuse-first sandbox options (2026-10-20)

[remote-control-agent Draft PR #15](https://github.com/lirtual/remote-control-agent/pull/15) adds a **source-only/CI-only normal-user Linux process/network namespace probe**, `apps/remote-control-agent/scripts/probe-linux-network-namespace.mjs`, to the existing Ubuntu x64 real Playwright smoke. It neither modifies the host nor elevates privileges: **no sudo, sysctl, AppArmor exceptions, Docker daemon, host firewall, iptables or production Agent changes**.

### Actual CI execution and conclusion

The probe first creates an ephemeral **127.0.0.1 TCP listener** and confirms that a normal host process reaches it (positive control, exactly one connection). It then tries `unshare --user --map-root-user --net -- <node> <probe> --child ...` to create an unprivileged child network namespace. Its design is to assert **zero additional listener hits**, and only if namespace creation succeeds, attempt real Playwright headless Chromium offline rendering within that process namespace.

The first CI attempt revealed a **test-fixture-only** unhandled TCP `ECONNRESET` from an eagerly closed positive-control socket, not a network isolation bypass. The server now handles that teardown error. On the corrected run, [Agent CI #39399956790](https://github.com/lirtual/remote-control-agent/actions/runs/39399956790) **3/3 jobs passed** — Windows x64 stock/optional browser candidate, Ubuntu ARM64 and Ubuntu x64 regression. The actual **Linux sandbox probe returned**:

```text
RCA_NETNS_PROBE={"status":"UNAVAILABLE","reason":"unshare-or-child-exit",
 "code":1,"detail":"unshare: write failed /proc/self/uid_map: Operation not permitted"}
```

**Interpretation: Linux ordinary-user namespace creation was denied by this specific Ubuntu 24.04 CI Runner.** No isolated Chromium child was started, so neither Linux network containment nor browser-in-container usability **was accepted**. The green CI verifies the source and the **correct fail-closed report**, NOT this OS containment P0. Ubuntu 24.04's unprivileged namespace restrictions and AppArmor policy are documented in [Ubuntu's release notes](https://documentation.ubuntu.com/release-notes/24.04/). Do **not** disable the system restrictions to make the probe green. WSL2 and the user's actual WSL account have **not** been probed by this test; do not extrapolate CI's negative result to those installations.

### Existing runtime worth evaluating instead of writing a second sandbox engine

[Microsoft MXC (Microsoft eXecution Container)](https://github.com/microsoft/mxc) is an open-source **candidate**, not a selected dependency. The repository advertises a typed [Node SDK](https://github.com/microsoft/mxc/tree/main/sdk/node) and platform-specific ProcessContainer (Windows 11) / Bubblewrap (Linux) backends with `network.egress.default: "deny"` support and an existing container lifecycle. The source `sdk/node/package.json` currently declares `@microsoft/mxc-sdk` **version 1.0.1** and Node >=24; this is a *source version observation*, **not yet an npm registry/provenance validation or integrated Agent acceptance**. Its own [Windows support matrix](https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/os-version-support.md) documents minimum Windows 11 24H2 process-isolation build **26100.9278**, but OS version alone does not establish whether the target host offers MXC's **native WFP enforcement tier** versus a less capable AppContainer fallback. Its [networking guide](https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/networking.md) explicitly warns that AppContainer compatibility does not provide the same IP/CIDR-specific or no-bypass proxy rules as newer ProcessContainer runtime capabilities.

**Do not assume the SDK bypasses Linux AppArmor:** Bubblewrap and its namespace capabilities still depend on host permissions, so this CI result remains a platform blocker until the provider is actually validated. **Do not introduce MXC as a production dependency merely because it offers a JavaScript API**, and do not introduce a second Worker, dedicated proxy or firewall daemon at this stage.

### Next smallest decisive experiment

1. On a **disposable Windows 11 Runner meeting the documented build requirements**, inspect MXC ProcessContainer feature availability and its **actual enforcement tier** under an ordinary user (including whether no-bypass egress can be enforced). If unavailable or only a weaker fallback is returned, report **UNAVAILABLE/NOT ACCEPTED** and stop without weakening controls.
2. Only if the process-sandbox backend is genuinely usable, perform an **ephemeral, no-real-address** baseline with a source listener that is deliberately allowed and a forbidden redirect target that records **zero hits**. Require real Chromium multi-process startup, profile access and IPC, not only `cmd.exe` execution. Confirm that the restriction also covers browser helper processes; no admin/UAC or global host rule changes.
3. On Linux/WSL2, keep unprivileged namespace support a platform preflight gate; do not auto-fallback to unrestricted Chromium or silently use the Docker root daemon. If unavailable, **external navigation stays off** while the offline-only core may remain testable.
4. Treat these as independent from the still-**unverified** exact-action one-use ChatGPT→Agent owner approval gate. The offline-only Chromium zero-hit test and the initial-URL route redirect bypass are already proven and should not be repeated absent changes.

**Architecture/state:** Q1–Q52 unchanged. OS isolation **P0 NOT ACCEPTED**; no public browser tools, new production dependencies, releases, merges, deployments, host configuration modifications or new Tickets.

## P. Windows MXC request-tier probe — no sandbox launched (2026-10-20)

The follow-up to §O has now run on an **ephemeral GitHub Actions Windows x64 Runner**, not on the user's paired Windows 11 device. The separate, source-only [remote-control-agent Draft PR #15](https://github.com/lirtual/remote-control-agent/pull/15) adds `probe-windows-mxc.mjs` and a conditional read-only CI step. This exact-version **Microsoft `@microsoft/mxc-sdk@1.0.1`** is installed using `--ignore-scripts` under `RUNNER_TEMP` and removed after inspection; it does **not** enter the Agent package, bundle, lockfile, Windows scheduled task or device.

The code invokes MXC's documented **`probe(ContainerRequest)` only**, with a synthetic `cmd.exe` command that is **never run** and a requested `network.egress.default = deny` plus an allow rule for IANA documentation-only `198.51.100.1/32:443`. That CIDR is only a policy selector; no real socket, sandbox/AppContainer profile, firewall rule, elevated command or production process is created.

[Agent CI #39401072265](https://github.com/lirtual/remote-control-agent/actions/runs/39401072265): **3/3 completed successfully**, including unchanged Linux x64/ARM64 and native Windows full-tools/browser-candidate/upgrade tests. The **actual Windows tier probe** returned:

```text
RCA_WINDOWS_MXC_PROBE={
  "status":"WEAKER_TIER_NOT_ACCEPTED",
  "sdk_version":"1.0.1",
  "tier":"appcontainer-dacl",
  "base_container_api":false,
  "error":null,
  "process_spawned":false,
  "network_tested":false
}
```

Its warning identifies the **BaseContainer tier as unavailable on this Runner** and an AppContainer + DACL compatibility fallback as the selected tier. It also warns that some program startup/file metadata paths may need **elevated** host preparation (e.g., system drive root / NUL device). No such preparation was performed. Per [MXC's official networking guide](https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/networking.md), the compatibility tier is **not equivalent to native ProcessContainer WFP per-target network enforcement**.

**Scope and interpretation:** A successful SDK `probe()` API call does **not** mean the process or network is isolated. **The Windows GitHub Runner's tier is insufficient for target-specific conditional public browsing; OS network P0 remains NOT ACCEPTED.** This does not determine what tier the *owner's Windows 11 machine* supports. The owner's earlier `processmodel.dll` export presence only proved symbols exist, not native enforcement availability. Do not extrapolate one host's tier to the other, do not auto-install host-prep, do not lower the target/network acceptance contract, and do not ship MXC or an external proxy as a workaround without explicit separate design review.

**Next decision gate:** Any actual Windows process isolation launch must first show **native, non-admin, per-process no-bypass egress** capability on the intended Windows platform; only then test real Chromium/children against reachable/forbidden synthetic fixtures, verify zero forbidden hits, and preserve private Profile/IPC. Linux/WSL2 has its independent ordinary-user namespace gate (see §O). Both remain independent of one-use owner approval. Current PRs stay Draft; no public navigation, code merge, release, deployment, Agent/device modification or Tickets.

## Q. Owner's exact Windows device: native ProcessContainer capability confirmed (2026-10-20)

The owner explicitly continued the already selected **read-only OS-tier preflight** on paired native Windows device **`71b4b4d8-6496-4898-9b80-1ea3a03f6ccd`**. Device discovery confirmed it is **online**; do not confuse it with the separate online WSL2 Ubuntu device that has the same hostname. The existing full-tools Remote Control Agent executed a temporary local PowerShell command **as the normal user**, not administrator, without invoking any sandbox creation.

Preflight observed:
- Windows 11 **25H2**, exact version/build **26200.9711**, ordinary user (`IS_ADMIN=False`); Node `v24.12.0`, npm `11.6.2`, bundled Agent Node exists.
- Installed **exact-pinned `@microsoft/mxc-sdk@1.0.1` only under a unique private `%TEMP%` folder** using npm `--ignore-scripts --no-save --no-audit --no-fund`, with a separate temporary npm cache. Loaded the documented `@microsoft/mxc-sdk/v1` `probe()` code in a temporary Node script and requested a **default-deny plus per-CIDR/per-port egress policy**. The example CIDR `198.51.100.1/32:443` is a documentation-only policy selector; there was **no socket, browser process or AppContainer created**.
- Returned a materially different result from the Windows GitHub Runner (§P):

```text
RCA_MXC_TARGET={
 "tier":"base-container",
 "baseContainerApiPresent":true,
 "status":"OS_TIER_CANDIDATE",
 "warnings":[],
 "error":null,
 "process_spawned":false,
 "network_tested":false
}
MXC_PROBE_EXIT=0
PROBE_TEMP_CLEANED=True
```

The Agent-owned command/session completed with **exit code 0** and durable `completed` receipt. The entire probe directory and npm cache were removed; no system firewall policy, task, registry, Agent program, device identity or production Worker was changed.

**Supported conclusion:** this particular Windows host can report the MXC **native `base-container` tier** for a strict CIDR/port-selective network policy under its existing ordinary-user account. Microsoft's [Windows OS support matrix](https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/os-version-support.md) lists minimum 25H2 Process Isolation build `26200.9278`; this device is at `26200.9711`, consistent with the result.

**NOT YET ACCEPTED:** the probe is **not** a successful `run()/spawn()` or a WFP traffic-enforcement observation. It does not prove the policy can be applied to the actual browser, that Chromium multi-process helpers remain isolated, or that *any* forbidden HTTP/TCP/UDP endpoint receives zero packets. Any native AppContainer/ProcessContainer process creation, ephemeral network listeners and Playwright launch require a separately scoped, controlled next-stage real-device test; this read-only phase intentionally did not launch them. External browser navigation and approval-dependent actions remain disabled.

**Next smallest step:** a disposable, strictly bounded **Windows-only** MXC `base-container` process experiment, with two synthetic 127.0.0.1 listeners bound to distinct ephemeral ports and an explicit *allowed* endpoint (positive control). Establish the platform's documented loopback capability/egress interaction **before** constructing an allowlist; demonstrate the denied endpoint receives **zero** actual requests even after cross-origin 302 and child-process startup, verify cleanup on timeout/revocation, and abort on any tier downgrade or native policy failure. Avoid private LAN, cloud metadata, production sites, elevated host-prep, machine-wide firewall changes or a new proxy/Worker. Only then attempt real Playwright Chromium inside that isolated process. Reuse prior baseline tests, not repeat them needlessly. The unrelated one-use owner-approval P0 remains separately blocked.

PR #15 and this design PR remain Draft; this investigation did not merge, release, deploy, change the Agent or create Tickets.

## R. Actual Windows BaseContainer launch and WFP fixture attempt — process startup blocks network acceptance (2026-10-20)

Following the successful **read-only** native MXC capability probe in §Q, the user authorized proceeding with the next, explicitly controlled step on the **same paired native Windows device** `71b4b4d8-6496-4898-9b80-1ea3a03f6ccd` (25H2 build `26200.9711`, ordinary user). This iteration used `@microsoft/mxc-sdk@1.0.1` via a **separate, unique `%TEMP%` installation with `--ignore-scripts`**. Each experiment ended with removal of its scripts, installed SDK and separate npm cache. No administrator, UAC, MXC host-prep, host-global firewall/ACL/registry change, Agent reinstall, Worker deploy or actual private/public network target was used.

### Phase 1 — genuine native ProcessContainer execution: PASS (basic command only)

A strict request (`network.egress.default="deny"`, `ingress.default="deny"`, `hostLoopback="deny"`) returned `tier="base-container"` from `probe()`. A **real** `run()` invoked `cmd.exe` inside the sandbox, printed `RCA_MXC_SANDBOX_STARTED`, returned `exitCode=0`, `timedOut=false`, and produced no warnings or errors. The parent Agent-owned command exited 0 with `TEST_TEMP_REMOVED=True`.

**Meaning:** ordinary-user native Windows ProcessContainer process creation and a basic `cmd.exe` payload **are confirmed on the selected host**. This is more than mere ABI/tier discovery. It does **not** establish that the process could transmit network traffic, or that a Chromium/Playwright child can start.

### Phase 2 — synthetic two-port network policy: NOT ACCEPTED

A Node HTTP fixture bound two different random TCP ports on **`127.0.0.1`**: the *allowed* endpoint returned content and HTTP 302 to the *denied* endpoint. The **unsandboxed host** successfully accessed *both* fixtures (positive control).

MXC again returned `tier=base-container`, no warnings/error for a per-process rule with `network.egress.default="deny"` and an **allow for only `127.0.0.1/32` TCP at the source port**, using `ingress.default="allow"` and `hostLoopback="allow"` to meet Windows' documented loopback requirement. The intended success condition was: **allowed server receives `/allowed` and `/redirect`; denied server receives zero requests**, even after following the redirect. Attempts and actual observations:

| Attempt | Sandbox child | Actual result | Server hits |
| --- | --- | --- | --- |
| A | Installed normal Node.js running a dedicated temp script with an Agent-private working context and restricted file path | Process terminated with signed code `-1073741502` (`0xC0000142`, DLL initialization failure) before producing output | Allowed **0**, denied **0** |
| B | Windows system `curl.exe` launched from the original Agent working directory | Three client invocations reported invalid current directory | Allowed **0**, denied **0** |
| C | The same built-in `curl.exe` after explicitly using `C:\Windows\System32` as sandbox working directory | Invalid-CWD error disappeared, but three client invocations failed with Access Denied | Allowed **0**, denied **0** |

**Fail-closed conclusion:** zero denied-server hits are **not proof of WFP filtering**, because no allowed-server request was delivered. The sandbox's **child-tool startup/file access environment** must be resolved before meaningful positive/negative network enforcement can be measured. The distinction between `run()` being available and a particular executable being runnable is important; do not mark external browsing P0 passed.

### Phase 3 — minimal child launch diagnostics: results scoped to the tested policy

A final **default-deny sandbox, no network listener** compared startup of existing Windows executables, with System32 as working directory:

- `powershell.exe -NoProfile -NonInteractive`: exits `-1073741502` (`0xC0000142`) before printing its marker.
- `curl.exe --version` via `cmd.exe`: reports Access Denied, exit 1.
- The previous simple `cmd.exe echo` in BaseContainer remains PASS.

Those errors suggest a **process initialization / filesystem access compatibility issue**, but they do **not** yet identify a specific ACL, DLL, or MXC bug. In particular, the probe's native-tier selection is not itself proof that a requested filesystem policy makes these executables runnable. Do **not** run elevated `wxc-host-prep`, broaden the host system-drive ACL, add an arbitrary proxy, grant machine-wide firewall exceptions or downgrade isolation just to make the test green.

All temporary installations and scripts reported successful deletion, and all Agent-owned tool sessions returned completed receipts. No long-running test process was intentionally left running. PR #15 and PR #117 remain Draft; this iteration changed **no** browser feature source, merged code, release, installed Agent or production Worker.

### Smallest next gate — targeted startup compatibility before any more WFP requests

1. Using Microsoft's documented **container filesystem policy helpers** or the minimum explicit read-only paths, identify why `powershell.exe` or `curl.exe` fails in **native BaseContainer under a normal user**, with a bounded offline-only startup test and no admin/system policy changes. Verify changes do **not** broaden host permissions or fallback to `appcontainer-dacl`.
2. Only after **one** network-capable executable reliably starts inside the isolated process, rerun a two-port synthetic listener test and require **allowed hits > 0**, **denied hits = 0** including redirect, with independent parent-server counting. Extend IPv6, DNS, WebSockets/UDP and all browser child processes **only** after this minimal positive/negative enforcement works.
3. Exact-bound ChatGPT-to-Agent one-time authorization remains an **independent P0**. Do not enable arbitrary public browser navigation or claim full egress protection from these results.

**Current classification:** Windows **normal-user native ProcessContainer launch PASS**; Windows conditional WFP/network enforcement **NOT ACCEPTED / NOT TESTABLE with present client startup**; Chromium in sandbox **NOT TESTED**; one-use user authorization **UNVERIFIED**.


## S. External agent-native browser reference: CitroLabs ego-lite (2026-10-20)

**Review type:** source/documentation/issue comparison, **not** a new Q53 decision, new architecture, new dependency, source implementation, release or deployed-device acceptance. Examined [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite), main branch, and official release [v2.1.0 (2026-10-16)](https://github.com/citrolabs/ego-lite/releases/tag/v2.1.0). GitHub repository code is MIT-licensed; the standalone downloadable Ego Lite Chromium application and its native implementation are **not established by this repository to be fully open-source**, so its native protection behavior cannot be verified solely from the TypeScript helper repository. Project-reported performance/Token advantages are **not independently reproduced**.

### What is technically useful

| Source evidence | Possible reuse in our existing Agent + Playwright design | Required boundary |
| --- | --- | --- |
| [Task Space / Profile / page lifecycle](https://github.com/citrolabs/ego-lite/blob/main/docs/native-bindings-api.md), [page ledger](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/src/page-ledger.ts) | Distinguish Agent task ownership from physical tab identity and allow observation, owner takeover, stop/resume and safe cleanup without stealing the owner's foreground tabs | Keep **one dedicated Automation Profile per device**, at most one active session for it (Q7/Q10/Q11), stable device/session/tab IDs; no new general multi-profile/task registry |
| [Native snapshot/ref requirements](https://github.com/citrolabs/ego-lite/blob/main/docs/native-snapshot-ref-requirement.md), [Page ref registry](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/src/page-ref-registry.ts), [observation code](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/src/driver/observe.ts) | Keep compact semantic snapshots, actionable refs, frame/document provenance, and explicit stale/ambiguous-ref rejection. Avoid unreliable role/name or screen-coordinate fallback when identities cannot be verified | Keep ~8,000-character bounded output (Q43) and scope ref validity to the exact device/session/tab/frame/document; do not persist whole DOM or credential-bearing snapshots in receipts |
| [Task-control APIs](https://github.com/citrolabs/ego-lite/blob/main/docs/native-bindings-api.md) | An explicit **owner-in-control → Agent paused** lifecycle can improve the manual takeover / hand-back experience; reject mutation against a task currently handed to the owner | **Handoff is NOT an Agent-verifiable short-lived one-use approval** for one high-impact action (Q23/Q27/Q38/Q51); never infer consent from resumed task status |
| [Agent-side Node.js helper runtime](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/README.md), [NativeOperationGate](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/src/native-gate.ts) | Fewer remote round-trips via better observation budgeting, fewer redundant page reads, and potentially future bounded local execution of **already authorized atomic operations** | Q17/Q25 **reject generic browser action dispatchers and arbitrary JS/CDP**; any new batch API would be a **separate design decision**, not approved through this research; per-action receipt/confirmation and replay refusal still apply |
| [Skill and version-matched usage guide](https://github.com/citrolabs/ego-lite/blob/main/docs/ego-browser-skill-command.md), [real-browser E2E](https://github.com/citrolabs/ego-lite/blob/main/docs/local-runtime-development.md) | Useful pattern: automation documentation tied to the actual runtime version, plus real Chromium regression fixtures for snapshots, iframes, stale refs, dialogs and lifecycle | Continue leveraging our existing CI/Agent acceptance, no second browser runtime/release system |

### Security and fit limitations — these are reports, not verified current binary vulnerabilities

- [Issue #315](https://github.com/citrolabs/ego-lite/issues/315) **open as checked:** reports model-generated Node.js code with raw CDP/cookie methods and Node-side outbound `fetch` can expose browser authentication material. The repository indeed provides raw CDP and Node HTTP helpers in [cdp-eval.ts](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/src/cdp-eval.ts) and [http.ts](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/src/http.ts). **Do not claim the installed v2.1.0 native browser was independently exploited.** Under our Remote Control pairing the risk of overbroad scripted capability and credential exfiltration would be amplified.
- [Issue #303](https://github.com/citrolabs/ego-lite/issues/303) and [#320](https://github.com/citrolabs/ego-lite/issues/320) report **shared-profile cookie changes propagating across Task Spaces** in older builds. A UI Space is not proof of cookie/browser-context, OS-process, network, or website-effect isolation. These reports do **not** establish the exact behavior of every v2.1.0 profile configuration.
- [Issue #213](https://github.com/citrolabs/ego-lite/issues/213) reports globally switched CDP session/target races under simultaneous Task Spaces. The TypeScript [NativeOperationGate](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/src/native-gate.ts) serializes operations using the process-wide selected Space; **do not design our routing around mutable global browser target selection**.
- [Issue #270](https://github.com/citrolabs/ego-lite/issues/270) and [#416](https://github.com/citrolabs/ego-lite/issues/416) report abandoned task-space/renderer cleanup problems in older versions, reinforcing our Q13 30-minute idle-close, explicit ownership and fail-safe recovery rules, without asserting the newest Ego Lite behavior.
- [Issue #374](https://github.com/citrolabs/ego-lite/issues/374) and [#411](https://github.com/citrolabs/ego-lite/issues/411) describe **requested** Windows-hosted WSL2 and authenticated cross-device remote access; neither is proof that Ego Lite supplies the existing Remote Control's authenticated device/receipt transport. Official project README lists Windows/macOS today and Linux as roadmap.
- No inspected Ego Lite source or vendor documentation independently establishes **WFP/BaseContainer effective-destination enforcement** covering redirect, DNS, subprocesses, WebSocket/WebRTC or a verified client→Worker→Agent one-use owner approval chain. A sandbox around an Ego Lite *CLI wrapper* does not constrain an already-running browser process outside that sandbox. Do not substitute Ego Lite for the native network/approval P0.

### Scope decision and follow-up priorities

1. **Keep current architecture:** existing Remote Control MCP + paired Agent + Playwright-compatible Chromium + local, owner-controlled dedicated Profile; no new Ego Lite runtime dependency, extra browser Worker, unauthenticated CDP listener, personal-profile import or system-wide permissions.
2. **Best low-complexity refinements to evaluate at interface review:** snapshot compaction with strict actionable ref provenance; stale ref rejection across navigation/frame changes; a small explicit `owner_in_control` / `agent_paused` lifecycle using existing session/receipt concepts. These are **candidate implementation details**, not newly selected tool names or accepted product decisions.
3. **Performance:** optimize result size, avoid unnecessary repeated full snapshots, reuse Agent-local execution context; evaluate bounded batching **only if** measured remote MCP round trips justify a new contract and each constituent atomic action receives individual policy/receipt handling. No arbitrary scripts or generic batch dispatcher now.
4. **Keep P0 order:** proceed from §R's actual Windows BaseContainer `cmd.exe` PASS but network-client/DLL/file-access **NOT ACCEPTED** state; solve smallest non-admin process startup compatibility and prove allowed fixture **>0** hits + denied redirect fixture **0** hits before Chrome/Playwright online navigation. Separately validate exact-bound, one-use human approval before high-impact effects. Ego Lite neither resolves nor relaxes those gates.
5. **No copy-paste source transfer yet.** If implementation later incorporates MIT-licensed code, review the exact files/dependencies and preserve required license/copyright notices; borrowing design ideas alone requires no new runtime license dependency.

**Disposition:** valuable reference for Agent UX, semantic targeting and locally efficient workflows; **not a viable replacement for our current security architecture or a verified solution to the open egress and authorization P0s**. Q1–Q52 and their ADRs remain unchanged. No Ego Lite installation, feature code, Ticket, merge, Release, deployment or host permission change performed.

## T. Native Windows ProcessContainer startup and host-loopback egress falsification (2026-10-20)

This **supersedes §R's network-client startup blocker**, but **does not close the overall egress P0**. On the same explicitly selected paired native Windows 11 25H2 device `71b4b4d8-6496-4898-9b80-1ea3a03f6ccd`, ordinary Agent user, exact-pinned temporary `@microsoft/mxc-sdk@1.0.1`, each test used an isolated disposable `%TEMP%` project/cache. All ran with no administrator/elevation, global ACL/firewall/registry change, production Agent installation, second Worker or external/private LAN/metadata endpoint. The only network targets were synthetic Node HTTP listeners bound to `127.0.0.1` at random ports. Every Agent-owned session returned exit 0 and a cleanup marker; the temporary SDK/script/cache were removed.

### A. Isolated process startup compatibility — independently verified

Five bounded native `base-container` variants distinguish a **process startup restriction** from host networking:

| Sandbox request | Observed outcome |
| --- | --- |
| `cmd.exe /d /c echo RCA_CMD_OK`, standard deny-all | Exit 0; marker printed |
| `powershell.exe -NoProfile -NonInteractive`, default UI policy | Exit **-1073741502** (`0xC0000142`); no marker |
| Same PowerShell with **`ui.disable=false`** | Exit 0; marker printed |
| Same PowerShell with `ui.disable=false`, container-local `filesystem.readonlyPaths=[C:\\Windows\\System32]` | Exit 0; marker printed |
| `curl.exe --version` via `cmd.exe` with `ui.disable=false` and the same restricted container-local read policy | Exit 0; printed installed `curl 8.21.0` |

**Narrow inference:** The explicitly enabled UI policy was sufficient to resolve the observed PowerShell DLL-initialization failure in this controlled scenario; an actual network-capable `curl.exe` also starts with these options. **Do not conclude `ui.disable=false` is the least-privilege or production-suitable browser policy; disabling UI may be a desired requirement later and must be reviewed separately.** These filesystem rules authorize a path **inside the disposable sandbox policy only**, not a host-global ACL change.

### B. WFP direct egress with `hostLoopback=allow`: **FAIL**

Two independent loopback listeners represented allowed and forbidden ports. ProcessContainer `probe()` reported native `tier=base-container` with no errors/warnings for each configuration; `network.ingress.default=allow` and `hostLoopback=allow` allowed loopback use. Sandboxed `curl.exe` used explicit `--noproxy` to avoid relying on environment proxy configuration:

| Native request variation | Expected protected outcome | Actual server-observed outcome |
| --- | --- | --- |
| `egress.default=deny` + allow only `127.0.0.1/32:7307` | Permitted listener receives a request | **PASS:** allowed listener received `/allowed` |
| Same policy, curl `-L` follows `/redirect` to forbidden `127.0.0.1:7306` | Forbidden listener **0 hits** | **FAIL:** forbidden listener received `/forbidden`, curl rendered `RCA_FORBIDDEN_REACHED` |
| Same policy, direct curl to forbidden port | Forbidden listener **0 hits** | **FAIL:** forbidden listener received `/forbidden-direct` |
| Add **explicit `egress.deny`** for forbidden port (separate ephemeral ports) | Forbidden listener **0 hits** | **FAIL:** redirected `/redirect-target` and direct `/direct` each reached forbidden listener |
| Change **only `hostLoopback=deny`**, retaining explicit allow/deny | Allowed target reachable, forbidden denied | **NOT ACCEPTED:** **both** allowed and forbidden listeners received **0 requests**, so the required positive control fails |

**Security conclusion:** under this exact Windows host and MXC policy, `ingress.hostLoopback=allow` provided wider host-loopback connectivity than the intended egress port rule, and a standalone explicit deny rule did **not** repair the behavior. With `hostLoopback=deny`, the allowed host-loopback listener also became unreachable. **These tested direct-egress policies are disqualified for selective host-loopback authorization.** The observed results do not establish an all-address WFP flaw or prove what happens on a non-loopback synthetic network. No unrelated network endpoint was contacted.

### C. OS-scoped `network.runtimeConfig.networkProxy` mode: **narrow positive/negative PASS**

As a *test fixture only*, a temporary Node HTTP listener served as a deliberately simple proxy; a second listener represented an unrelated forbidden port. The **MXC V1 authoring API** requires `network.runtimeConfig.networkProxy`, not top-level `runtimeConfig` (an initial malformed request was rejected before creating a sandbox and then corrected). The tested request used:

```ts
network: {
  egress: { default: "deny" },
  ingress: { default: "allow", hostLoopback: "allow" },
  runtimeConfig: { networkProxy: "http://127.0.0.1:<ephemeral-proxy-port>" }
}
```

With the same restricted local filesystem policy and `ui.disable=false`, `probe()` returned **`base-container` with `baseContainerSupportsIdentitylessLoopbackProxy=true`**. Two real sandboxed `curl.exe` requests produced:

| Test | Actual outcome |
| --- | --- |
| Explicit curl proxy pointed at the designated listener | `curl` exit 0, response `RCA_PROXY_ONLY_OK`; **proxy received 1 absolute-form HTTP request**, forbidden target received **0** |
| Curl deliberately bypasses proxy via `--noproxy 127.0.0.1` and tries forbidden listener directly | `curl` exit 7 (`Could not connect to server`); **forbidden target received 0 requests**, proxy received no new request |

**Accepted claim, deliberately narrow:** a native Windows `base-container` on this owner's Windows host was able to reach an explicitly configured localhost **proxy endpoint** while an ordinary client *attempting direct socket bypass* failed to reach another simultaneously listening localhost endpoint. This validates **only** the concrete tested ProcessContainer proxy-only TCP path. No additional production proxy implementation, browser executable, credential store, system firewall modification or user-visible browser navigation was created.

**Major limitations:** This is the **identity-less, unpackaged host-proxy compatibility mode**: no OS-level peer identity binding, so an untrusted local process could race/spoof a configured proxy endpoint; it is not production-grade merely from its WFP endpoint test. The mock proxy returned a static response and performed **no** destination-resolution, DNS-rebinding, redirect-chain or HTTP body policy checks. The test used `curl.exe`, **not Chromium's network or child-process model**, and did not exercise WebSocket/UDP/WebRTC or IPv6. Neither effective-target authorization nor high-impact user-consent P0 is passed. MXC's [ProcessContainer networking guide](https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/networking.md#model-2-proxy-only-egress-recommended) distinguishes identity-less test proxies from bound identity approaches.

### Next smallest gate — do not commit to a second production service

1. **Retire these direct host-loopback egress policy variants** for public browsing; they have a measured sensitive-endpoint bypass. Preserve the live negative tests as regression evidence without repeating identical executions.
2. If conditional external navigation remains a required feature, perform an **explicit architecture/security trade-off review** before promoting proxy-only to production. It implies a long-lived and authenticated/identity-bound policy enforcement component, not merely a Playwright proxy flag. Prefer an existing system component or contained process over a second Worker or remote gateway; do not assume such a component is already available.
3. Before considering any real release, verify **actual Playwright Chromium plus subprocesses** under a no-bypass boundary and independently measured allowed/forbidden request targets, including nested redirects, DNS address changes, HTTP(S), WebSockets, WebRTC/UDP and IPv6. Enforce both source and destination policy and test proxy replacement/termination behavior, temporary Profile/IPC access, failure cleanup and revocation. Do not use the fake proxy proof as a substitute.
4. **One-use, exact-bound owner authorization is still a separate unverified P0.** Keep all external navigation and consequential browser effects disabled. The existing internal-only offline browser core may be tested without accepting a new production network architecture.

**Disposition:** Windows sandbox startup compatibility **PASS**; direct host-loopback policy **FAIL**; identity-less proxy-endpoint/no-direct-bypass TCP fixture **PASS in a temporary test only**; full browser-wide conditional egress P0 **NOT ACCEPTED**. This round introduced **no new implementation, ADR, Ticket, release, merge, deployment or host-global configuration change**.


## U. Real Windows Chromium inside native MXC BaseContainer — sandboxed browser startup blocked (2026-10-20)

**Direct continuation of §T, on the same user-authorized Windows 11 25H2 device** `71b4b4d8-6496-4898-9b80-1ea3a03f6ccd`. The prior MXC **proxy-only TCP** positive/negative fixture is **not** a browser-start or browser-wide networking result. This stage tested the next prerequisite: can the existing Chromium binaries start inside an actual native `base-container` without disabling their own sandbox?

### Strict test scope

- The installed `%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-1200\chrome-headless-shell-win64\chrome-headless-shell.exe` (**188,361,216 bytes**, Chrome for Testing **143.0.7499.4**) and cached full `chromium-1200\chrome-win64\chrome.exe` already existed. **No browser binaries were downloaded or replaced**.
- An Agent-owned Windows command installed exact-pinned `@microsoft/mxc-sdk@1.0.1` under a unique disposable user Temp directory; no SDK was installed into Agent, no release artifact changed, and the npm cache was under the same disposable directory.
- All test launches used **native `base-container` with no probe errors or warnings**, `ui.disable=false` as separately demonstrated in §T, `network.egress.default=deny`, `network.ingress.default=deny`, `hostLoopback=deny`, and an isolated disposable `--user-data-dir`. Filesystem access was granted **inside the container request only** to the cached Chromium executable directory and `C:\Windows\System32` (read), and the unique Temp test root (write). No real network target, personal Chrome Profile, remote-debugging port, `--no-sandbox`, global ACL, UAC or host firewall modification was used.
- **Target launch:** native `chrome-headless-shell.exe` with bounded offline `data:text/html` rendering and an expected `RCA_MXC_OFFLINE_CHROMIUM_OK` marker. The test did **not** call Playwright because the isolated raw browser executable itself had to pass first.

### Real results

| Native sandbox probe | Observed outcome | Verdict |
| --- | --- | --- |
| MXC `probe()` with the given deny-all network/profile/filesystem request | `tier=base-container`, no errors/warnings | **PASS — OS-tier request acceptance only** |
| `chrome-headless-shell.exe --version` | Exit 0, printed `Google Chrome for Testing 143.0.7499.4` | **PASS — binary can load and answer a non-rendering command** |
| `chrome-headless-shell.exe --headless --dump-dom data:text/html,...` | Immediate signed exit **-2147483645** (`0x80000003`, STATUS_BREAKPOINT), no HTML marker or diagnostic output | **FAIL — actual browser initialization/rendering** |
| `chrome.exe --version` from existing full Chromium cache | Exit **-1073741790** (`0xC0000022`, STATUS_ACCESS_DENIED), no version string | **FAIL — full Chromium startup/access** |
| Same tests with **sandbox-local read-only access expanded from individual Chromium executable directories to the whole `ms-playwright` cache parent** | **Unchanged**: Headless Shell offline render `0x80000003`; full Chromium version `0xC0000022` | **FAIL — simple parent-path grant did not solve compatibility** |
| Orphan and Temp cleanup | Both runs found **0 tagged Chromium processes**, removed their unique Temp directories/scripts/npm cache and reported exit 0 from the outer **diagnostic runner** | **PASS — bounded local cleanup** |

An attempt to read the Windows Application event log for a more specific browser faulting module returned `EVENT_READ_UNAVAILABLE=Exception`; no crash module was identified. **Do not infer a specific named-pipe, Mojo, GPU, DLL or Windows kernel defect from these exit codes alone.** The container may restrict one of those facilities, but the exact cause has **not** been established.

### Decision and acceptance boundary

- **Platform status:** Real *Chromium/Playwright inside MXC* **NOT ACCEPTED**. Because raw headless Chromium cannot render even fixed offline HTML under the tested native sandbox, a Playwright browser-context / ARIA / child-process test would not be a meaningful next acceptance without first repairing the sandbox startup compatibility. This does **not** invalidate separately passed Playwright+Chromium offline tests on Linux CI or raw Chromium offline tests on Windows **outside** MXC.
- Do **not** try to “pass” by using `--no-sandbox`, globally granting directory permissions, auto-elevating Agent, using a personal browser Profile, opening a remote CDP debug listener, silently launching Chromium **outside** MXC, or relaxing egress. Do **not** add a permanent proxy from the §T proof.
- **Next narrow engineering gate:** obtain trustworthy *deny-in-place* filesystem/process/IPC error evidence on this exact host using an already available OS/MXC diagnostic API and the least privilege needed; then fix the actual cause with a minimal, sandbox-local policy only if supported by evidence. [MXC ProcessContainer capture-denials](https://github.com/microsoft/mxc/blob/main/samples/run-with-logging-access-denied/node/src/main.ts) is a candidate, **not** validated on this Windows build, and its native capture implementation may be unavailable. Do not switch it to `mode=allow`.
- Once isolated Chromium **can actually render the offline marker**, verify Playwright with an **exact browser-binary/runtime match** inside the sandbox. Only afterwards use the proven §T proxy-only no-bypass fixture as a *candidate test* for Chromium child-process/network behavior. Full HTTP(S), redirect/DNS/subresource/WebSocket/UDP/IPv6 effective-target controls and one-use owner approval remain independent unverified P0 gates.

**State:** Draft research/real-device diagnostic only; no PR merge, new Ticket/ADR/worker, production release, device upgrade, permanent SDK/host config change or website access.
