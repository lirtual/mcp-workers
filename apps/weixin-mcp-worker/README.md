# Weixin MCP Worker · implementation status (Spec #346)

This directory contains a **non-production first implementation slice** plus an owner-supervised local PoC. No production Cloudflare credentials, D1 databases, Worker routes or Access policies have been created by this PR.

## Implemented
- `/mcp` ingress at the exact configured `MCP_HOST` over HTTPS, with shared Portal Bearer authentication and a separate business domain. A separate HTTPS `ADMIN_HOST` serves Access JWT-verified owner-only `GET /setup` status and CSRF-protected `POST /setup/unbind` (local credential revocation only). No QR pairing route is enabled yet; the Access policy and host are not provisioned.
- Exactly two MCP tools: `weixin_status` (read only) and `weixin_send_message` (explicit external write). `text` and caller-generated UUID `request_id` are the only send arguments. `status=accepted` is upstream acceptance, **never** handset delivery.
- D1 migration `migrations/0001_owner.sql`: singleton generation-bound binding row, encrypted expiring QR/pairing staging row, and immutable-on-unknown send receipts; no message history or plaintext QR/token/proof/text columns.
- Per-generation AES-GCM associated-data protection for account tokens, recipient/context and cursor; tested cross-generation decryption refusal. Credentials and incoming messages must never be logged.
- Atomically reserve `(generation,request_id)` before any iLink dispatch. Exact duplicate returns the stored outcome without dispatch; same ID with different text rejects. Unknown/crashed write stays reserved, including after process restart. No automatic retry or unknown-receipt deletion.
- Manual iLink PoC in `poc/` has previously demonstrated one owner-confirmed full handset delivery. Production lifetime or idle reliability is **not** established.

## Verification (no provider writes)
Run `corepack pnpm --filter weixin-mcp-worker check`. The local tests cover authenticated MCP `tools/list`, denied ingress, status and nonready send, D1 SQLite constraints, encryption, duplicate send IDs, unknown outcomes and concurrent same-ID calls, plus PoC mocks.

The integration tests use SQLite as a local adapter to exercise the D1-compatible statements. The Wrangler **local dry-run bundle** passed, with no deployment or bindings; actual Cloudflare D1 semantics and Access/Portal tool calls still need independent verification. No live send is made by tests.

## Owner pairing flow (staged code, NOT activated)
1. Open the Access-protected `/setup` page. Explicitly request a QR; the URL is encoded into an SVG **within the Worker**, with no third-party QR renderer.
2. Scan in Weixin and poll through an authenticated CSRF-protected form. The QR and bot credentials stay encrypted in the singleton staging row. Pending stage is bound to the Access subject hash and binding generation, with a 10-minute expiry, up to 5 QR starts/hour, bounded polling and 3 optional verify-code attempts.
3. Once confirmed, send the displayed unique `WX346-...` proof as one inbound ClawBot message. The page verifies both the exact scanned user ID and inbound proof before activating the new generation. Existing binding remains active until final success; overlapping send/sync/unbind operations serialize on the original D1 lease.
4. Local unbind increments the generation, clears active credentials and scrubs staging ciphertext; **this does not revoke any upstream Tencent credential**. Rebinding also does not establish handset delivery or idle-session reliability.

## Not yet implemented / hard blockers
- Real Cloudflare D1/workerd validation of multi-request CAS and Access-protected QR web flow is pending. An SQLite fixture plus dry-run bundle does not establish production D1 semantics.
- Independent review of QR-code generation dependency and exact Tencent QR expiry/verification behavior; tests are mocked and MUST be run and checked before claiming this stage verified.
- Durable ciphertext key rotation orchestration, anti-enumeration/rate limiting under multi-region concurrent requests.
- Actual Wrangler D1 database ID/routing, owner Access policy, production secrets, Portal registration, ChatGPT tool invocation, workerd tests, idle/reactivation checks.
- Main-only authorized release gate remains deliberately closed; CI success is not deploy approval.

Do **not** introduce a placeholder production database ID or default route just to make a dry run pass. The deployment wiring requires separate authorization and owned Cloudflare resources. Keep PR #348 Draft, Issue #346 open.
