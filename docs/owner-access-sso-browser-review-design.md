# Owner Access SSO and Browser Unknown Review retirement — accepted design

Status: **Design accepted 2026-11-04; production rollout and Owner-reported real-login acceptance completed 2026-11-05.** Grill With Docs decisions: Q1=A (Cloudflare account login with OTP fallback), Q2=A (all active Owner OTP entrypoints), Q3=retire Browser Owner Review rather than adding login, Q4=A (7-day rolling Unknown capacity). At design time this plan **did not authorize** production changes; the later scoped approvals, releases, and independent readbacks are recorded below.

## Current applicability (2026-11-10)

This document preserves the **historical 2026-11-04/05 design and acceptance evidence**, not today's Database release requirements. Spec #760 retired Database Owner Setup and its `/setup` routes; on 2026-11-10 the `database.lirtual.dpdns.org` Custom Domain, its exact DNS record, and the hostname-wide `Database MCP Owner Setup` Access application were independently verified retired. The separate `Database` MCP Access application remains in use through One-MCP Portal at `https://database-mcp-worker.aiyaya.workers.dev/mcp`.

**Do not apply** the historical Database Owner Setup SSO/OTP, audience/issuer, JWT/CSRF, or Owner-page verification requirements to current Database releases; they were superseded with Setup retirement. Follow the [current Database MCP release and authentication contract](../apps/database-mcp-worker/README.md) and [production retirement readback](runtime-configuration.md) instead. Browser activation and EdgeSSH remain separate resources; their historical and current requirements are not waived by this Database retirement.

## Verified configuration at design time

A read-only, paginated Cloudflare Access inventory on 2026-11-04 found 19 applications and two existing identity providers: One-time PIN and **Cloudflare account members** (`restrict_to_account_members=true`). The relevant existing self-hosted applications, their current single-IDP selection, and unchanged durations are:

| Owner entrypoint | Present method | App session | Proposed |
| --- | --- | --- | --- |
| Browser Production Profile Activation (`/activate/verify/*`) | OTP only | 15m | Cloudflare account + OTP |
| Database MCP Owner Setup (`database.lirtual.dpdns.org`) | OTP only | 15m | Cloudflare account + OTP |
| EdgeSSH (`ssh.lirtual.dpdns.org`) | OTP only | 720h | Cloudflare account + OTP |
| Browser Production Owner Approval (`/owner/*`) | OTP only | 15m | **Retire** after its routes are safely disabled |

All four currently use one identical **exact Owner email** Allow selector; the reviewed policies do not have additional Require/Exclude rules. Keep the exact Owner address confidential; do not widen the allowlist to every Cloudflare account member or change policy precedence. The Weixin setup application is legacy and excluded. App Launcher has different, multiple allowed email selectors and is not an Owner-only application. MCP/Portal applications, OAuth clients, `MCP_ACCESS_TOKEN`, signed WebSockets, and Agent pairing are out of scope.

## Login behavior and unchanged authorization boundary

For the three active Owner entrypoints only, enable the **already configured** Cloudflare identity provider alongside the existing OTP provider in each application's `allowed_idps`. Do not enable instant authentication/automatic redirect to a single IdP; users need both login options. Keep each application's audience, domain/path, exact-email Allow policy, duration and security controls unchanged. Cloudflare SSO may reuse a valid global IdP session, but application sessions remain independently bounded; no promise of permanent authentication. OTP remains an alternate path and does **not** enforce Cloudflare-account MFA. This is a deliberate usability versus uniform-MFA trade-off.

Prior to a real cutover, prove that the Cloudflare-account IdP emits the expected exact Owner email. A different or missing email must **fail closed**, not induce changing `OWNER_EMAIL`, broadening Access policies, or accepting arbitrary account members. Preserve Database `ctx.access`/JWT audience/issuer/email verification, CSRF and Owner rate limiting. Preserve Browser activation's independent JWT issuer/audience/Owner-email checks, exact extension installation ID, **same initiating Profile one-use proof**, and local owner-initiated activation. Browser Owner Review isolation is **not** a prerequisite for activation; it never supplies the activation proof. Do not reintroduce per-operation approval.

## Browser Owner Review retirement (see Browser ADR 0004)

