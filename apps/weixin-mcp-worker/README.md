# Weixin MCP Worker · implementation status (Spec #346)

This directory contains a **non-production first implementation slice** plus an owner-supervised local PoC. No production Cloudflare credentials, D1 databases, Worker routes or Access policies have been created by this PR.

## Implemented
- `/mcp` ingress at the exact configured `MCP_HOST` over HTTPS, with shared Portal Bearer authentication and a separate business domain. A separate HTTPS `ADMIN_HOST` implements Access JWT-verified owner-only `GET /setup` plus CSRF-protected QR start, scan poll, proof verification, local rebind and unbind forms. These routes exist in the Draft code but the Access policy and host have **not** been provisioned.
- Exactly two MCP tools: `weixin_status` (read only) and `weixin_send_message` (explicit external write). `text` and caller-generated UUID `request_id` are the only send arguments. `status=accepted` is upstream acceptance, **never** handset delivery.
- D1 migration `migrations/0001_owner.sql`: singleton generation-bound binding row, encrypted expiring QR/pairing staging row, and immutable-on-unknown send receipts; no message history or plaintext QR/token/proof/text columns.
- Per-generation AES-GCM associated-data protection for account tokens, recipient/context and cursor; tested cross-generation decryption refusal. Credentials and incoming messages must never be logged.
- Atomically reserve `(generation,request_id)` before any iLink dispatch. Exact duplicate returns the stored outcome without dispatch; same ID with different text rejects. Unknown/crashed write stays reserved, including after process restart. No automatic retry or unknown-receipt deletion.
- Manual iLink PoC in `poc/` has previously demonstrated one owner-confirmed full handset delivery. Production lifetime or idle reliability is **not** established.

## Verification (no provider writes)
The Draft check pipeline now includes `tests/workerd.test.mjs` after the Wrangler dry-run bundle. It uses the same pinned Miniflare already used by OpenList: a fully local Workerd process and disposable D1 database execute the actual migration, MCP ingress, durable lease/receipt operations, and application QR→owner-proof→generation-switch logic with injected **synthetic** Tencent responses. It cannot create Cloudflare resources, call the real Tencent API, or replace an actual account-owner acceptance.

**Verification status:** these new runtime tests have been committed but have **not yet completed a CI run at the current HEAD**. Earlier 49/49 Weixin application/PoC checks and whole-repository CI Success apply only to commit `1620e2d1`. Do not promote this added coverage to Pass until a matching-SHA runner finishes.

Run `corepack pnpm --filter weixin-mcp-worker check`. The local tests cover authenticated MCP `tools/list`, denied ingress, status and nonready send, D1 SQLite constraints, encryption, duplicate send IDs, unknown outcomes and concurrent same-ID calls, plus PoC mocks.

The Node tests use SQLite for fast D1-compatible statement regression; the new Miniflare suite additionally exercises local workerd-backed D1 and MCP requests. Neither substitutes for deployed Cloudflare D1/Access/Portal verification. Wrangler dry-run provisions nothing; none of these tests send a live message.

## Owner pairing flow (staged code, NOT activated)
1. Open the Access-protected `/setup` page. Explicitly request a QR; the URL is encoded into an SVG **within the Worker**, with no third-party QR renderer.
2. Scan in Weixin and poll through an authenticated CSRF-protected form. The QR and bot credentials stay encrypted in the singleton staging row. Pending stage is bound to the Access subject hash and binding generation, with a 10-minute expiry, up to 5 QR starts/hour, bounded polling and 3 optional verify-code attempts.
3. Once confirmed, send the displayed unique `WX346-...` proof as one inbound ClawBot message. The page verifies both the exact scanned user ID and inbound proof before activating the new generation. Existing binding remains active until final success; overlapping send/sync/unbind operations serialize on the original D1 lease.
4. Local unbind increments the generation, clears active credentials and scrubs staging ciphertext; **this does not revoke any upstream Tencent credential**. Rebinding also does not establish handset delivery or idle-session reliability.

## Not yet implemented / hard blockers
- Current-head CI for the new local workerd D1 suite and signed Access browser flow is still unconfirmed. Deployed Cloudflare D1, Access policy and multi-request QR acceptance remain independently pending.
- Independent review of the pinned QR encoder and Tencent QR expiry/verification behavior; local protocol responses are synthetic, not evidence of Tencent production compatibility.
- Durable ciphertext key rotation orchestration, anti-enumeration/rate limiting under multi-region concurrent requests.
- Actual Wrangler D1 database ID/routing, owner Access policy, production secrets, Portal registration, ChatGPT tool invocation, real Cloudflare D1/Access acceptance, idle/reactivation checks.
- Main-only authorized release gate remains deliberately closed; CI success is not deploy approval.

Do **not** introduce a placeholder production database ID or default route just to make a dry run pass. The deployment wiring requires separate authorization and owned Cloudflare resources. Keep PR #348 Draft, Issue #346 open.
