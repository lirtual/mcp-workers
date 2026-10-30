# Browser MCP — Single Toolbar Action + Fresh Email OTP (Design Draft)

> Spec [#418](https://github.com/lirtual/mcp-workers/issues/418) · Grill With Docs · 2026-10-30  
> **Status: Q1–Q4 owner-confirmed; Q5–Q8 open. Design only — not implemented, merged or released.**  
> This is an incremental design draft. Existing #418 security and lifecycle contracts remain authoritative until the complete amendment is accepted.

## Confirmed owner decisions

| Decision | Selected | Product contract |
| --- | --- | --- |
| Q1 | A | **Clicking the Chrome/Edge toolbar extension icon itself** toggles local control. No default Popup or second primary button. |
| Q2 | A | Newly installed/ungranted Profile is **OFF** by default. Restart preserves the owner's selected ON/OFF state, and Stop cannot be undone by reconnect. |
| Q3 | A | **Every deliberate OFF → ON transition requires a newly completed email OTP**. An existing Access cookie/JWT or previously used PIN does **not** count as fresh verification. |
| Q4 | A | Reuse **Cloudflare Access email One-time PIN** and a trusted owner authentication page; never read, automate or fill the email OTP through Browser MCP/the extension. Do not create an independent OTP issuer. |

## Precise domain distinctions

- **Browser Endpoint / Extension Grant**: the existing, per-Profile paired identity and its long-lived control permission. Pairing alone never means that control is currently ON.
- **Local Activation Attempt** *(proposed term)*: a trusted owner toolbar-click request to change OFF to ON; it is pending, **not** a Browser Control Session in the enabled state.
- **Fresh Activation Proof** *(proposed term)*: server-verified evidence that this particular pending activation completed a new owner-entered Cloudflare Access email OTP login. Exact source, isolation and binding are **unresolved Q5**. Access session presence alone is not proof.
- **Browser Control Session**: owner-selected ON/OFF authority. It is distinct from WSS online/readiness and from Consequential Action Owner Approval.
- **Owner Approval**: an independent, operation-specific approval boundary; a successful activation OTP is **never** approval for consequential browser operations.

## Intended interaction (pending dependency decisions)

1. User clicks the toolbar extension icon on an OFF Profile. It remains non-executable while waiting for trusted owner OTP verification. Show `VERIFY` / pending status without reporting that remote control is active.
2. Only after server-verified, **fresh, activation-bound** OTP evidence and current Stop/revoke/version checks may the same Profile become ON and attempt its existing WSS connection. A failed, cancelled, timed-out or unverifiable attempt remains OFF.
3. User clicks the icon on an ON Profile: deny new local actions **immediately**, persist OFF/Stop, terminate the transport and reconcile cloud Stop using existing semantics. Stop always wins over a concurrent verification/enable acknowledgement.
4. ON while connecting is still ON (not OFF); connection/readiness is shown separately in tooltip/diagnostics. An online socket does not by itself grant control.
5. Chrome/Edge Profile identity is distinct. Browser restart retains deliberate ON/OFF per Q2; it does not synthesize an OFF→ON transition. Extra LAN/private permissions remain session-only and are never restored by activation OTP.
6. Revoked cannot return to ON by a click. Re-pair/revoke, LAN/private and diagnostics require a separately reachable **advanced local interface**, not multiple toolbar buttons (precise entry pending Q8).

## Implementation implications and non-negotiable checks

- Chrome documents that `chrome.action.onClicked` is not dispatched while the action has a popup; Q1 requires removing `action.default_popup` on the primary click path. The existing code still uses `popup.html` / `popup.js` and `resumeLocal`; there is **no** OTP activation in the current implementation.
- Cloudflare Access maintains global and application sessions. A valid global session can renew an application token without a new email challenge. **Simply opening an Access-protected page, inspecting an Access JWT, setting a short app timeout or changing the URL cannot prove Q3**. Do not silently log the user out of unrelated Access applications as a workaround. Q5 must select and validate a genuine fresh-login mechanism, or activation must fail closed.
- Keep pairing credentials, Access identity for activation, and independent high-impact Owner Approval separated; never expose activation secrets to page scripts, MCP tools, logs or URLs. Maintain Stop/Revoke linearization, old-operation receipts/Unknown rules, no remote Resume, and per-Profile targeting.
- Current Cloudflare Access OTP PIN is single-use and expires after ten minutes; an activation challenge must also expire/cancel independently, with a one-use, attempt-bound final authorization result (concrete bound fields and expiry are later security design work, not decided here).
- Do not silently extend `<all_urls>`, privacy/LAN permissions or grant scope for the new UX; do not build another Worker, authentication platform, or parallel deployment route merely for the UI simplification.
- Preserve source/Release artifact identity for Chrome+Edge. Native E2E must separately cover new Profile, upgrading already paired Profiles, repeated OFF→ON OTP, logout/session-reuse negative, Stop while pending, reconnect, revocation and high-impact approval independence.

## Second-round decision frontier — pending owner answers

- **Q5 · Fresh Cloudflare Access OTP under an existing global session.** A: require an isolated authentication context demonstrably free of Access sessions (and fail closed where unavailable), without global logout; B: explicitly accept a global Access logout/re-auth effect. Neither is yet evidenced as a complete implementation.
- **Q6 · Existing ON Profile migration.** A: preserve Endpoint identity/credential but force a one-time OFF until first new OTP; B: grandfather existing ON sessions until the next explicit OFF.
- **Q7 · First-time pairing.** A: retain explicit short-lived `browser_pair` setup through advanced local options; B: integrate automatic Profile pairing after owner Access verification, subject to separate anti-CSRF and device-binding design.
- **Q8 · Advanced local controls.** A: keep revoke, cloud-stop status, LAN/private and diagnostics on browser extension Options/settings page; B: remove local settings surface and expose only an out-of-band owner setup flow. Any alternative must preserve mandatory local-only consent.

## Sources (product documentation)

- https://developer.chrome.com/docs/extensions/reference/api/action
- https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/
- https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/
