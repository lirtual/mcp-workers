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
