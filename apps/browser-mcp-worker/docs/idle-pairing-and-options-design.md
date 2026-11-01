# Browser MCP — bounded idle pairing and minimal Profile UI

Status: Owner-approved design (2026-10-31), source merged in PR #644 and **v0.2.6 production Worker released**. Native Chrome/Edge v0.2.6 connection and scoped browser tool E2E passed; natural 14-day expiry and native Rename/Options acceptance remain unperformed (see Spec #626 evidence). Cross-product online-reset clarification 2026-11-01 is documentation, not a new deployed code change.
Spec: [#626](https://github.com/lirtual/mcp-workers/issues/626).
Scope: An increment to [#418](https://github.com/lirtual/mcp-workers/issues/418) and completed [#531](https://github.com/lirtual/mcp-workers/issues/531). The newer design overrides only the indefinite **permanent** grant lifetime, Profile naming/discovery and Options presentation; the Access activation proof, Stop/Revoke priority, temporary mode, sensitive grants and Operation/Unknown contracts remain intact.

## Goal and terminology

An Endpoint is a browser **Profile** installation, not a physical device. `Extension Grant` is pairing authorization; `Browser Control Session` is owner-selected ON/OFF; `Connection` is separately observed transport readiness. A valid Cloudflare Access SSO session may satisfy owner identity without a new email OTP; the OTP and Cloudflare Access SSO are separate from the remembered-grant idle window.

Replace the user-facing "Permanent" pairing label with **Remembered (14-day idle expiry by default)**. Keep the existing internal `permanent` mode value for compatible migration, and retain **Temporary (browser session)** as a separate option. Do not add an Options TTL slider, renewal buttons, periodic forced OTP, or another management service. The **single server deployment setting** described below is the only duration override.

## Deployment configuration (single reviewed GitHub Actions Variable)

- **Variable:** `BROWSER_REMEMBERED_IDLE_DAYS` in the existing `browser-mcp-worker` GitHub **Environment Variables** (not a Secret and not an ordinary `workflow_dispatch` input).
- **Default:** `14` days when the variable is unset or empty. The Worker also uses `14` as its explicit fallback when no binding is present. One day is 24 hours of trusted server time; the default is `1,209,600,000` ms.
- **Validation:** accept decimal integers `1` through `90`, with no signs, whitespace, fractions, nonnumeric values, or negative/zero durations. Invalid nonempty values **fail the existing release preflight** and Worker initialization/requests fail closed rather than silently widening the deadline. This is a deployment constant, not a local/user-controlled duration.
- **Pipeline:** wire the existing `release.yml` selected Worker release step's `vars.BROWSER_REMEMBERED_IDLE_DAYS` into the existing **explicit allowlist** in `scripts/worker-release-variables.mjs`, then the existing Wrangler `--var BROWSER_REMEMBERED_IDLE_DAYS:<days>` path. No second release workflow, dynamic GitHub API read, new service or ongoing GitHub polling. Absence must not require creating a GitHub variable. Changing the value requires a new **Owner-authorized production release**; editing a GitHub Variable alone does not change deployed behavior.
- **Existing deadlines:** a changed setting applies to **newly started** OFF/offline deadlines and first-release migration, not retroactively to already persisted absolute deadlines. Do not reset or extend them merely because configuration changes. Successful, independently owner-verified OFF→ON still clears an unexpired deadline as already specified.
- **Separation:** the setting does not change existing Access SSO/OTP, session-only temporary pairing/its 24-hour lease, heartbeat intervals or ON-and-online no-countdown behavior. The UI shows the actual server-returned expiry rather than assuming the default when customized.

## RCA / Browser shared online-reset interpretation — confirmed 2026-11-01

The owner confirmed [RCA idle-grant Grill](https://github.com/lirtual/mcp-workers/pull/664)
should use the **same effective online reset** for RCA permanent grants and
Browser remembered Profiles. This is a clarification of the existing
ON-online/no-countdown design, not a new sliding expiration on every ping.

- If **owner ON + authentically ONLINE**, there is **no** active idle
  countdown, including after a pre-expiry recovery. The device/Profile may
  stay connected for months without any remote operations.
- When that live authenticated online session **truly becomes OFFLINE**, start
  a **fresh full configured interval** from the last trustworthy
  server-observed online point. A later genuinely online session followed by
  another disconnection starts another full interval; it is **not** limited by
  the earlier cancelled offline deadline.
- A currently **OFF** Profile never auto-renews by appearing online or
  retaining stale ON storage. First explicit OFF creates one stop deadline
  only; repeated Stop, late callback or reconnect cannot push it later.
  Only the existing verified owner OFF→ON flow **before** expiry can clear it.
- The Worker must infer offline at bounded trusted checkpoint precision,
  not silently trust an old connected_at, local wall clock, open-but-stale WSS
  or frequent MCP reads. Persist last verified online evidence as needed
  without writing to DO storage on every heartbeat. Expiry always takes
  precedence at authorization boundaries.

This is **shared semantics**, not shared code/database. Browser still uses
its extension toolbar and Access proof; RCA uses separate owner-local
service controls and signed WSS. Each release-time variable remains
separate and each product retains its own temporary mode. This cross-product clarification changes **documentation only**. Current
Browser v0.2.6 production behavior was already implemented by PR #644 and
must not be represented as an unshipped design; independent elapsed-time and
native Options/Rename evidence are still outstanding in #626.

## Confirmed state machine (remembered pairing only)

All timestamps and deadline comparisons are server authoritative; Options renders dates in the browser's local timezone.

| Event | Effective grant / deadline | Control outcome |
| --- | --- | --- |
| First owner-verified pairing and successful ON | No countdown while ONLINE/ready | Existing Access + same-Profile one-use proof and version checks apply |
| Explicit ON -> OFF (local toolbar or authorized remote Stop) | Begin a single OFF deadline at server-confirmed transition + configured idle days | Immediately deny local work, close WSS, cloud Stop; retries/repeated Stop do **not** extend the deadline |
| OFF -> ON before deadline, by local toolbar | On successful owner-verified activation, clear OFF deadline; restore the full configured idle allowance | New one-use activation challenge; reuse valid Access SSO only if accepted by Access |
| ON + healthy authenticated WSS | No countdown, even if no browser tasks | Does not require user clicks, traffic or daily reauthorization |
| ON + disconnected / stale heartbeat | Start a **fresh full interval** from the latest credible server-observed online activity (not original pairing/connection); after genuine online recovery the former cancelled deadline is irrelevant | No tool execution while offline; a legitimate authenticated automatic reconnect *before* expiry clears offline countdown without changing owner-selected ON |
| OFF / disconnected countdown reaches its configured deadline | Expire and revoke the **old** Endpoint grant; reject its credential and all later admissions | Re-pair through Access and local proof to create a new grant; do not silently resume |
| Temporary mode | Existing browser-session storage plus bounded DO lease/reconnect grace | **Unchanged**, not subject to remembered-mode idle rule |
| Explicit Revoke | Immediate final revocation | No old grant resurrection or automatic replay |

Important distinctions:
- ON in extension storage is an **intent**, not proof of server permission, connection, or browser readiness. A browser crash, single-window close, MV3 service-worker sleep or brief reconnect must not flip intended ON to OFF or treat a transport flap as a new local ON.
- An authenticated WSS session/heartbeat supplies recent connection activity; `updated_at` currently also changes for other state transitions and **must not** be used as last-seen truth. A genuinely stale socket cannot keep an Endpoint alive merely by remaining in the socket collection.
- For silent disconnects, compare last authenticated liveness timestamp with server time. No heartbeat/client wall clock can forge renewal. Prefer reusing WSS attachment and bounded persisted checkpoint when needed, not per-ping DO storage writes.
- For OFF, only the initial actual transition starts the deadline; repeated Stop, delayed Stop reconciliation, failed Access attempt, background reconnect or MCP read must not reset it. If an OFF is delivered while an older offline deadline exists, never extend past the older deadline.
- OFF->ON requires *successful* owner verification, not clicking ON or a pending challenge; failed/cancelled activation leaves the prior deadline unchanged.
- Remote MCP cannot Resume, change alias, or refresh/grant a lease. Expiry cannot be undone by late callback, recovered socket, DO restart, old session state, or extension reinstall carrying old credentials.
- Existing `stop_epoch`/`revision`/`generation` fences and intent/Unknown protections stay authoritative; already dispatched website side effects cannot be undone by Stop or expiry.

## Minimal implementation boundary

Reuse the owner-scoped SQLite Durable Object, current `endpoints` record, existing `lease_expires_at` / `offline_deadline` semantics and DO Alarm scheduler where possible. Extend lifetime checks and expiration sweeps to remembered grants, including **stopped** grants (current expiry logic covers temporary enabled grants only). Persist the least additional server-observed connection timestamp needed for silent disconnect classification. Avoid a new database, worker, queue, Cron, client background polling or second CI path.

Enforce expiry consistently on Endpoint list/state, activation-begin/complete, WSS authentication/frames, read admission, mutation prepare and execute. For the expected deadline, a DO Alarm may change durable state promptly; authorization admission must also check the deadline even if the alarm was delayed. Failure to set a needed expiry alarm must fail closed rather than leave a grant indefinitely valid. Historical Operation Receipt and Unknown anti-replay facts outlive grant revocation subject to their existing retention policy.

Migration at the first compatible release: existing revoked identities stay revoked; valid remembered OFF identities receive a one-time `migration_time + configured idle days` deadline; valid ON-online identities keep their present ON intent without an immediate idle deadline; ON-offline identities begin a bounded offline deadline from observed evidence or migration time (never invent an earlier last-seen event). Preserve Endpoint ID, local credential, owner name, previous Stop, receipts and protected-surface denial. Old incompatible extension versions fail closed; publication of Worker does not auto-update the installed extension. Rollout and real browser upgrade need separate owner authorization.

## Endpoint naming, discovery and management

- Keep the existing `alias` field (max 64 characters) but add **Rename** in the trusted local Options document, with authenticated extension-to-Worker update restricted to its own Endpoint credential. Validate length/content and retain the current name on failure; do not add MCP remote rename.
- Suggested default alias may combine reliably detected browser family and generic platform, e.g. `Edge · Windows`; avoid OS hostname/serial, Chrome Profile folder names, any device fingerprint or unreliable inference. User-supplied labels like `Work PC · Edge` override defaults.
- Continue to require the stable full `endpoint_id` in action calls; present user alias + browser + a short distinct ID for conversational selection, and reject ambiguous aliases rather than guessing.
- `browser_endpoints` should show canonical authorization (including expired), online and readiness as **separate** facts, browser/platform/version only if actually observed and a truthful server-side `last_seen_at` not `updated_at`. Keep the full UUID in the underlying result. Avoid exposing raw local profile paths or credentials.
- Default list includes usable and still-paired OFF/offline Endpoints, not revoked/expired history. An optional explicit history query on the **existing** listing tool can reveal revoked/expired identities without a new tool; never let a blanket latest-100 history limit evict active entries. Any capacity quota should count only presently valid pairings.
- Detect and label stale versions without claiming an offline Endpoint is executable; users can say "Use Work PC Edge" but the agent must confirm exact ID where names collide.

## Minimal Options and icons

Keep the toolbar icon as the sole normal ON/OFF action. Options shows (1) editable Profile alias, browser + short ID, (2) meaningful ON/connecting/ready/OFF/expired/stop-pending status, (3) **OFF/online-dependent** idle remaining time or "No countdown while online", (4) remembered/temporary selection **only before initial pairing**, (5) optional LAN/private **session-scoped** grants, (6) separate Revoke with confirmation and (7) collapsed Diagnostics.

Remove verbose repeated static instructions, default raw UUID, socket generations and receipt prose from the main view. Remove the duplicate default `Stop locally` button; leave a clearly discoverable Stop recovery control when toolbar fails or cloud Stop is pending. Show the "Acknowledge verified cloud revocation" action **only** when an outstanding, independently verified revocation requires it; never imply acknowledgment performs cloud revocation. Display Unknown/pending warnings prominently **only when nonzero or unavailable and consequential**, with detailed evidence under Diagnostics. Keep `Locate observed tab` as contextual diagnostic only.

Use small consistent line SVG icons, not another icon package. Badge/tooltips include words so state is not encoded only by color; keep Revoke labeled and confirmed. Ensure Chrome/Edge Options keyboard access, focus/ARIA status announcements and narrow-window layout. No default Popup, no additional main buttons.

## Acceptance seams and realistic validation

Prefer existing extension VM and Worker/DO fixtures, then one scoped native Chrome and one Edge version-matched flow. Test **changed** behavior and prior directly affected invariants; do not replay all of #418.

1. Fresh remembered pairing, owner SSO reused vs OTP requested by Access, meaningful alias and name update across list/local UI.
2. OFF starts exactly one configured deadline; repeated/local/remote/offline-reconciled Stop cannot extend it; before deadline owner ON succeeds and restores configured allowance.
3. ON+live stays valid beyond 14 days without browser tasks; a heartbeat-stale/disconnected ON expires after the configured idle duration, while brief disconnect and MV3 sleep do not misclassify permanently.
4. Deadlines enforced without timely Alarm, including stale WSS, late activation callback, Stop-vs-reconnect, DO restart and previous generation; expiry requires new grant.
5. Migrated revoked/OFF/ON-online/ON-offline records retain correct identity and receipts; no stale old-client bypass; default listing excludes history without hiding valid old entries.
6. Temporary mode's 24h lease, browser-session invalidation, reconnect grace and explicit sensitive grants remain unchanged.
7. Options normal/error states, name collisions, icon state and accessible controls on installed Chrome and Edge.
8. Release-time duration contract: variable absent/empty = 14, configured 7/30/90 accepted, 0/91/negative/noninteger/whitespace rejected by the existing release gate and runtime; the Worker and extension present the actual persisted deadline; changing the GitHub Variable alone does not change the running release or rewrite existing deadlines.

No new production release, Access policy edit or credential rotation is authorized by this document. Evidence must separate code/CI, extension ZIP, Worker release, installed Chrome/Edge version and live owner actions. Known prior Waivers remain Waivers, not retroactively Pass.
