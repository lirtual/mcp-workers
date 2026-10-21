# Remote Control Browser Automation — Specification Draft

## Current normative specification — Windows on-demand MCP browser (2026-10-22)

**Status:** Owner-confirmed Grill With Docs convergence; **documentation/Issue update only**. This section supersedes **all conflicting** earlier H1–H24 Windows handoff/idle decisions and Q1–Q52 legacy designs, which remain below solely as historical context. `ready-for-agent` is a triage label, **not** permission to merge, deploy, upgrade the installed Agent or enable production browser tools.

### Problem Statement

The owner of a personally paired Windows device wants ChatGPT to operate the **same visible, Agent-owned Chrome/Edge browser on demand through existing Remote Control MCP**. They may use it manually between tool calls, including logging in and changing tabs, without a formal Human Control/Agent Control handoff or an idle timer that suddenly closes their browser. The existing five staged browser tools can only start, navigate, inspect, check status and close; they cannot complete searches, fill forms or click controls. Existing H1–H24 control-state and activity-tracking complexity is not justified for this trusted single-user scenario.

### Solution

Keep a **single** direct `playwright-core` BrowserManager in the existing Windows Agent, reusing current Portal → Worker/DO → signed WSS → Agent transport, device pairing, `BrowserOperationGateway`, operation receipts and SQLite. Launch installed **current-user default Chrome/Edge** on a usable interactive Windows desktop with a **separate persistent Agent-owned Profile per browser family**; do not attach to the owner's normal personal Profile. Enforce **one live browser session per device**. `browser_start` creates or **reuses** the current live session; ordinary page/read tools do not silently create sessions.

The browser remains open until the owner closes its window, an authorized `browser_close` operation ends it, a revocation/Agent lifecycle explicitly cleans it up, or its process exits. **No 30/60-minute idle timer, 4-hour takeover timer, 24-hour lifetime, activity detector, control-owner state machine, `handoff` or `resume` tools.** No implicit auto-relaunch when closed. Keep the automation Profile and existing durable effect receipts after session closure.

The AI performs **bounded atomic MCP operations**. The Agent serializes all browser operations with existing locks and durable operation IDs; a remote `running` response never means its browser operation is complete. A user can manually operate the visible browser at any time, but Agent serialization **does not block human mouse/keyboard input or guarantee human-vs-AI mutual exclusion/privacy**. Encourage manual intervention between tool calls, not during an ongoing Agent sequence. No hidden promise of a Human Control privacy mode.

### User Stories

1. 作为设备所有者，我希望通过准确设备 ID 指定目标，以避免同名设备误操作。
2. 作为设备所有者，我希望首次显式启动时使用当前 Windows 默认 Chrome 或 Edge，以免反复配置。
3. 作为设备所有者，我希望 HTTP/HTTPS 默认浏览器冲突或不受支持时明确失败，以免错误选择。
4. 作为设备所有者，我希望已有浏览器会话由 browser_start 返回复用，以免重复启动。
5. 作为设备所有者，我希望仅有一个活动自动化会话，并隔离 Chrome/Edge Profile，以免冲突与泄露日常浏览器数据。
6. 作为设备所有者，我希望在当前 Windows 桌面看到浏览器，并可随时手动操作，以便登录、输入凭据或介入。
7. 作为设备所有者，我希望浏览器不因空闲或绝对寿命自动关闭，以免中断人工工作。
8. 作为设备所有者，我希望能够显式关闭浏览器，保留自动化 Profile 与操作回执，以便下次复用登录状态。
9. 作为 AI 操作者，我希望每次调用都核对会话和目标页，以免操作错误的浏览器标签页。
10. 作为 AI 操作者，我希望读取当前页面的有界 ARIA Snapshot，以定位可用控件。
11. 作为 AI 操作者，我希望在长页面中查找内容或取得聚焦观察，以免 8,000 字符截断阻碍操作。
12. 作为 AI 操作者，我希望能打开 URL、点击唯一目标和填写输入框，以完成搜索与表单准备。
13. 作为 AI 操作者，我希望发送受限的按键和选择下拉选项，以完成常见网页交互。
14. 作为 AI 操作者，我希望在需要时滚动页面、等待指定页面条件，以处理懒加载和异步页面。
15. 作为设备所有者，我希望列举、新建、显式选择和关闭标签页，以便把手动打开的网页交给 AI。
16. 作为设备所有者，我希望新标签页不被 AI 无声地当作旧目标，以防操作意外页面。
17. 作为设备所有者，我希望 MCP 工具操作逐个互斥，尤其 running 操作未完成时不得重入，以免重复副作用。
18. 作为设备所有者，我希望人工操作无需 handoff/resume，但知道 AI 并不具备识别人工输入或严格禁止并发的能力，以便合理协作。
19. 作为设备所有者，我希望每次新的效果性操作都重新核验当前页面目标，以免复用人工改动前的失效快照或引用。
20. 作为设备所有者，我希望网站内容始终按不可信数据处理，以防页面文本诱导设备工具执行其他指令。
21. 作为设备所有者，我希望结果未知的效果性操作不能自动重放，并可查询现有 SQLite 回执，以防重复提交。
22. 作为设备所有者，我希望高影响或含糊的外部网站效果在没有可验证单次批准时被拒绝，以防普通 MCP 权限导致付款、发送或删除。
23. 作为设备所有者，我希望用户手动关闭窗口或原始目标页时，Agent 清理失效状态、不自行重开或猜测目标。
24. 作为设备所有者，我希望 Agent 崩溃/重启后不会盲目接管遗留进程或删除 Profile 锁文件，以保护存量会话数据。
25. 作为设备所有者，我希望 Windows 锁屏时 AI 操作明确不可用，解锁后重新校验页面，以免操作不可靠。
26. 作为设备所有者，我希望断开 WSS 不会重启或重放浏览器操作，设备撤销仍可触发安全清理。
27. 作为维护者，我希望先以真实 Windows 有界面 Chrome/Edge 和隔离页面验证常用工具，再验证签名 MCP→Worker/DO→WSS→Agent 完整链路，以免误把源码测试当成生产就绪。
28. 作为维护者，我希望先补齐最小交互工具，截图及上传下载等复杂能力只在真实需求与传输验收后增加，以控制维护成本。

