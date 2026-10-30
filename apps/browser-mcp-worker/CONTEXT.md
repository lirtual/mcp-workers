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

## Proposed single-action local activation (design only; not implemented)

Owner-confirmed 2026-10-30 Grill With Docs decisions [Q1–Q4](./docs/single-action-otp-design.md) change the **proposed interface**, not current executable authorization:

- **Toolbar Action** is the Profile's single primary ON/OFF control; initial ungranted state is OFF, and deliberate local ON/OFF survives restarts. There is no new remote Resume authority.
- **Local Activation Attempt** is a local OFF→ON request pending a **new** owner-entered Cloudflare Access email OTP. Pending is not enabled; a prior Access session/JWT is not fresh authentication evidence.
- **Fresh Activation Proof** denotes the as-yet-unspecified, server-verifiable result of a *new* OTP for this attempt. Its isolation/binding method remains under Q5 review; do not treat a normal Access redirect as proof.
- **Browser Control Session**, WSS connection readiness, the persistent **Extension Grant**, and consequence-specific **Owner Approval** remain independent concepts. This activation OTP cannot substitute for Owner Approval.
- Chrome's current Popup-only Resume, pairing UI and badge behavior are still **the live implementation**. Do not mistake this proposed contract for a shipped feature. Existing paired-Profile migration and setup/advanced-controls entry remain pending Q6–Q8.

No new bounded context, ADR or additional service is needed merely to define this UX amendment; see the linked draft for unresolved security dependencies and negative tests.
