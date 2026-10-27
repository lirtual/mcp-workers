# Weixin MCP Worker · implementation status (Spec #346)

This directory contains a **non-production first implementation slice** plus an owner-supervised local PoC. No production Cloudflare credentials, D1 databases, Worker routes or Access policies have been created by this PR.

## Implemented
- `/mcp` ingress at the exact configured `MCP_HOST` over HTTPS, with shared Portal Bearer authentication and a separate business domain. Administrative routes are **404**, not publicly usable.
- Exactly two MCP tools: `weixin_status` (read only) and `weixin_send_message` (explicit external write). `text` and caller-generated UUID `request_id` are the only send arguments. `status=accepted` is upstream acceptance, **never** handset delivery.
- D1 migration `migrations/0001_owner.sql`: singleton generation-bound binding row and immutable-on-unknown send receipts; no message history, phone contacts, QR or text body columns.
- Per-generation AES-GCM associated-data protection for account tokens, recipient/context and cursor; tested cross-generation decryption refusal. Credentials and incoming messages must never be logged.
- Atomically reserve `(generation,request_id)` before any iLink dispatch. Exact duplicate returns the stored outcome without dispatch; same ID with different text rejects. Unknown/crashed write stays reserved, including after process restart. No automatic retry or unknown-receipt deletion.
- Manual iLink PoC in `poc/` has previously demonstrated one owner-confirmed full handset delivery. Production lifetime or idle reliability is **not** established.

## Verification (no provider writes)
Run `corepack pnpm --filter weixin-mcp-worker check`. The local tests cover authenticated MCP `tools/list`, denied ingress, status and nonready send, D1 SQLite constraints, encryption, duplicate send IDs, unknown outcomes and concurrent same-ID calls, plus PoC mocks.

The integration tests use SQLite as a local adapter to exercise the D1-compatible statements. The Wrangler **local dry-run bundle** passed, with no deployment or bindings; actual Cloudflare D1 semantics and Access/Portal tool calls still need independent verification. No live send is made by tests.

## Not yet implemented / hard blockers
- Owner-only QR admin and CSRF with Access JWT, scan identity proof, durable QR expiry and owner-only unbind/rebind.
- Tested cross-request **rebind vs. in-flight send** fence, bounded cursor writer lease/CAS and session lifecycle.
- Durable ciphertext key rotation orchestration, anti-enumeration/rate limiting under multi-region concurrent requests.
- Actual Wrangler D1 database ID/routing, owner Access policy, production secrets, Portal registration, ChatGPT tool invocation, workerd tests, idle/reactivation checks.
- Main-only authorized release gate remains deliberately closed; CI success is not deploy approval.

Do **not** introduce a placeholder production database ID or default route just to make a dry run pass. The deployment wiring requires separate authorization and owned Cloudflare resources. Keep PR #348 Draft, Issue #346 open.
