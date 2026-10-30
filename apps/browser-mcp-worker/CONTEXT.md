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

## Confirmed single-action owner activation and automatic pairing (design only)

Authoritative incremental decisions: [Spec #418 amendment](./docs/single-action-otp-design.md). **Q1=A, Q2=A, Q3′=B, Q4=A as conditional Access PIN, Q5′=B, Q6=A, Q7′=B, Q8=A, Q10=A, Q11=B.** Q11=B expressly supersedes the earlier strict per-toggle fresh email PIN rule. Current deployed implementation and original Spec are unchanged until authorized implementation and acceptance.

- **Toolbar Action:** one Profile-local extension click switches ON/OFF with no default popup. OFF is a reversible local **Stop**, not **Endpoint Revocation**. Pairing, Revoke, LAN/private grants and diagnostics remain available from the browser extension's Options page.
- **Local Activation Attempt:** a new owner-initiated OFF→ON request, initially non-executable. Every deliberate ON needs a new **one-use extension-bound activation challenge**, even if an earlier Cloudflare Access SSO session satisfies owner identity.
- **Access Owner Identity:** a server-verified, correctly scoped Cloudflare Access owner authentication; it **may reuse existing SSO**, and therefore is not a claim that the owner entered a new PIN for this activation. Only when Access itself requests fresh authentication may the owner manually enter an email PIN. Existing Cloudflare Access apps must not be logged out to force it.
- **Activation Binding:** the extension-held one-use proof of possession, authenticated owner identity, current matching Endpoint/Profile and current Stop/control epoch must all agree before the existing Browser Owner DO can enable or automatically pair. No human-entered pairing code, unsafe webpage grant or reused callback is accepted.
- **Pairing Lifetime:** **Permanent** is the default and retains identity across browser restarts; **Temporary** stores its credentials/session proof in trusted session storage, needs new pairing after browser restart/update/reload/disable, and has bounded server-side authority. A single closed window or service-worker suspension is not a browser-session end.
- **Stop / Revoke:** Stop immediately denies new commands and invalidates pending activation but retains the pairing; Revoke removes the identity and credentials. A late Access callback, Resume or old socket generation cannot overcome Stop. Neither reverses an already-dispatched website side effect.
- **Owner Approval:** a separate, operation-specific authorization for consequential actions. Valid activation/Access SSO is never an approval for the operation. Browser Agent automation must not control the protected Owner Approval or activation login context.
- **Sensitive Scope Grant:** LAN and Incognito remain separately opted-in and session-only; authenticating through Access does not enable them.
- **WSS Connection Generation:** current authenticated transport is necessary but not sufficient for authorization; transient transport disconnection does not implicitly equal owner Stop.

**Migration:** existing permanently paired ON Profiles keep Endpoint credentials and operation receipts, but transition to OFF exactly once when the new control UX is deployed. Subsequent deliberate ON passes through the new owner-authenticated, one-use challenge; ordinary restart preserves the last deliberate ON/OFF for permanent pairing.

**Status:** this is the confirmed design amendment, not source implementation or native Chrome/Edge E2E. Existing Popup Resume and explicit pairing-code behavior remain deployed. Fresh email OTP on every click is **not** an acceptance requirement under Q11=B; extension-binding/Stop/approval safety checks remain mandatory. Reuse the existing Browser Worker/DO and GitHub Actions release path; no new bounded context or ADR.