### Implementation Decisions

1. **Reuse existing architecture.** Existing single Agent BrowserBackend/BrowserOperationGateway, Portal/DO/WSS, signed device identity and SQLite operation receipt machinery; no new MCP Server, browser manager backend, remote desktop, UI overlay, control plane, page ledger, database, global OS hooks or code-execution API.
2. **Browser selection and Profile.** For new Windows sessions, current-user effective HTTP and HTTPS default associations must agree on a launchable supported Chrome/Edge; otherwise explicit unavailable. Select Playwright `chrome` or `msedge` in headed mode; no hidden headless fallback. Browser change after launch does not switch the live session. Chrome and Edge retain **distinct Agent-private persistent Profiles**; one active session **total** per paired device, including across browser families. Do not auto-download browsers.
3. **Session lifetime and entry points.** `browser_start` is idempotent with respect to an already live session (return current session/device/browser; no duplicate window); `browser_status` and `browser_snapshot` do not launch. No idle or absolute duration cleanup. Explicit close and real window/process close terminate in-memory ownership while retaining Profile/receipts. Lock screen blocks new Agent page operations when desktop unavailable. Temporary caller/WSS disconnect does not tear down a healthy Agent-local browser; Agent restart does not silently reattach to orphan Chrome/Edge or remove uncertain Profile locks.
4. **Target identity.** Every tool is bound to exact device and current session; page operations bind to an explicit stable target tab. Never use list index, URL, title, or latest foreground tab as implicit ownership. If the target was closed, report target-closed; list/select a different tab only on explicit owner/AI action. Newly opened tabs are not silently adopted. Before effectful target interaction, use a **fresh bounded semantic observation / locator resolution** and fail on ambiguous/stale targets; Snapshot version is useful for *detected* changes but not proof that the DOM was unchanged during all manual input.
5. **Operation consistency.** Preserve one Agent operation lock and existing SQLite operation IDs/receipts for all effectful browser commands, including navigation, clicks, fills, keypresses, select/scroll when effectful, and mutating tab operations. Enforce at admission and execution; when RPC returns `running`, keep the lock held until actual work resolves or produces a bounded Unknown. Do not auto-replay unknown website effects. Browser dispatch completion is not proof of website business completion.
6. **13 candidate core tools (five staged + eight additions).** Existing: `browser_start`, `browser_status`, `browser_navigate`, `browser_snapshot`, `browser_close`. Add: `browser_click`, `browser_fill`, `browser_press_key`, `browser_select_option`, `browser_tabs` (bounded list/select/new/close with operation receipts for mutating actions), `browser_find` (or equivalent bounded focused snapshot lookup), `browser_scroll`, `browser_wait_for`. Tool naming/count are the **proposed minimal logical surface**, not permission to add redundant wrappers: use native Playwright locator/auto-wait where sufficient and prove each exposed tool is needed for representative tasks. Do not introduce an unrestricted `browser_action` aggregator.
7. **Optional follow-on capabilities:** bounded `browser_screenshot` after MCP image/media transport and size acceptance; `browser_hover`, navigation back/reload, dialog handling, uploads/downloads only as genuine site requirements justify. File I/O must use the existing controlled files/permission boundary. Do not blindly enable unrestricted JavaScript, arbitrary Playwright scripts, raw CDP, Profile/Cookie export or the personal daily browser Profile.
8. **Security boundary.** Webpage content is untrusted instruction data; remote page state and MCP bearer are not high-impact approval. Website payments/sends/deletions and ambiguous consequential effects remain blocked absent independently verifiable, action- and target-specific single-use approval; failing this gate does not justify another approval service. User-approved trusted Windows Goal A retains residual redirect/DNS/subresource localhost/LAN risk: **not SSRF isolated**, not a general authorization to administer internal services. Direct initial URL hygiene and existing permissions stay in place.
9. **Product readiness boundary.** Current Draft PRs: [Agent #20](https://github.com/lirtual/remote-control-agent/pull/20), [Worker #143](https://github.com/lirtual/mcp-workers/pull/143), [Design #117](https://github.com/lirtual/mcp-workers/pull/117). Worker still keeps browser tool advertisement **disabled**. Prior Windows isolated tests have shown native headed Chrome/Edge and a local default-Edge Manager slice, but that slice was **not committed or pushed to the Agent PR**, and handoff-era code/schemas remain historical until updated. No claim of installed production MCP E2E, high-impact approval, or complete browser interaction acceptance.

### Testing Decisions

- **Primary acceptance seam:** reuse signed paired-device MCP → existing Worker/DO → WSS → Windows Agent → native headed Playwright with a disposable/isolated browser Profile. Test externally observable outcomes and operation receipts; do not build another browser harness or infrastructure.
- **Representative successful tasks:** open/reuse browser, navigate, snapshot and focused lookup, search with fill/Enter, click pagination, select/scroll/wait, create/list/select/close tabs, owner manually opens/changes page, AI explicitly targets selected page, status, explicit close/relaunch. Verify no 30-minute/absolute auto-close behavior, but do not wait real hours in tests; use controlled timer seams and process/event tests.
- **Negative/race cases:** double start, duplicate operation ID vs distinct same-effect IDs, `running` still in-flight, repeated effect after ambiguous timeouts, wrong/stale session or target, changed DOM and duplicate locators, owner closes original tab/window, Chrome/Edge Profile conflict, lock/unlock and WSS disconnect, process death and unsafe orphan/Agent restart, revocation, output truncation, unsupported browser defaults and unsupported URL targets.
- **Trust and consent:** page prompt injection cannot become a device authorization; no unverified high-impact actions; local/private-network redirect remains known residual risk, not a passing SSRF firewall. Test `serviceWorkers: "block"` site compatibility before locking in that choice; bound screenshots/downloads/uploads if separately approved.
- **Evidence:** distinguish local unit/typecheck, physical Windows GUI evidence, exact modified Agent candidate, full signed MCP E2E, built/installed release and production enablement. Release/rollout require separate explicit authorization.

### Out of Scope

Formal Agent/Human ownership, handoff/resume, idle/duration timers, human activity capture, global keyboard hooks, agent task orchestrator, generic multi-browser pool, automatic tab take-over, arbitrary JS/CDP/script execution, personal browser Profile attachment, browser/desktop streaming, new service/database, automatic effect replay, assumed independent human attestation, forced Session expiration, unapproved high-impact website actions, uncontrolled uploads/downloads, guaranteed SSRF isolation.

### Further Notes — design tree convergence

**Resolved product frontier (2026-10-22):** one reusable headed Windows Chrome/Edge browser session, 13 candidate bounded core tools, optional capabilities only upon demonstrated need, no forced session lifetime or manual takeover state. Historical H1–H24 decisions remain in the architecture review and design notes, and earlier broad Q1–Q52 choices remain in the archived section below; none overrides this section. Important admitted trade-off: user and Agent can physically interact concurrently; exact mutual exclusion and privacy during manual control are **not guaranteed**. Further user decisions are required only if testing reveals a genuinely different trade-off, not for ordinary schema/locator implementation details.

---

## Earlier broad-scope and handoff specifications (historical, non-normative)


> **Current phase-one specification amendment (2026-10-20):** The [architecture review](./BROWSER-ARCHITECTURE-REVIEW-20261020.md) is authoritative over the older CLI-first proposal. **One direct Playwright BrowserManager in the existing Agent** is preferred only after the minimal real Windows/WSL P0; reuse existing MCP device auth, receipts and dedicated Profile. Keep Worker/Agent Draft implementations disabled until separately accepted. Ordinary navigation is not guaranteed read-only. Consequential/ambiguous actions require verifiable one-use owner confirmation or remain disabled. Historic hostile-execution P0 is **deferred/unpassed**.


**Status:** Specification synthesis from the approved Grill With Docs decisions Q1–Q52 and post-convergence feasibility review. **Draft documentation; not a merge/deploy authorization.** Agent Draft PRs #15/#19 and Worker Draft #143 now contain source-stage code and tests, but are not a deployed/accepted browser MCP feature. The P0 test in the current architecture review is the next authorized planning gate, not automatic implementation approval.

**Source of truth:** Existing Remote Control Domain Context, browser-design decision tree and ADR-0021–0030. A proposal below must not override those owner-approved decisions. The attached feasibility-review findings are *unverified evidence requirements*, not already accepted implementation detail.

## Problem Statement

As an owner of paired remote devices, I want to ask ChatGPT to inspect and operate a **specifically selected browser** running on a paired Linux, WSL2 or native Windows Agent. Existing Remote Control tools can access files and managed processes but do not expose a verified, safely scoped, ordinary browser workflow. I should not have to set up another MCP Worker, expose a CDP port, hand over my everyday Chrome/Edge profile, manage a new approval website, or repeatedly configure a second filesystem/identity system. Browser actions can touch sensitive page data and cause irreversible external effects, so successful browser dispatch, genuine owner consent and website-side business completion must remain distinct.

## Solution

Extend the existing **Remote Control MCP → authenticated device routing → Agent** path with a curated set of **single-purpose browser tools**. The Agent uses a Playwright-compatible Chromium installation and a **dedicated, persistent Agent-local Automation Browser Profile**, with at most one active Browser Session per Profile and multiple explicitly identified tabs. It reuses pairing, device ownership, Agent OS permissions, managed local files and durable Operation ID/Receipt concepts. It **does not** become a remote desktop, general-purpose browser scripting service or an open CDP endpoint.

Every tool targets an explicit device and, as applicable, session and tab. Normal observation is semantic/accessibility-first with bounded results; screenshots are explicit and can expose sensitive information. Element actions require unique, fresh targets. Low-impact behavior must be affirmatively established; consequential or uncertain external effects are **not** executed on a model's assertion or an unverified chat “yes.” Any high-impact action requires a genuinely verifiable, short-lived, one-use, exact-operation owner confirmation, else it remains disabled.

A browser tool being **documented**, **implemented**, **accepted for a specific platform** and **currently enabled** are separate facts. The initial supported subset may be smaller than the overall intended ordinary browser workflow. Actual platform rollout is independently gated and separately owner-authorized.

## User Stories

### Pairing, targeting and lifecycle

1. As a device owner, I want to select a paired device by its exact identity, so that browser work never silently targets a similarly named device.
2. As a device owner, I want to start an isolated browser session on my chosen device, so that automation does not take control of my daily Chrome/Edge.
3. As a device owner, I want a consistent session ID for successive calls, so that I can resume the same workflow without opening duplicate browsers.
4. As a device owner, I want a stable tab ID that survives navigation but expires on tab closure, so that subsequent actions affect the intended page.
5. As a device owner, I want to list, create and close browser tabs, so that multi-page research does not require a new session for each tab.
6. As a device owner, I want my automation login state retained locally in its dedicated Profile, so that routine visits do not require logging in again.
7. As a device owner, I want the Agent to allow at most one active session per Profile, so that concurrent browser launches do not corrupt Profile data.
8. As a device owner, I want normal sessions to be headless unless I choose a headed browser and the device has a usable GUI, so that no desktop GUI is assumed.
9. As a device owner, I want a session eligible for closing after 30 minutes of inactivity without erasing my Profile, so that forgotten processes do not run indefinitely.
10. As a device owner, I want a transport disconnect to preserve inspectable session state, so that a network glitch does not cause hidden action replay.
11. As a device owner, I want deliberate Profile clearing only when there are no active sessions or unresolved operations, so that identity and receipts are not destroyed prematurely.
12. As a device owner, I want safe Agent/browser crash recovery or a clear conflict instead of forced Profile-lock deletion, so that persistent browser data survives uncertain conditions.

### Page observation and interaction

13. As a device owner, I want to navigate to an explicitly chosen HTTP(S) destination, so that I can inspect a public webpage or an appropriately authorized internal webpage.
14. As a device owner, I want sensitive destinations checked after redirects and address changes, so that the browser cannot silently move from a benign URL to an unapproved metadata or internal endpoint.
15. As a device owner, I want a focused semantic snapshot, so that ChatGPT can identify page controls without always sending whole DOM trees.
16. As a device owner, I want a clear indication when a semantic snapshot is truncated, so that I can request a focused continuation rather than relying on missing details.
17. As a device owner, I want an on-demand screenshot of the chosen tab, so that visual-only interfaces can be inspected when semantics are insufficient.
18. As a device owner, I want semantic locators to uniquely identify their current target, so that duplicated labels or old page state do not cause unintended actions.
19. As a device owner, I want stale screenshot coordinates to be rejected after page or viewport changes, so that a click cannot accidentally strike a new element.
20. As a device owner, I want independently scoped click, fill, select and keyboard operations when they are actually permitted, so that common browser workflows remain expressive without arbitrary script execution.
21. As a device owner, I want to understand whether ordinary browser workflows need a wait, dialog, scrolling, navigation-history or popup primitive, so that necessary interactions are supported without mirroring Playwright's entire API.
22. As a device owner, I want untrusted page text treated as observations rather than instructions, so that a website cannot authorize tools or override my workflow.

### Authorization, effects and resilience

23. As a device owner, I want genuinely low-impact browsing available without redundant prompts where safely established, so that common reads remain usable.
24. As a device owner, I want a consequential or uncertain-effect action rejected unless it meets the verified approval requirement, so that labels such as “Continue” cannot silently authorize purchases or deletions.
25. As a device owner, I want to inspect a proposed high-impact action before it executes, so that I know the exact device, tab, operation and significant parameters.
26. As a device owner, I want my authorization short-lived and single-use, so that changing targets, replaying calls or restarting Agents cannot silently reuse consent.
27. As a device owner, I want high-impact actions disabled if the current client cannot provide valid Agent-verifiable approval, so that missing consent infrastructure cannot be bypassed.
28. As a device owner, I want potentially effectful browser operations associated with stable Operation IDs and Agent-local receipts, so that I can query status after a timeout without issuing the effect again.
29. As a device owner, I want browser execution status distinguished from confirmation of a website-side transaction, so that a click returning success is never misreported as an order or message definitely committed.
30. As a device owner, I want failed, disabled, unaccepted, uninstalled and unauthorized capabilities reported truthfully, so that ChatGPT does not claim unsupported browser actions succeeded.

### Files, privacy and platform delivery

31. As a device owner, I want browser uploads to name an explicit Agent-local source and destination origin, so that filesystem readability alone cannot silently authorize external exfiltration.
32. As a device owner, I want downloads saved in a dedicated local directory using non-overwriting safe filenames, so that webpages cannot replace files outside the managed area.
33. As a device owner, I want downloads available through existing Remote Control file operations, so that I do not need another file manager.
34. As a device owner, I want unreferenced downloads eligible for removal after seven days but referenced or unresolved files retained, so that disk usage stays controlled without losing pending work.
35. As a device owner, I want sensitive page contents and screenshots excluded from routine operation logs, so that my local/browser secrets are not routinely preserved in Worker telemetry or Agent receipts.
36. As a device owner, I want compatible Chromium installed on demand from a source with verified provenance, so that automation does not depend on my personal browser or arbitrary binaries.
37. As a device owner, I want separately evidenced Linux, WSL2 and native Windows acceptance, so that an accepted Linux run is not mistaken for Windows compatibility.
38. As a device owner, I want previously valid unchanged tests reused when applicable, so that rollout evidence is credible without endless repeated verification.
39. As a device owner, I want independently gated safe capability enablement rather than an all-platform, all-feature release requirement, so that verified functionality can progress without weakening consequential-action safeguards.
40. As a device owner, I want design acceptance separate from implementation, issue creation, PR merge and deployment approval, so that the documentation review cannot silently authorize production changes.

## Implementation Decisions

These are **accepted architecture/product constraints**, not precise unchecked code/interface commitments:

1. **Ownership seam:** use existing paired Remote Control MCP routing, device authentication and Agent-local executor. No new standalone Browser MCP Worker, publicly reachable CDP, nested Playwright MCP server or remote desktop.
2. **Runtime seam:** encapsulate direct Playwright library usage behind a small Agent browser capability adapter; launch compatible Chromium against the dedicated managed Profile. Avoid exposing generic page JS, arbitrary Playwright code or unbounded action routers.
3. **Single Profile/session rule:** initially one persistent automation Profile per paired device and one active browser session per Profile, with multiple tabs; preserve the Profile through session idle cleanup and disconnect.
4. **Identity:** require explicit `device_id`; require `session_id` and `tab_id` only for operations that target them. Reuse existing device/session error handling rather than creating a new global capability registry.
5. **Tool surface:** initial feature coverage comprises session lifecycle/status, tab lifecycle/list, navigate, semantic snapshot, screenshot, click/fill/select/keyboard and browser-scoped upload/download result access; exact atomic names and additional truly necessary UI primitives need a separate focused interface check.
6. **Selectors:** semantics/accessibility and unique targeting before effects. Visual fallback uses a recent screenshot bound to actual tab/page/viewport/scroll/layout state; fail and refresh on ambiguity or freshness loss.
7. **Observation:** bounded, task-relevant snapshots with an initial ~8,000-character default, explicit truncation and follow-up focused reads; initial screenshots are explicitly requested one at a time. Actual byte budgets, crop/format and privacy semantics remain technical contracts to verify.
8. **Authorization:** pairing and user identity do not alone authorize sensitive browser effects. Every high-impact external change needs an exact-action, short-lived, single-use owner confirmation provably available and checked through the real ChatGPT/MCP/Worker/Agent path. No such path is established by this specification; deny if unavailable.
9. **Low-impact scope:** status/listing, bounded observation and requested screenshots are only *candidate* low-impact capabilities; navigation requires network/effect assessment. Generic click/fill/select/keyboard are not automatically low-impact due to tool name or webpage label.
10. **Network:** normal navigation targets HTTP(S), not `javascript:`/`file:`; changed effective redirect/DNS targets must be revalidated, while internal/loopback/link-local/metadata endpoints require distinct authorization and safety review. A top-level URL check is insufficient proof of browser-wide egress security.
11. **Effect receipts:** extend the existing durable Agent Operation ID/Receipt contract for browser effects, with unknown outcomes and no blind replay. Browser action receipts do not certify website-side business success; separately read-only website evidence can be recorded when reliable.
12. **Files:** uploads use explicitly selected Agent-local source paths and consequential target origins under existing OS and Remote Control authorization. Downloads stay in a dedicated local directory with collision-safe no-overwrite creation and traversal/symlink protections. Normal owner-directed file changes reuse existing tools.
13. **Retention:** Agent-local downloads are eligible for cleanup after seven days only if positively unreferenced, respecting active sessions/unresolved receipts. Profile clear requires safe state and deliberate owner request.
14. **Privacy:** avoid routine collection/log persistence of whole DOM, screenshots, passwords, cookies, tokens and secret-bearing tool arguments. On-demand browser results may still contain sensitive data and must never be treated as trusted instructions.
15. **Supply chain:** prefer Playwright's version-compatible on-demand Chromium installation/cache, subject to real artifact provenance and platform dependency evidence; no custom browser CDN/registry by default.
16. **Availability:** distinguish documented, source-implemented, platform-accepted and enabled capabilities; enforce status and authorization at execution, not merely through UI tool advertisements.
17. **Scope discipline:** defer personal Chrome/Edge Profile attachment and macOS. Do not add a general workflow orchestrator, new durable website transaction ledger, approval portal, second file manager or cloud media repository unless a genuine unresolvable requirement is reviewed and separately accepted.
18. **Release governance:** implementation, development issue/Ticket publication, acceptance execution, CI changes, merges and platform deployment each require separately scoped approval. The current Draft PR and this draft spec do not constitute that approval.

**Recommended adapter/test seam, pending implementation-planning confirmation:** prefer **one highest useful end-to-end seam**: a named MCP tool call on a specifically paired device flows through the existing authenticated Worker/DO router to a bounded Agent browser adapter and a controlled test webpage; verify authorization, exact target, observable result and receipt/status behavior across that path. Add narrowly scoped unit/contract tests *only* where necessary for independently risky boundaries (address classification, screenshot size, file naming, one-use approval). Do not introduce a new test server/service architecture merely to exercise the design.

## External Agent-browser reference — non-normative review (2026-10-20)

[CitroLabs ego-lite](https://github.com/citrolabs/ego-lite) was assessed as an *optional design reference*, not a second browser implementation or approved source dependency. The source/issue analysis and qualifications are recorded in [P0 Research §S](./BROWSER-P0-FEASIBILITY-RESEARCH.md#s-external-agent-native-browser-reference-citrolabs-ego-lite-2026-10-20). **All 18 Implementation Decisions above stay authoritative and unchanged.**

Possible **future engineering checks within the existing accepted constraints**, not additional tools, implementation authorization or completed acceptance:

1. **Actionable Snapshot refs:** test unique identities scoped to device/session/tab/frame/document/node (including OOPIF), focused semantic output, explicit truncation, invalidation after document/target changes, and **no automatic fallback** for stale or ambiguous refs. Preserve the original Q43 approximate 8,000-character default and privacy bounds.
2. **Owner takeover:** define a minimal session-side paused/owner-in-control state and a safe resume path only if existing session/receipt semantics can carry it. Verify Agent mutations stop during takeover and resume only when allowed. **This is separate from Q23/Q38/Q51 exact-bound one-use proof for any high-impact operation; do not treat a takeover or chat message as such approval.**
3. **Efficiency without elevated scripting:** measure real MCP round trips and repeated snapshot cost before optimizing. Prefer focused reads and Playwright-native waits. Potentially group already-validated atomic actions internally only after a distinct contract/security review; **no arbitrary JS, raw CDP, unrestricted Node fetch or generic batch dispatcher** is introduced by this research.
4. **Profile and lifecycle:** retain the **separate persistent Automation Profile** (not a shared personal Cookie store); one active session per Profile, 30-minute idle cleanup eligibility, no silent profile wipe, and no automatic inheritance of personal Chrome/Edge credentials. Audit cleanup under failed, interrupted and handed-off tasks.
5. **Negative security acceptance:** keep the existing OS-enforced browser egress P0 and genuine one-use authorization P0 independent. Ego Lite's Task Spaces, open-source helper code and vendor benchmarks **do not demonstrate** safe public network routing, cookie isolation under a shared profile, or end-to-end Remote Control permission. Any optional personal-browser backend needs a separate accepted design and real permission/credential tests.

**Scope:** this comparison changes **neither** the first-release atomic tool inventory nor the current rollout gates; there is no new implementation Ticket, ADR, PR merge, release or deployment. Actual Windows MXC BaseContainer startup in [research §R](./BROWSER-P0-FEASIBILITY-RESEARCH.md#r-actual-windows-basecontainer-launch-and-wfp-fixture-attempt--process-startup-blocks-network-acceptance-2026-10-20) passed for `cmd.exe` only, while conditional WFP network traffic enforcement remains not accepted; do not advance it based on the external comparison.

## Testing Decisions

Acceptance tests must assert **externally observable behavior and refusal/recovery**, not internal Playwright method calls or private class structure. Reuse existing paired-device transport and operation-receipt coverage as prior art; do not equate prior acceptance with browser acceptance.

1. **Target/identity:** ensure wrong or ambiguous device, session and stale tab identifiers cannot execute in another browser.
2. **Profile isolation:** verify automation never silently opens the owner's everyday personal browser Profile and does not create two active sessions for one Profile.
3. **Session lifecycle:** verify reuse, explicit close, approximately 30-minute idle eligibility and preservation of Profile data across cleanup.
4. **Disconnect/restart:** query unknown or interrupted operations after lost responses, never silently replay, and fail safely on unresolved Profile locks.
5. **Semantic observation:** validate focused snapshot limits, explicit truncation, unique locator resolution, ambiguous target rejection and output privacy.
6. **Visual observation:** validate screenshot round trip **Agent → DO/Worker → MCP → ChatGPT** within measured request/response constraints, with actual media type, oversize handling and no default secret-bearing logs.
7. **Visual target freshness:** reject stale screen targets after navigation, tab close, scrolling, resizing, layout changes and uncertain state.
8. **Browser-wide network safety:** test redirects, DNS changes/rebinding, loopback/private/link-local/metadata targets, frames, XHR/fetch, WebSockets and Service Workers; assert no false “blocked” claim based only on navigation URL parsing.
9. **Effectful classifications:** test benign-looking labels that commit actions and ensure undefined safety means denial rather than model judgment.
10. **Owner consent:** on a real supported ChatGPT client, validate prepared action, explicit owner intent, exact target/args binding, expiry, one-time consumption, replay denial, changed/absent proof rejection and disconnected/restarted status. If proof cannot be carried, high-impact capability is a non-releaseable feature.
11. **Receipts/business evidence:** browser-level completion is kept separate from a website-side success signal; uncertain outcomes remain unknown, never automated retried.
12. **Files:** reject path traversal, overwrite, symlink escape, unexpected sensitive source, changed upload destination and unsafe binary transfer; test seven-day cleanup protects referenced/unknown files.
13. **Normal browser workflows:** demonstrate selected login, search, form preparation, popup/dialog and download scenarios using actual available atomic tools; report genuine missing primitive rather than adding a generic dispatcher.
14. **Browser installer:** verify matching runtime browser artifact provenance/integrity and clear fail-closed behavior offline or on untrusted/mismatched download.
15. **Platform boundaries:** independently demonstrate relevant Linux, WSL2 and native Windows browser startup, interaction, filesystem, security denial, upgrade and rollback. Reuse unchanged prior evidence only when the relevant behavior did not change.
16. **Capability accuracy:** verify unsupported/uninstalled/unaccepted/disabled actions are not advertised or reported as usable, including errors on refusal.
17. **Release:** no production enablement without applicable real-platform evidence and separate owner approval; the existence of this draft spec does not pass any gate.

## Out of Scope

- Remote OS desktop, generalized GUI mouse/keyboard control, window manager or screen sharing.
- Public CDP/WebSocket browser-debugging listeners, arbitrary JavaScript evaluation or exposing an unrestricted Playwright gateway.
- New standalone browser MCP Worker, additional device fleet/identity system, approval portal, capability registry or website transaction ledger.
- Automatic connection to the owner's personal Chrome/Edge Profile or using its existing cookies (possible separately authorized future capability).
- Multiple automation Profiles per device, parallel browser sessions on a single Profile and generalized profile provisioning UI.
- macOS initial support.
- Silent browser OS-level privilege escalation, custom Chromium distribution platform or unverified binary fallbacks.
- Promising exactly-once external website effects or equating click success with a committed transaction.
- Global site allowlist configuration, unsupported claim of whole-browser network safety based on only top-level navigation filters.
- Bulk PDF/ZIP/image transfer from the Agent to ChatGPT without separately verified size/media/authorization contract.
- Persistent logging of arbitrary page content, screenshots or credentials by default.
- Automatically writing runtime code, development Tickets, CI changes, merging, deployment or publishing this spec to a tracker.

## Further Notes

**Post-research factual update (not implementation approval):** [P0 research](./BROWSER-P0-FEASIBILITY-RESEARCH.md) now includes a safe local ephemeral Playwright probe and read-only plugin discovery. The connected Remote Control tool surface did not expose browser actions or an approval-proof test. A synthetic loopback HTTP redirect test was **blocked by this sandbox's administrator policy before reaching the route callback** and is **inconclusive** for project network security; no Remote Control device command was run. Offline small-page screenshot generation (PNG 12,063 B; JPEG 10,553 B) is **not** an MCP image round-trip. Also, existing DO dispatch has a 5-second timeout, so browser reads/effects will need explicit operation lifetime/error handling rather than assuming current remote file-read semantics are sufficient. All P0 gates remain unverified.

**Latest exact-device acceptance checkpoint (2026-10-20):** [P0 research §I](./BROWSER-P0-FEASIBILITY-RESEARCH.md#i-live-windows-isolated-chromium-baseline-and-controlled-redirect-fixture-2026-10-20) supersedes prior `read-only` Windows Agent and `Stage 0 PARTIALLY QUALIFIED` notes. The upgraded native Windows Agent and merged/released Worker path now support real Shell/file operations. **Disposable Chromium headless launch and offline HTML rendering PASS**, with no test process/Profile left behind. **Controlled loopback fixture PASS as a baseline only:** Chromium visited a synthetic HTTP 302 target (`/public` → `/simulated-sensitive`) and each endpoint received one request. No real browser request-denial policy existed; therefore the **Q45/Q49 effective-target network-safety acceptance is NOT IMPLEMENTED / UNVERIFIED**, not passed. The connected Node runtime cannot resolve `playwright` and current MCP does not advertise browser-specific tools or action-bound approval verification, so **high-impact owner-authorization P0 remains NOT TESTABLE**. Do not add a new approval service, disable network checks, install packages or enable external-effect browser tools without separately reviewed implementation and safety evidence.

**Critical feasibility gates before any affected capability may be activated:**

| Gate | Status at document creation | Required evidence |
| --- | --- | --- |
| Agent-verifiable owner approval | **Unverified** | Real supported client and MCP→Worker→Agent single-use owner intent validation; deny until proven |
| Browser-wide egress control | **Unverified** | Real request coverage beyond initial navigation, including redirects, DNS, internal targets and Service Worker |
| Screenshot MCP image transport | **Unverified** | Bounded binary/image round trip across existing message limits, including oversized results |
| End-to-end tool usability | **Unverified** | Controlled realistic workflows and exact tool inventory gap assessment |
| Upload/exfiltration permission | **Unverified** | Explicit source and destination intent with denial of unauthorized uploads |
| Binary download access | **Local-only direction accepted; remote delivery not proven** | Clearly report unsupported remote binary transfer until bounded authorization/media contract passes |
| Browser provenance/OS acceptance | **Unverified** | Genuine compatible browser artifacts plus independent Linux/WSL2/Windows evidence |

**Open technical contract work is not an invitation to invent a new product decision**: exact screenshot encoding/size, approval TTL and transport proof, final tool argument schemas, page freshness algorithm, safe network interception strategy and per-platform detailed test cases require evidence. A discovered irreconcilable product trade-off returns for owner decision before code. This spec does not silently choose those unknowns.

**Spec publication boundary:** The Matt Pocock `to-spec` workflow usually publishes a spec to an issue tracker with a `ready-for-agent` label. In this project, earlier explicit owner constraints prohibit creating development Tickets and authorize documentation-only Draft PR work. Therefore this artifact is deliberately a **reviewable spec draft within the existing Draft PR**, **not** a new Issue or agent-executable ticket. Publishing or applying `ready-for-agent` requires separate owner authorization.
