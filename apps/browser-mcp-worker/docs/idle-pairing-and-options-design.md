# Browser MCP — bounded idle pairing and minimal Profile UI

Status: Owner-approved design consensus (2026-10-31). **Design only; not implemented, merged or deployed.**
Spec: [#626](https://github.com/lirtual/mcp-workers/issues/626).
Scope: An increment to [#418](https://github.com/lirtual/mcp-workers/issues/418) and completed [#531](https://github.com/lirtual/mcp-workers/issues/531). The newer design overrides only the indefinite **permanent** grant lifetime, Profile naming/discovery and Options presentation; the Access activation proof, Stop/Revoke priority, temporary mode, sensitive grants and Operation/Unknown contracts remain intact.

## Goal and terminology

An Endpoint is a browser **Profile** installation, not a physical device. `Extension Grant` is pairing authorization; `Browser Control Session` is owner-selected ON/OFF; `Connection` is separately observed transport readiness. A valid Cloudflare Access SSO session may satisfy owner identity without a new email OTP; the OTP itself never lasts 30 days.

Replace the user-facing "Permanent" pairing label with **Remembered (30-day idle expiry)**. Keep the existing internal `permanent` mode value for compatible migration, and retain **Temporary (browser session)** as a separate option. Do not add adjustable TTLs, renewal buttons, periodic forced OTP, or another management service.

## Confirmed state machine (remembered pairing only)

One day is exactly 24 hours of server time; 30 days = 2,592,000,000 ms. All timestamps and deadline comparisons are server authoritative; Options renders dates in the browser's local timezone.

| Event | Effective grant / deadline | Control outcome |
| --- | --- | --- |
| First owner-verified pairing and successful ON | No countdown while ONLINE/ready | Existing Access + same-Profile one-use proof and version checks apply |
| Explicit ON -> OFF (local toolbar or authorized remote Stop) | Begin a single OFF deadline at server-confirmed transition + 30 days | Immediately deny local work, close WSS, cloud Stop; retries/repeated Stop do **not** extend the deadline |
| OFF -> ON before deadline, by local toolbar | On successful owner-verified activation, clear OFF deadline; restore the full 30-day idle allowance | New one-use activation challenge; reuse valid Access SSO only if accepted by Access |
| ON + healthy authenticated WSS | No countdown, even if no browser tasks | Does not require user clicks, traffic or daily reauthorization |
| ON + disconnected / stale heartbeat | Countdown 30 days since last credible server-observed online activity | No tool execution while offline; a legitimate automatic reconnect *before* expiry clears offline countdown without changing owner-selected ON |
| OFF / disconnected countdown reaches 30 days | Expire and revoke the **old** Endpoint grant; reject its credential and all later admissions | Re-pair through Access and local proof to create a new grant; do not silently resume |
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

Migration at the first compatible release: existing revoked identities stay revoked; valid remembered OFF identities receive a one-time `migration_time + 30 days` deadline; valid ON-online identities keep their present ON intent without an immediate idle deadline; ON-offline identities begin a bounded offline deadline from observed evidence or migration time (never invent an earlier last-seen event). Preserve Endpoint ID, local credential, owner name, previous Stop, receipts and protected-surface denial. Old incompatible extension versions fail closed; publication of Worker does not auto-update the installed extension. Rollout and real browser upgrade need separate owner authorization.

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
2. OFF starts exactly one 30d deadline; repeated/local/remote/offline-reconciled Stop cannot extend it; before deadline owner ON succeeds and restores 30d allowance.
3. ON+live stays valid across 30d without browser tasks; a heartbeat-stale/disconnected ON expires after 30d, while brief disconnect and MV3 sleep do not misclassify permanently.
4. Deadlines enforced without timely Alarm, including stale WSS, late activation callback, Stop-vs-reconnect, DO restart and previous generation; expiry requires new grant.
5. Migrated revoked/OFF/ON-online/ON-offline records retain correct identity and receipts; no stale old-client bypass; default listing excludes history without hiding valid old entries.
6. Temporary mode's 24h lease, browser-session invalidation, reconnect grace and explicit sensitive grants remain unchanged.
7. Options normal/error states, name collisions, icon state and accessible controls on installed Chrome and Edge.

No new production release, Access policy edit or credential rotation is authorized by this document. Evidence must separate code/CI, extension ZIP, Worker release, installed Chrome/Edge version and live owner actions. Known prior Waivers remain Waivers, not retroactively Pass.
