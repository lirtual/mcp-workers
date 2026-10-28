# Weixin MCP Worker · production integration (Spec #346)

[Issue #346](https://github.com/lirtual/mcp-workers/issues/346) is closed. PR #348 established the production Worker, dedicated D1, Access-protected owner pairing and ChatGPT Portal connection; PR #364 added send-before-sync. The owner confirmed two actual messages on the handset on 2026-10-27. Both API receipts are `unknown`, not evidence of accepted delivery. Long-idle session recovery is not guaranteed.

## Implemented
- `/mcp` ingress at the exact configured `MCP_HOST` over HTTPS, with shared Portal Bearer authentication and a separate business domain. A separate HTTPS `ADMIN_HOST` implements Access JWT-verified owner-only `GET /setup` plus CSRF-protected QR start, scan poll, proof verification, local rebind and unbind forms. The owner-only setup and live Worker endpoint have been activated and verified in production.
- Exactly two MCP tools: `weixin_status` (read only) and `weixin_send_message` (explicit external write). `text` and caller-generated UUID `request_id` are the only send arguments. `status=accepted` is upstream acceptance, **never** handset delivery.
- D1 migration `migrations/0001_owner.sql`: singleton generation-bound binding row, encrypted expiring QR/pairing staging row, and immutable-on-unknown send receipts; no message history or plaintext QR/token/proof/text columns.
- Per-generation AES-GCM associated-data protection for account tokens, recipient/context and cursor; tested cross-generation decryption refusal. Credentials and incoming messages must never be logged.
- Atomically reserve `(generation,request_id)` before any iLink dispatch. Exact duplicate returns the stored outcome without dispatch; same ID with different text rejects. Unknown/crashed write stays reserved, including after process restart. No automatic retry or unknown-receipt deletion.
- Manual iLink PoC in `poc/` has previously demonstrated one owner-confirmed full handset delivery. Production lifetime or idle reliability is **not** established.

## Verification (no provider writes)
The existing application checks cover the offline Node, SQLite and local Miniflare/workerd/D1 suites, including synthetic QR → owner proof → binding, encryption, leases, MCP ingress and send deduplication. They do not write to Tencent or production Cloudflare. The existing CI also runs an offline mocked Weixin Portal registration contract, including Access verification and failure-before-mutation checks. CI is not a substitute for production acceptance.

Run `corepack pnpm --filter weixin-mcp-worker check`. The local tests cover authenticated MCP `tools/list`, denied ingress, status and nonready send, D1 SQLite constraints, encryption, duplicate send IDs, unknown outcomes and concurrent same-ID calls, plus PoC mocks.

The Node tests use SQLite for fast D1-compatible statement regression; the new Miniflare suite additionally exercises local workerd-backed D1 and MCP requests. Neither substitutes for deployed Cloudflare D1/Access/Portal verification. Wrangler dry-run provisions nothing; none of these tests send a live message.

## Owner pairing flow (production active)
1. Open the Access-protected `/setup` page. Explicitly request a QR; the URL is encoded into an SVG **within the Worker**, with no third-party QR renderer.
2. Scan in Weixin and poll through an authenticated CSRF-protected form. The QR and bot credentials stay encrypted in the singleton staging row. Pending stage is bound to the Access subject hash and binding generation, with a 10-minute expiry, up to 5 QR starts/hour, bounded polling and 3 optional verify-code attempts.
3. Once confirmed, send the displayed unique `WX346-...` proof as one inbound ClawBot message. The page verifies both the exact scanned user ID and inbound proof before activating the new generation. Existing binding remains active until final success; overlapping send/sync/unbind operations serialize on the original D1 lease.
4. Local unbind increments the generation, clears active credentials and scrubs staging ciphertext; **this does not revoke any upstream Tencent credential**. Rebinding also does not establish handset delivery or idle-session reliability.

## Remaining verification and boundaries
- Long-idle owner-context recovery remains unverified. A bounded, lease-protected `getUpdates` sync runs only when explicitly sending; failure prevents the new dispatch.
- Only a direct message from the verified owner can refresh an encrypted context token. Incoming message content is discarded, and no background polling is introduced.
- Never automatically retry a prior `unknown` request. An upstream `accepted` response would not prove handset delivery.
- Portal registration requires matching Cloudflare Access policies and must fail before mutation if Access cannot be verified. Reuse the existing main-only manual registration workflow; it does not run as part of this source change.
