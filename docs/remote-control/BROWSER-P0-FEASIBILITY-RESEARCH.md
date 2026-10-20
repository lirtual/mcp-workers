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
