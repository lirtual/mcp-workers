# Browser MCP — Single Toolbar Action + Fresh Email OTP (Design Draft)

> Spec [#418](https://github.com/lirtual/mcp-workers/issues/418) · Grill With Docs · 2026-10-30  
> **Status: Q1–Q6=A, Q7′=B, Q8=A, Q10=A confirmed; fresh-OTP proof and session E2E remain validation gates. Design only — not implemented, merged or released.**  
> This is an incremental design draft. Existing #418 security and lifecycle contracts remain authoritative until the complete amendment is accepted.

## Confirmed owner decisions

| Decision | Selected | Product contract |
| --- | --- | --- |
| Q1 | A | **Clicking the Chrome/Edge toolbar extension icon itself** toggles local control. No default Popup or second primary button. |
| Q2 | A | Newly installed/ungranted Profile is **OFF** by default. Restart preserves the owner's selected ON/OFF state, and Stop cannot be undone by reconnect. |
| Q3 | A | **Every deliberate OFF → ON transition requires a newly completed email OTP**. An existing Access cookie/JWT or previously used PIN does **not** count as fresh verification. |
| Q4 | A | Reuse **Cloudflare Access email One-time PIN** and a trusted owner authentication page; never read, automate or fill the email OTP through Browser MCP/the extension. Do not create an independent OTP issuer. |

## Additional confirmed owner decisions (2026-10-30)

| Decision | Chosen contract |
| --- | --- |
| Q5=A | Use an independent authentication context with no reusable Access login sessions. If a newly entered email OTP cannot be proven, do not enable. Do not log the owner out of unrelated applications. |
| Q6=A | Preserve existing per-Profile Endpoint identity and credentials, but migrate an already ON Profile to OFF once when introducing OTP-gated activation. |
| Q7′=B (supersedes Q7=A) | First OTP completes both pairing and activation automatically. No user-entered pairing code; keep a non-human, short-lived challenge bound to the same extension instance and owner. |
| Q8=A | Toolbar OFF = Stop, not Revoke. The extension Options page exposes Pairing details, Revoke, LAN, private browsing, cloud confirmation and Diagnostics without hiding these behind nested controls. |
| Q10=A | Permanent pairing is the default; first activation can select temporary pairing, which expires when the browser Profile session ends. |

## Precise domain distinctions

- **Browser Endpoint / Extension Grant**: the existing, per-Profile paired identity and its long-lived control permission. Pairing alone never means that control is currently ON.
- **Local Activation Attempt** *(proposed term)*: a trusted owner toolbar-click request to change OFF to ON; it is pending, **not** a Browser Control Session in the enabled state.
- **Fresh Activation Proof** *(proposed term)*: server-verified evidence that this particular pending activation completed a new owner-entered Cloudflare Access email OTP login. Q5 requires an isolated authentication context, but the exact mechanism and independently verifiable evidence of a **new** Cloudflare OTP have not yet been established. Access session presence alone is not proof.
- **Browser Control Session**: owner-selected ON/OFF authority. It is distinct from WSS online/readiness and from Consequential Action Owner Approval.
- **Owner Approval**: an independent, operation-specific approval boundary; a successful activation OTP is **never** approval for consequential browser operations.

## Intended interaction (pending dependency decisions)

1. User clicks the toolbar extension icon on an OFF Profile. It remains non-executable while waiting for trusted owner OTP verification. Show `VERIFY` / pending status without reporting that remote control is active.
2. Only after server-verified, **fresh, activation-bound** OTP evidence and current Stop/revoke/version checks may the same Profile become ON and attempt its existing WSS connection. A failed, cancelled, timed-out or unverifiable attempt remains OFF.
3. User clicks the icon on an ON Profile: deny new local actions **immediately**, persist OFF/Stop, terminate the transport and reconcile cloud Stop using existing semantics. Stop always wins over a concurrent verification/enable acknowledgement.
4. ON while connecting is still ON (not OFF); connection/readiness is shown separately in tooltip/diagnostics. An online socket does not by itself grant control.
5. Chrome/Edge Profile identity is distinct. Browser restart retains deliberate ON/OFF per Q2; it does not synthesize an OFF→ON transition. Extra LAN/private permissions remain session-only and are never restored by activation OTP.
6. Revoked cannot return to ON by a click. Revoke, LAN/private, cloud Stop confirmation and diagnostics remain directly reachable from the browser's native extension Options page, separately from the single primary toolbar action.

## Implementation implications and non-negotiable checks

- Chrome documents that `chrome.action.onClicked` is not dispatched while the action has a popup; Q1 requires removing `action.default_popup` on the primary click path. The existing code still uses `popup.html` / `popup.js` and `resumeLocal`; there is **no** OTP activation in the current implementation.
- Cloudflare Access maintains global and application sessions. A valid global session can renew an application token without a new email challenge. **Simply opening an Access-protected page, inspecting an Access JWT, setting a short app timeout or changing the URL cannot prove Q3**. Do not silently log the user out of unrelated Access applications as a workaround. Q5 must select and validate a genuine fresh-login mechanism, or activation must fail closed.
- Keep pairing credentials, Access identity for activation, and independent high-impact Owner Approval separated; never expose activation secrets to page scripts, MCP tools, logs or URLs. Maintain Stop/Revoke linearization, old-operation receipts/Unknown rules, no remote Resume, and per-Profile targeting.
- Current Cloudflare Access OTP PIN is single-use and expires after ten minutes; an activation challenge must also expire/cancel independently, with a one-use, attempt-bound final authorization result (concrete bound fields and expiry are later security design work, not decided here).
- Do not silently extend `<all_urls>`, privacy/LAN permissions or grant scope for the new UX; do not build another Worker, authentication platform, or parallel deployment route merely for the UI simplification.
- Preserve source/Release artifact identity for Chrome+Edge. Native E2E must separately cover new Profile, upgrading already paired Profiles, repeated OFF→ON OTP, logout/session-reuse negative, Stop while pending, reconnect, revocation and high-impact approval independence.

## Agreed minimal design: OTP-based pairing and activation

1. **First use:** initial OFF state, owner clicks the toolbar icon and chooses temporary or permanent pairing (permanent default). The extension creates a one-use activation attempt bound to this exact local installation and redirects the owner to a trusted, independent Access authentication context. Owner completes a **fresh** Cloudflare email OTP; the verified result is matched to the same attempt and allowed owner identity. Only then create the Endpoint and enable its control session. No manual code is typed into the extension.
2. **Previously paired, OFF → ON:** repeat the fresh OTP and attempt binding; reuse the existing Endpoint, not the pairing step. Existing valid global/app Access sessions, redirected pages or newer JWT issue times alone must **not** silently satisfy the fresh-OTP condition.
3. **ON → OFF:** an immediate local Stop blocks new execution, invalidates any pending activation, clears session-only LAN/private grants, and asks the existing Worker to persist Stop. If cloud Stop is unconfirmed, show that fact in Options while retaining the local denial.
4. **Revoke:** a distinct, explicitly confirmed operation invalidates the Endpoint and clears credentials. Temporary-to-permanent or permanent-to-temporary changes require revoke and re-pair; never silently change a grant's lifetime.
5. **Chrome and Edge:** each Profile remains an independent Endpoint. One cross-browser extension artifact and the existing Worker/DO infrastructure are retained.

## Fresh OTP: safety and feasibility gate

- The activation attempt must bind a server-side unguessable one-use identifier to the owner's identity, exact extension instance/paired Endpoint (when present), control generation, creation/expiry, and browser-local proof of possession. The original extension must demonstrate it owns the pending attempt before the server creates or enables a grant. An arbitrary webpage's claim of an extension ID, Access JWT, or claimed redirect is insufficient.
- A Cloudflare Access session proves **access authorization**, not necessarily that a fresh OTP was entered for this attempt. Cloudflare documents automatic application-token renewal from valid global SSO. Its documented app token and ordinary login callback do not establish an attempt-specific, newly redeemed OTP. **Do not present any redirect, JWT `iat`, ordinary Access audit log, or short session setting as proof without an independently verified contract.**
- Q5=A selects isolation rather than global SSO logout. Verify that the chosen trusted context is genuinely free from both global and application Access cookies and that Cloudflare actually prompts for a new PIN. Additionally, independently establish the fresh OTP result and the binding to this attempt. The exact browser technique and callback integration are **unverified engineering prerequisites**, not an authorization to create a second OTP service, bypass Access, or weaken the requirement.
- If the platform cannot demonstrate fresh OTP plus safe extension binding without additional consent or capabilities, leave activation OFF and record the blocking feasibility gap. The owner can revisit the design later; no silent downgrade.
- The Browser MCP agent must never read or fill the OTP, manipulate the trusted authentication tab, or approve consequential site actions by reusing the activation result. The existing independent Owner Approval remains fail-closed.
- Challenges are one-use, expiring and non-replayable; failed, cancelled, delayed or mismatched callbacks grant nothing. The pre-existing security boundaries for authentication surfaces, CSRF and allowed owner identity remain intact.

## Temporary pairing: scope and revocation

- The **temporary pairing credential** and current browser-session identifier belong in trusted `chrome.storage.session`, inaccessible to ordinary page scripts. They must not be copied into persistent `storage.local`, sync, ordinary web pages or logs. Persistent minimal metadata can indicate that the previous temporary grant needs re-pairing without retaining a reusable credential.
- `storage.session` is cleared when the browser restarts and when an extension is disabled, reloaded or updated. Treat these as an end to temporary pairing. A routine MV3 service-worker suspension or loss of internet is **not** a new browser session; closing a single window does not revoke a still-running browser Profile.
- Cloud authorization is separately constrained: a temporary Endpoint permits new work **only while a matching, authenticated, currently live WSS generation and browser-session proof are valid**. A bounded server lease expires without renewal. No offline mutation queue and no automatic re-enablement from stale durable state.
- Unexpected shutdown cannot guarantee an immediate cloud-side revocation request. Cloud Stop/Revoke may be best-effort; expiration and the absence of a live session block new execution. Explicit Revoke still invalidates the server authorization; no old credential may be re-used in the next browser session. An already-dispatched website action cannot be rolled back.
- Permanent pairing keeps the original credential and the owner's chosen ON/OFF across restart after initial migration; it still requires fresh OTP at every **deliberate** OFF → ON and must honor a remote Stop. Temporary pairing **overrides** that persistence contract and always returns unpaired/OFF on the next browser session.

## Stop / OTP / WSS race priorities

1. A local Stop or Revoke invalidates the pending challenge and increments a control epoch **before** network I/O.
2. Cloud Stop/Revoke persists a denial that a late OTP callback, prior Resume response, old WSS generation, worker restart or browser reload cannot override.
3. Commit the newly verified OTP and grant only if the matching epoch, pairing identity, browser-session proof and current stop/revoke state remain valid at the final atomic check. The extension independently rechecks before connecting.
4. If an earlier enable wins before a Stop, Stop closes subsequent admissions; actions already dispatched may remain Unknown or complete, but are not retried with a new key.
5. Badge and tooltip distinguish **OFF**, **VERIFY**, **ON but connecting**, **ON and ready**, and **REVOKED/unpaired**. Transport offline is not the same thing as owner OFF.

## Verification gates before any implementation/production claims

| Scenario | Required result |
| --- | --- |
| New Chrome and Edge Profile | Starts OFF; fresh OTP + extension-bound callback creates exactly one Endpoint without a manual code |
| SSO already valid / forged or stale redirect | Remains OFF unless independently proven fresh OTP and current extension binding |
| Two deliberate OFF → ON toggles | Each requires a new OTP; previously redeemed result cannot activate again |
| Existing ON installation upgrade | Reuses Endpoint and historical receipts; begins OFF exactly once |
| Temporary pairing: browser restart, extension reload/update | Next session unpaired; old credential cannot open WSS or execute |
| Temporary pairing: worker suspend, single-window close, transient disconnect | Does not spuriously re-pair while the browser session is still valid |
| Cloud lease expiry / copied credential / network loss | No new execution without valid current WSS generation and server grant |
| Stop during OTP or while Resume is in flight | Stop wins, including delayed callbacks, old generations and offline cloud Stop |
| Revoke versus Stop | Stop leaves pairing; Revoke invalidates identity and requires fresh pairing |
| Advanced Options & sensitive permissions | Pair/Revoke/LAN/private/diagnostics accessible; LAN/private remain local, session-only grants |
| High-impact actions | OTP activation does not replace independent Owner Approval; failed isolation remains blocked |
| T9/T10 production E2E | Native Chrome/Edge and true owner-inaccessible OTP/approval channel, errors, unknown receipts, replay, and rollback verified separately |

This is a **design acceptance matrix**, not completed testing. The existing #418 Spec, security invariants, release machinery and T9/T10 dependencies remain authoritative until formally amended.

## Open feasibility decision (not implicitly resolved)

**Fresh Cloudflare OTP evidence:** Q5=A requires proof of a new OTP login for every activation. Neither a session-free login page nor a new Access JWT on its own proves that the user's particular activation consumed a new OTP. Determine whether a supported Access capability can supply reliable evidence and safely return a one-use, extension-bound result. If it cannot, flag a genuine design blocker for the owner instead of implementing a weaker flow.

## Official references

- https://developer.chrome.com/docs/extensions/reference/api/action
- https://developer.chrome.com/docs/extensions/reference/api/storage
- https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/
- https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/

## Read-only OTP feasibility audit — 2026-10-30

**Scope:** Documentation, actual Access configuration and Chrome extension API inspection. No real OTP login was attempted; no Cloudflare policy/credential/Worker, extension, database or production operation was changed. Findings below are not an end-to-end authentication pass.

### Verified facts

- The account has an existing production `Browser Production Owner Approval` Access self-hosted application scoped to `browser.lirtual.dpdns.org/owner/*`, with a 15-minute Access session and **only the One-time PIN IdP enabled**. Its policy is an owner-email allow rule; it has no additional `require` rules. A separate `Browser` Access application protects the MCP Portal mapping. Do not treat either application's existing identity/session as an activation grant, and do not broaden the Owner Approval surface.
- The account has a Cloudflare One-time PIN IdP configured. Cloudflare policies support a `require: login_method` selector restricting a policy to the OTP IdP. That controls **which IdP**, not **whether an OTP was newly entered for this activation**. A normal Access application may reuse an existing global SSO cookie to reissue an application token.
- Cloudflare's OTP documentation states that successful PIN entry redirects to the protected app, the PIN is single-use and expires after 10 minutes; the product's authentication audit event is emitted only after PIN entry. Access authentication logs expose `action`, `allowed`, `app_uid`, `connection`, `created_at` and `ray_id`. Neither the documented Access JWT identity claims nor the Access logs API response includes a server-attested, application-controlled activation nonce that securely ties one specific OTP redemption to one initiating extension.
- Cloudflare's 2026-09-14 `force_authn` setting applies to **SAML IdP** reauthentication, not Access native One-time PIN.
- Chromium `chrome.identity.launchWebAuthFlow` is available for third-party interactive flows and can return an extension-specific redirect URL, but official docs do **not** establish that each invocation has a new cookie-free Access global session or supports the exact Cloudflare Access callback contract. Treat it as an API candidate requiring a real compatibility test, not a proven fresh-OTP solution.
- Chromium `chrome.storage.session` clears on browser restart / extension disable, reload or update but survives ordinary extension Service Worker suspension. This supports the temporary-pairing local lifetime; it cannot prove immediate server-side revocation on browser crash.

### Finding: Q3 + Q5 **blocked on one technical proof**

The confirmed UX requirement is **every deliberate OFF→ON requires a new owner-entered Cloudflare OTP**, including a user who is already signed in to the same Cloudflare team in the normal profile. The tested account configuration and public API contracts do not yet prove a supported, automatic, cookie-isolated OTP transaction with server-visible, challenge-bound evidence. **Do not claim this feature is ready to implement or accepted.** An OTP-only Access policy, a newly issued Access app token, an audit log near the activation timestamp, or an incognito-looking window alone is insufficient evidence.

The one-use internal pairing/activation challenge, exact originating Profile binding and Stop/Revoke precedence remain necessary. An Agent that can control the OTP browser or mailbox through another tool does not establish independent owner consent. Maintain the separately protected consequential-action Owner Approval.

### Smallest remaining evidence-gathering test (requires explicit owner participation; NOT yet performed)

1. In a deliberately isolated, owner-controlled auth context, open a candidate **Access-protected activation URL** (distinct from existing consequential-action approval), with an unguessable attempt nonce held server-side and a proof-of-possession secret held only in the initiating extension. Do **not** reuse a live owner-approval flow for activation.
2. Check that the owner is visibly prompted to enter a new Cloudflare email PIN **twice**, including when the normal Chrome/Edge profile already has a valid global Access session; verify login under the intended allowed IdP without revoking unrelated sessions.
3. Independently verify how the authenticated callback could be correlated to the exact one-use server attempt and originating extension. Check that a replayed URL, late callback, parallel Profile, session cookie reuse, cancelled attempt and Stop during login all fail closed.
4. Confirm Chrome and Edge behavior in the native extension (including `identity.launchWebAuthFlow` if selected) without reading OTP content from the Agent/extension. Require owner-visible permission to access protected pages when necessary.
5. If the platform cannot produce a trustworthy freshness + binding proof under Q5=A, **return an explicit feasibility blocker to the owner**; do not add a homemade OTP provider, global logout, OTP-email scraping, or a second Worker to make the proof appear satisfied.

This test is an explicit gate before any code implementation or production migration; it must not be silently marked Pass from docs, CI, logs or mere Access login success.

### Canonical sources

- https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/
- https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/
- https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/
- https://developers.cloudflare.com/cloudflare-one/insights/logs/dashboard-logs/access-authentication-logs/
- https://developers.cloudflare.com/changelog/post/2026-09-14-saml-force-authentication/
- https://developer.chrome.com/docs/extensions/reference/api/identity
- https://developer.chrome.com/docs/extensions/reference/api/storage

## Isolated feasibility spike results — 2026-10-30

**Scope and authorization:** User approved the next minimal authentication-flow experiment. This run used read-only Cloudflare API inspection, actual existing extension unit harness, and one scratch-only synthetic test in an approved WSL2 device at `/tmp/spec418-otp-readonly-20261030`. It did not change Cloudflare Access apps/policies, send OTP emails, touch owner approval, change the main branch, merge, or deploy.

### Evidence

1. **Access inventory (read-only live API).** There are 22 Access application entries, six self-hosted. The two Browser-related self-hosted apps are exclusively for the production and isolated **Owner Approval** `/owner/*` routes; both allow only the One-time PIN IdP and use 15-minute session duration. Neither is an endpoint activation app. No existing dedicated Access-protected browser **activation** path was found in this application inventory. The Portal's `Browser` MCP application has a separate auth scope. Repurposing `/owner/*` for activation would conflate independent Owner Approval and pairing authority, so it is explicitly disallowed.
2. **Provider capability.** Cloudflare supports OTP-only login method selection and restricting allowed email identities. The global Access session can still issue app JWTs without a fresh PIN. Newer `force_authn` applies to SAML IdPs, not Access native OTP. `chrome.identity.launchWebAuthFlow` supports an extension redirect but does not promise a fresh empty Access cookie jar; requires real Chrome/Edge compatibility testing.
3. **Access auth logs (read-only live API).** `GET /accounts/{account_id}/access/logs/access_requests?limit=5` returned HTTP 200; the sampled log records have fields `action, allowed, app_domain, app_name, app_type, app_uid, connection, country, created_at, ip_address, ray_id, user_email, user_id`. No sample has an extension activation nonce or OTP-redemption-proof field. Samples are not Browser OTP login events and are insufficient to establish whether any real OTP was performed. Privacy-sensitive log values were not copied into this design record.
4. **Current code baseline (actual local test).** On isolated WSL2 source checkout at SHA `3a081c6`, `node --test tests/extension.test.mjs` passed **23/23**, including local Stop winning over delayed Resume, late storage writes, and Revoke.
5. **New scratch-only focused probe (actual legacy source under VM).** Reused the existing Chrome extension `background.js` test harness and mocked only the Worker endpoint responses. A trusted Popup `resume` successfully called `/extension/resume` and changed local state to `enabled` with **no new OTP challenge or proof**. Focused probe passed **1/1** (expected old-code behavior). This is a **confirmed implementation gap relative to the NEW design**, not proof of a defect in the current published Spec. The probe file was created only in a temporary WSL2 checkout, not committed to GitHub.
6. **Not tested:** No real Cloudflare Access OTP was requested or entered; no actual `identity.launchWebAuthFlow` Chrome/Edge auth redirect was exercised; no genuine Access session-isolation / freshness / one-use binding evidence was obtained. Thus the confirmed blocker remains **unresolved**.

### Shortest safe remaining path

- **Do not reuse** production `Browser Production Owner Approval` or the isolated `Browser Spec418 Isolated Owner Approval` Access app as a pairing login callback.
- In a distinct, explicitly authorized activation route protected by OTP-only Access, verify two consecutive user-entered email PIN logins with a normal existing Cloudflare global session, and confirm the authentication callback binds to a unique extension-held one-time challenge. A new JWT plus timestamp or an Access log entry does not alone establish fresh OTP for this attempt.
- Scope any future temporary Access application/path configuration and test-origin setup as a separate owner-approved infrastructure change. **No new Access resource or deployment was created by this spike.** Do not call the current test complete until a real Owner independently enters a PIN and verifies expiry/replay/Stop cases.
- Tests for Stop, Revoke, and Unknown already present should be **extended**, not duplicated into a second test suite. Keep one existing GitHub Actions production release path.

**Result:** Partial technical spike completed. Existing control-race tests remain green, missing OTP enforcement is demonstrated, Cloudflare account has an appropriate OTP IdP but lacks a dedicated activation path, and the real authentication proof remains **Blocked on protected activation entry + owner-interactive Chrome/Edge test**.

## Owner-authorized isolated Access test entry — 2026-10-30

**Status: Access gate deployed and verified; real owner OTP and extension-bound activation callback NOT performed.** This is a narrowly scoped temporary Access infrastructure change authorized by the Owner. It must not be confused with an implementation of Browser MCP auto-pairing.

### Actual infrastructure changes

- Created one **self-hosted Cloudflare Access application** named `Browser Spec418 Temporary OTP Activation Probe`, app ID `a24c5ac7-4d81-4688-9ad4-383f641ae147`, matching only `browser.lirtual.dpdns.org/activation-test-418/*`.
- Application's only allowed IdP: the existing Cloudflare One-time PIN provider. Session duration: `15m`. Hidden from the App Launcher. No other owner approval or MCP Portal application changed.
- Created one application-scoped Allow policy `Browser Spec418 OTP Probe Owner Email Only`, policy ID `73a8dc57-60e0-4fc3-b1ea-37e6b5f98920`. Include is the existing explicitly authorized Owner Outlook email only; Require pins `login_method` to the same One-time PIN IdP. No broad email-domain include, service tokens, nonidentity bypass or public access.
- No additional Worker, DNS record, Durable Object, GitHub CI, secret, credential, or production Worker code change. Existing `browser-mcp-worker` custom domain handles the request only **after** Access. The main Worker has **no** `/activation-test-418/` route, so post-login origin response is currently HTTP 404. This test checks the Access authentication gate only; it does not create an activation callback, issue Endpoint credentials, or grant browser control.

### Live access control verification (no OTP email generated)

- API GET readback returned app HTTP 200 and policy HTTP 200. The policy contains exactly one specific Owner email include and OTP `login_method` requirement.
- Unauthenticated GET `https://browser.lirtual.dpdns.org/activation-test-418/start` returned **302 to Cloudflare Access**, as did a second path under the same test prefix.
- Unauthenticated existing `/owner/operations/<uuid>` remained **302 to Cloudflare Access** with its own application; original independent Owner Approval remains untouched.
- Adjacent unmatched path `/activation-test-419/start` remained Worker **404**, confirming no wildcard spill beyond the new test prefix.
- Explicitly **not yet tested:** whether the Owner gets a new PIN in a browser already holding a valid global Access session; completing a real OTP; subsequent SSO reuse; extension-specific redirect and one-use challenge binding; replay/Stop behavior. A normal 404 after the Owner authenticates will be the expected origin response and **must not** be reported as a completed automatic pairing or a successful activation callback.

### Owner-facing test and narrow evidence needed

1. From an Owner-controlled Chrome/Edge browser, open `https://browser.lirtual.dpdns.org/activation-test-418/start`. Do **not** expose the PIN to ChatGPT, Browser MCP, a shared screenshot or an Agent-controlled page. Record only whether a new emailed PIN was requested and whether the Access challenge completed.
2. A `Not found` origin page after Access is expected and means **only** the protected route's Access gate passed. If Access never prompts for a fresh PIN due to a reusable global session, record this negative result; do not call Q3 Pass.
3. For an independent session, close **all** InPrivate/Incognito windows and launch a new isolated browser session before repeating; confirm the PIN prompt without transferring any OTP to automation.
4. Do **not** convert the existing `/owner/*` Access app into an activation callback. The future full proof requires a distinct trusted endpoint handler with one-use challenge, authenticated callback provenance, and extension-held proof of possession.

### Cleanup

Once authentication evidence has been collected or the Owner cancels the experiment, **delete only the temporary Access app by its exact app ID** (this should also remove its app-scoped policy) and verify that the test URL returns the prior Worker HTTP 404 without Access redirect. Do not remove the underlying OTP IdP or either existing Browser Owner Approval Access app. The application's 15-minute **session** duration does *not* automatically delete the application, so cleanup is explicitly pending.


## Owner OTP browser results — 2026-10-30

**Owner observation:** Both the ordinary browser and a newly created InPrivate/Incognito browser session displayed an email OTP challenge on the new temporary Access-protected `/activation-test-418/start` route. This demonstrates that neither observed navigation skipped the challenge; it does **not** establish whether the ordinary browser already had an authenticated session for this specific temporary Access app, or that subsequent revisits always require a new challenge.

**Independent Access evidence:** Read-only `GET /accounts/{account_id}/access/logs/access_requests` since `2026-10-30T05:04:00Z` returned HTTP 200 and exactly **one** event for the temporary activation probe app, timestamp `2026-10-30T05:07:15Z`, `action=login`, `allowed=true`, `connection=onetimepin`. The event establishes one successful Access OTP-provider authentication, not two successful completions. Its logged fields do **not** carry the activation nonce or a cryptographic per-attempt OTP redemption proof. No Owner email/IP/cookies/tokens/PIN were copied into the document.

**Remaining decisive negative test:** After actually completing the OTP in a regular browser, immediately revisit the exact same temporary test URL in the **same window/profile** without closing it and without clearing cookies. Observe whether Cloudflare Access asks for another freshly emailed PIN or silently forwards to the Worker `404 Not found`. A silent forward proves the existing Access application session is reused, so Access-protected navigation by itself **cannot** enforce Q3's every-OFF→ON fresh OTP contract. Regardless of the result, still separately validate extension-held challenge proof, owner-vs-Agent auth isolation, pending Stop invalidation and exact Profile binding; none are implemented by this gate test.

**Status:** OTP Access gate / one real OTP login observed; automated browser activation and per-toggle fresh authentication **not verified**. Temporary Access application remains installed solely for the narrowly scoped test and must be explicitly removed after evidence collection.


## Same-session SSO replay negative result — 2026-10-30

**Owner-observed result (confirmed negative case):** Following a successful Cloudflare One-time PIN login to the temporary Access-protected `/activation-test-418/start`, the Owner revisited the **same URL in the same regular browser session without clearing cookies**. The result was **immediate Worker `Not found`**, with **no fresh PIN prompt**. Since this temporary path has no Worker handler, the 404 response demonstrates that the Access layer admitted the browser request from the existing authenticated session without forcing another email PIN. Cloudflare Access authentication logs previously showed one successful OTP login for the test app.

### Security conclusion

- **Q3's every deliberate OFF→ON fresh email OTP is NOT met by the ordinary protected-path approach**, even with the OTP-only allowed IdP and `require login_method` policy. That policy restricts the *authentication method*, not the freshness of each visit.
- Opening the same URL twice is not the same as a fully implemented toggle sequence, but it **decisively invalidates using each successful Access page navigation / Access JWT as evidence of a new PIN**. A future activation endpoint must explicitly obtain trustworthy fresh-authentication proof and bind it to the exact initiating extension challenge; the current simple design is insufficient.
- The result does **not** establish that no other supported mechanism can ever force a fresh OTP. Prior to implementation, validate a genuinely session-free, owner-controlled authentication context with verifiable one-use callback proof, or bring Q3/Q5 back to the Owner for a conscious security/UX trade-off. Do **not** weaken silently, use global logout of unrelated apps, scrape the mailbox, or build a second OTP issuer as an unapproved workaround.
- Local Stop precedence and the temporary pairing lifetime remain sound design requirements. None of the access-layer testing exercised a browser extension callback, automated pairing, real Stop or actual WSS activation; these remain Not tested.

**Test infrastructure:** A temporary Access self-hosted app ID `a24c5ac7-4d81-4688-9ad4-383f641ae147` had been created solely for this test, independent of the production Owner Approval `/owner/*` app. The expected cleanup is to delete only that exact test app, verify the route returns Worker 404 without Access redirection, and confirm the production Owner Approval app remains unchanged.

## Temporary activation probe cleanup verified — 2026-10-30

The Owner's same-session `Not found` negative test completed the authorized Access-gate experiment. Cleanup executed against the **exact** temporary Access application ID `a24c5ac7-4d81-4688-9ad4-383f641ae147`:

- Pre-deletion GET confirmed that the app matched the intended name and `browser.lirtual.dpdns.org/activation-test-418/*` domain, and was separate from the existing Owner Approval app.
- Cloudflare Access DELETE returned `202` and `success=true`.
- Read-only app-list verification returned `temp_present=false`, `temp_policy_present=false`. A direct GET of the removed app returned `404 unknown_application`.
- Independent WSL2 HTTP test returned `temporary_removed code=404 access_redirect=no` for `/activation-test-418/start`. Existing Owner Approval `/owner/operations/<uuid>` still returned `302 access_redirect=yes`.
- Production Owner Approval Access app was independently queried after cleanup and remains present with its original app ID and `/owner/*` domain.

**Final experiment outcome:** Single successful OTP login observed; the Owner subsequently reached Worker 404 without another challenge in the *same browser session*. This is a **FAIL for the simple Access-only per-activation fresh OTP assumption**, and **NOT TESTED** for the planned real extension challenge/callback binding. Temporary Access resource and its policy are removed; do not reuse the now-unprotected test path. No Browser Worker code, existing approval policy, `main`, or release changed.

**Implementation gate:** Do not mark Q3/Q5 feasible on the basis of the deleted probe. Either validate a demonstrably fresh OTP with a properly isolated auth context and verified one-use extension-bound result, or explicitly revisit the owner-confirmed `Q3=A` and `Q5=A` requirements before implementation. No second OTP issuer or global Access logout is authorized.


## Follow-up investigation: browser-auth API and OTP freshness — 2026-10-30

**Scope:** Read-only Cloudflare documentation and current Chromium source review. No new Access app, OTP mail, production setting, Worker/extension code change, merge, or release. Previous isolated Access test and cleanup remain the only live experiment.

### Additional verified constraints

1. **Cloudflare Access logout is not per-app.** [Session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/) explicitly states that both application-domain and team-domain `/cdn-cgi/access/logout` revoke the user's Access session **across all applications**, and that end users **cannot** log themselves out of a single app. The URLs differ only in which local authorization cookie is removed. Forcing fresh OTP by calling logout on every ON would violate Q5=A and disrupt unrelated apps; **reject this approach**.
2. **Short access-token/session durations do not force new email PIN.** The same session docs state a valid **global** token can automatically issue another **application** token after an application token expires. An immediate/zero application-policy session is therefore not evidence of a newly redeemed PIN. Access's [Require MFA on every login](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/) is a separate MFA setting that operates when login happens and does not convert native email One-time PIN into an every-toggle challenge. SAML `force_authn` also does not apply to native email PIN.
3. **Extension `identity.launchWebAuthFlow` is not a fresh-cookie context guarantee.** Chrome's [Identity API](https://developer.chrome.com/docs/extensions/reference/api/identity) promises a web authentication flow and extension-specific `https://<extension-id>.chromiumapp.org/*` redirect, not a new cookie jar for each invocation. Chromium [current source](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/identity/web_auth_flow.cc) creates the auth `WebContents` using the supplied `Profile*` (`WebContents::CreateParams params(profile_)`) and rejects off-the-record mode in `WebAuthFlow::Start`. Earlier Chromium implementations also used a named, reusable auth-flow storage partition with optional persistence across browser restarts; neither implementation is an API guarantee of fresh cookies **per activation**. Therefore `launchWebAuthFlow` can help handle extension redirects but cannot by itself satisfy Q3/Q5.
4. **Incognito is not per-attempt isolation.** A browser's incognito/private windows can share a temporary cookie jar while simultaneously open. Requiring all private windows to close, additional extension private-mode permissions, new profiles, or clearing global Access cookies on every toggle conflicts with previously confirmed low-friction one-button UX and independent private-permission boundaries. These are not automatic safe fallbacks.
5. **One-use challenge != new OTP.** A DO-bound one-time random challenge can bind a successful Access **identity session** to the correct extension/Endpoint and prevent replay, Stop races and cross-profile claims. However, it cannot cause Cloudflare Access to force a new email PIN or independently prove one was entered. Credential binding and authentication freshness are separate properties.

### Implementation status and design fork

The Owner's observed same-session Access-authenticated navigation bypass of the PIN challenge already invalidated the proposed **plain Access-protected activation URL**. With current official supported contracts and Chromium implementation, **no low-complexity automatic per-toggle fresh Cloudflare email PIN path has been verified** that also preserves all other Access sessions and Q1 single-action UX. This is an evidence-based feasibility blocker, **not** proof that no possible integration can ever exist.

**Do not implement Q3=A + Q5=A as if solved, silently downgrade to reusing existing SSO, add cookie-clear/global logout, or invent another OTP provider.** The next step is an explicit Owner decision among:
- **Q11=A — keep original strict requirement:** every deliberate OFF→ON must involve **new email PIN** and a correctly isolated, owner-controlled authentication context. Remain design-blocked until a supported mechanism has been demonstrated (or accept an intentionally manual disposable authentication profile per activation, with its UX cost stated). Do not mark feasible or create a new testing application just to repeat the known negative case.
- **Q11=B — intentionally simplify activation:** use existing Cloudflare Access Owner identity/session (which **may** reuse SSO) plus a local deliberate ON gesture and one-use extension-bound challenge; no promise of new PIN on every ON. Email PIN appears when Access actually requests reauthentication, including a fresh un-authenticated owner session. This revises Q3 and Q5 and must be expressly approved; pairing and high-impact Owner Approval remain independent. It avoids an unverified forced-freshness contract and keeps the one-button UX. Do not claim a PIN always appears for first pairing when a global SSO session exists.

**Suggested recommendation for simplicity:** Q11=B, with honest UI language (“Access authentication”, not “New OTP verified”) and independent Owner Approval retained, **only if the Owner explicitly accepts the reduced per-toggle reauthentication assurance**. If a mandatory new PIN is a non-negotiable security requirement, Q11=A is preferable to misleading activation behavior.

### No additional infrastructure recommended

Retain one Browser Worker/DO, existing GitHub Actions release pipeline, transient local/session credentials and existing Stop/replay semantics. The previously created test Access app was deleted and its absence verified; do not recreate it before settling Q11. This is the end of the current fact-finding frontier, not an invitation to repeatedly start new OTP experiments with unchanged constraints.
