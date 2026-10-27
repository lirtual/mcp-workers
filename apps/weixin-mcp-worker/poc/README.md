# Weixin iLink direct-protocol feasibility gate — Spec #346

This is a **non-production, mock-only experiment**, not a usable ChatGPT plugin.
Run `node --test poc/*.test.mjs` or `pnpm --filter weixin-mcp-worker check` from the workspace.
It **never automatically connects to Weixin**; all automated tests inject a fake HTTP transport.

The Tencent protocol is derived from `Tencent/openclaw-weixin/docs/protocol.md` (reviewed 2026-10-27). Wire-format examples are **not** proof of standalone server support. The adapter fixes `https://ilinkai.weixin.qq.com`; refuses all HTTP redirects and unreviewed `redirect_host`; bounds JSON/input; treats uncertain sends as unknown; never claims delivered or retries. A changed server-directed baseurl will require an explicit host review before support. The sample current client version `2.4.8` is used only for a controlled compatibility experiment, **not** as a promise of future client compatibility.

## Required gates before committing to a live Worker design

1. Owner explicitly ratifies or revises Q8–Q14 and separately authorizes a **real account** PoC. Never reuse a pre-existing OpenClaw active session without verifying single-consumer behavior.
2. Use a safe owner-only browser QR flow; validate `ilink_user_id` from scan **against an independent identity proof** from subsequent inbound text. Do not assume an arbitrary first sender is the owner. Do not print QR, bot token, context token, user IDs, verification codes, payload text, or cursor.
3. Observe the live QR → verified inbound → send HTTP result → actual handset message, including no competing consumer. Record only sanitized version, timestamp, success/failure classification, and **independent device observation**.
4. Validate short idle, longer idle, reactivation, `-14` stale session, cursor progress with on-demand long-poll and upper request-timeout constraints. Determine whether scheduled polling is truly necessary before adopting Cron.
5. Only after a positive go/no-go decision implement Access owner UI, encrypted D1 generation-fenced binding/cursor, persisted pre-dispatch idempotency receipt, the **exact two MCP tools**, Portal registration, CI and selected-worker release gates. Do not interpret a mock green run as proof of these.
6. Distinct final acceptance: CI mock Pass, protocol live PoC Pass, secure Cloudflare/Portal Pass, real ChatGPT-to-phone Pass. Failed or unsupported iLink behavior means **stop**, not extra daemons, blind retries or automatic OpenClaw Gateway fallback.

## Explicit exclusions

No production Wrangler config, D1, Cloudflare secrets, Portal registration, Worker release allowlist, real account usage, cron, external Node service, or automatic email/Weixin notifications are provided by this experiment. Until the gates pass, any write tool must remain unavailable.