The following Browser source contract was approved and implemented as a candidate on 2026-11-04, then separately authorized, deployed, and verified on 2026-11-05:
- Remove the Browser Worker `/owner/unknown/*` GET/POST flow, dedicated Review Access identity verifier/config and the coordinator's `owner-unknown-view`/`owner-unknown-report` handlers, associated URLs, standalone UI and tests. Remove stale `owner_review_url` and `safe_next_action` instructions directing users to an independent Review page from **both** the coordinator and intent-ledger responses; preserve honest Unknown/no-retry guidance. Retired paths must fail closed (404) and cannot become publicly available when Access is later removed. Keep protected-target exclusions for live activation routes; do not broaden browser control just because Review is retired.
- Remove only Review-specific code, references, and release-time variables once verified unused; **retain** `BROWSER_OWNER_EMAIL`, `BROWSER_ACCESS_ISSUER`, the separate Browser Activation audience/config and other activation protections. Do not alter or wipe historical Durable Object tables or previously recorded `owner_reported_resolution` facts.
- Preserve `browser_operation_status`, original `operation_id`/`intent_key`, historical receipts, the existing signed late-receipt transition rules, and **no automatic replay** of Unknown. No manual report, automatic resolution, or fabricated website result replaces the retired page.
- Replace the permanent cumulative `unknown_capacity_exceeded` admission count with **at most 100 unresolved Unknown operations whose server-created `created_at` is within the preceding 7×24 hours**, across the existing single Owner Durable Object. Keep the current 100 threshold; count `state='unknown' AND created_at >= now - 7 days`, using trusted server time. This fixes the long-term lockout without a schema change, timer, purge, or another service.
- Old Unknown rows never change state merely because they age out of the **capacity count**; they remain readable and non-replayable. New recent Unknowns still trip the cap; existing receipt/status reads remain available during capacity refusal. Historical `owner_reported_resolution` rows remain intact, including the ability of an authentic late extension receipt to settle an otherwise eligible older operation. Do not use aging as completion evidence.
- Storage can continue to grow because historical Unknowns are deliberately retained; this accepted trade-off is separate from the **admission** limit. Any future retention policy or destructive purge needs a new decision and authorization.

### Original cutover ordering and acceptance gates (historical plan)

1. Review exact live IdP, application identity, Owner email selector, session settings, current Worker/routes and fallback path. Record only sanitized configuration identifiers; do not expose personal addresses or tokens.
2. Change source and existing targeted tests first. Confirm direct Worker `/owner/*` denial and absence of internal Review handlers, unchanged activation, existing record readback, no duplicate effects, Unknown 100/101 capacity boundary, 7-day boundary, historical Unknown persistence and valid late receipts. Do not introduce a second CI or new storage model.
3. After separately approved Worker release, independently verify the old Review route is denied and Browser Activation still works. **Only then**, with separate explicit authorization, retire the now-unused Cloudflare **Browser Production Owner Approval** Access app and its Review-only config; never delete the shared Browser Activation Access app or its required settings. A failed or Unknown cutover requires readback, not blind retry or removal of protection.
4. For each of the three active Owner apps, separately approve the minimal `allowed_idps` change while retaining the exact Owner policies. Verify Cloudflare-account login, OTP fallback, expected claims/identity, route-specific denial for wrong Owner/audience, and original session durations. If login fails, restore the prior IdP list without weakening the Owner grant. No Worker release should be necessary solely for the login-method change.
5. Confirm no unexpected Browser control authority, replays, loss of historical receipts, credential changes or changes to unrelated MCP/Portal/legacy apps. Track source, CI, Access readback, released Worker and real client login as **separate** acceptance statuses.

## Production completion (2026-11-05)

- Browser Worker [release #41871291888](https://github.com/lirtual/mcp-workers/actions/runs/41871291888) passed; Cloudflare independently confirmed version `3943aa81-23c1-4b31-805c-3a2a93e3846c` at 100% traffic with the original Durable Object namespace and seven activation-required bindings.
- The separate Browser Owner Review Access app was deleted only after the Worker cutover. Public `/owner/unknown/*` then returned 404 while `/activate/verify/*` still required Access. See [production retirement evidence](https://github.com/lirtual/mcp-workers/pull/716#issuecomment-6636929175).
- Browser Activation, Database Owner Setup, and EdgeSSH were switched **individually** to existing account-member-restricted Cloudflare SSO **plus** OTP, without changing their exact Owner Allow policies, audiences, domains, or session lengths. Their API readbacks and the Owner's separate real SSO/OTP login and original-feature confirmations are documented in the [final acceptance record](https://github.com/lirtual/mcp-workers/pull/715#issuecomment-6646761813). The original plan and historical waivers above remain historical evidence, not newly performed tests.
- At the 2026-11-05 migration, subsequent Browser and Database releases were expected to **reject OTP-only rollback** and verify their then-active Owner Access configuration. This is **historical for Database**: after Spec #760 and the 2026-11-10 Owner Setup retirement, no Database Setup SSO/OTP release gate remains. Current Database releases follow the [Database MCP README](../apps/database-mcp-worker/README.md); Browser activation retains its independent identity requirements.

## Source anchors

- [Browser activation / Owner routes](../apps/browser-mcp-worker/src/worker.ts), [Owner JWT verifier](../apps/browser-mcp-worker/src/approval-auth.ts), [Coordinator](../apps/browser-mcp-worker/src/coordinator.ts), [Intent ledger](../apps/browser-mcp-worker/src/intents.ts).
- [Current Database MCP contract](../apps/database-mcp-worker/README.md) (supersedes the removed historical `src/setup/access.ts` verification); [Browser ADR 0002](../apps/browser-mcp-worker/docs/adr/0002-profile-grant-not-business-authorization.md) is superseded **only** for the independent Unknown-review-channel requirement by [ADR 0004](../apps/browser-mcp-worker/docs/adr/0004-retire-owner-unknown-review.md).
- Cloudflare docs: [Cloudflare identity provider](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/), [session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/).
