# Browser MCP Context

Browser MCP owns **Browser Endpoint**, **Extension Grant**, Browser Control Session, owner pairing and revocation, WSS Connection Generation, Eligible Web Tab, Browser Operation, Owner Approval, Operation Receipt, and Unknown Outcome. It is distinct from the Remote Control device/agent bounded context.

This implementation contains the **T1 pairing/control foundation**, **partial T2 read-only tab discovery, bounded visible text and guarded active-tab screenshots**, and a **T3 durable intent/Unknown ledger and explicit source-only tab mutation protocol with operation-status lookup**. Real Chrome/Edge isolated-profile read and WSS integration evidence is documented in README; it does not establish release readiness. T3 tab mutation/prepare-execute and minimal effect receipts are implemented in source and have a local real-workerd WSS protocol test, but Chrome/Edge real-mutation acceptance is **Not run**. Restricted **T4 fixed-schema page interactions** now use the same intent/prepare/execute chain and snapshot-issued document-bound element references; native T4 acceptance is **Not run**. T5 now implements conditional independent Owner Approval on the same Worker for identified consequential navigation and meaningful non-form button clicks. Approval remains **Blocked by default**: real Access routing, separate owner Profile/mailbox isolation and human acceptance have not been established. T6 adds independent session-only local LAN/private consent, with native incognito permission, separate enumeration scopes and no cross-scope regrouping. Real T6 browser acceptance is **Not run**. Unrestricted webpage interaction remains unavailable; local source tests do not establish release readiness.

- A Browser Endpoint identifies one profile-scoped extension install and its separately generated credential.
- Extension Grant is the owner's persistent authorization, independent of Portal authentication.
- Browser Control Session is locally enabled/stopped; transport online is independent.
- Connection Generation is monotonically advanced on authenticated WSS replacement; stale generations grant no authority.
- Endpoint Revocation is permanent for that identity; it rejects new admissions but does not reverse an already-issued website side effect.
- Passwords and recognized OTP/secret fields are excluded from the curated read path. T2 can transmit bounded visible text and guarded screenshots transiently, but page content and images are never persisted in the DO.
- Only extension Popup may Resume. Authenticated MCP exposes Stop/Revoke, never Resume.
- Cloud STOP offline reconciliation is best-effort and distinguished from confirmed cloud revocation.
- A live WSS is a transport signal, not browser readiness or website business success.

The eventual T2–T10 semantics and security limits remain canonical in [Spec #418](https://github.com/lirtual/mcp-workers/issues/418).

T2 still requires Chrome/Edge real-device tests, screenshot safety review, and complete DOM/element reference behavior before it can be accepted. The read-only relay has a 5-second bounded response window; it never queues offline work.

## Proposed single-action OTP activation and pairing (design only)

Owner-confirmed design decisions are documented in [the #418 incremental draft](./docs/single-action-otp-design.md): **Q1–Q6=A, Q7′=B, Q8=A, Q10=A**. They do not change the currently deployed Popup, pairing-code flow or Worker behavior until explicitly implemented and accepted.

- **Toolbar Action**: the one primary Profile-local control. OFF means reversible **Stop**, never **Endpoint Revocation**. Chrome/Edge Profile identity remains separate. Additional management (Revoke, LAN/private permissions, cloud confirmation, Diagnostics) belongs in directly accessible extension Options.
- **Local Activation Attempt**: a single local OFF→ON request that is pending until fresh Owner authentication and precise extension/Endpoint binding are verified. Pending is not enabled. A previous Access JWT or global SSO session does not establish a fresh OTP.
- **Fresh Activation Proof**: server-verifiable evidence of a newly completed Cloudflare Access email OTP authentication for a single current activation attempt. It must bind the authenticated Owner to that attempt and its originating extension. A new JWT timestamp alone is not sufficient; the feasibility of supported, trustworthy OTP proof remains an open pre-implementation gate.
- **Automatic Pairing**: first activation uses the same fresh OTP to establish the Endpoint and enable it, without the Owner manually entering a pairing code. An internal one-use challenge and local proof of possession remain mandatory to prevent a session being claimed by another Profile.
- **Pairing Lifetime**: either **Permanent Pairing** (default; retained across browser restarts until Revoke) or **Temporary Pairing** (credential held in the trusted extension browser session; a new browser session needs fresh pairing). Ordinary Service Worker suspension, a closed window or temporary connectivity loss does not by itself end the browser session. A Temporary Pairing also needs a bounded server lease and current authenticated connection generation so lost local state cannot leave an executable cloud grant.
- **Stop / Revoke**: Stop denies new local work immediately while retaining the paired identity; Revoke invalidates the identity. Neither reverses a previously dispatched website effect. A pending OTP or stale Resume response cannot bypass Stop/Revoke.
- **Owner Approval**: an independent operation-specific boundary for consequential actions. The activation OTP is not an Owner Approval, and its trusted login context must not be operable through the controlled Browser MCP tabs.
- **Sensitive Surface Grant**: LAN/private permissions are separate local, session-only grants. Successful OTP does not auto-enable them.

**Rollout distinction:** Existing permanently paired ON Profiles retain Endpoint credentials/receipts but enter OFF once when the fresh-OTP UX is introduced; after owner activation, ordinary restart preserves the deliberate ON/OFF choice. Temporary pairing overrides that persistence and always requires pairing in a new browser session.

**Current implementation is unchanged**: only the trusted extension Popup currently performs local Resume and pairing still uses the explicit one-use code. Full details, negative cases and T9/T10 acceptance gates live in the linked draft; no additional bounded context or ADR is warranted by this UI change alone.
