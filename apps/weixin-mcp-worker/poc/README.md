# Weixin iLink direct-protocol feasibility gate — Spec #346

This is a **non-production, owner-supervised feasibility experiment**, not a usable ChatGPT plugin. The automated tests use mocks; the optional explicit local pairing workflow uses real Tencent iLink requests and requires the owner's own QR scan.
Run `node --test poc/*.test.mjs` or `pnpm --filter weixin-mcp-worker check` from the workspace.
Automated tests **never automatically connect to Weixin**; every protocol test injects a fake HTTP transport. The local pairing page starts no upstream request until the owner explicitly clicks Create QR.

The Tencent protocol is derived from `Tencent/openclaw-weixin/docs/protocol.md` (reviewed 2026-10-27). Wire-format examples are **not** proof of standalone server support. A supervised QR-endpoint request on 2026-10-27 returned an HTTPS QR target on `liteapp.weixin.qq.com`; the PoC now rejects all other QR origins and URL userinfo, even if provided by upstream. This observed host is a **PoC allowlist**, not a promise of permanent Tencent protocol compatibility. The adapter fixes `https://ilinkai.weixin.qq.com`; refuses all HTTP redirects and unreviewed `redirect_host`; bounds JSON/input; treats uncertain sends as unknown; never claims delivered or retries. A changed server-directed baseurl will require an explicit host review before support. The sample current client version `2.4.8` is used only for a controlled compatibility experiment, **not** as a promise of future client compatibility.

## Required gates before committing to a live Worker design

1. **Approved on 2026-10-27:** Q8–Q14 were ratified and supervised real-account PoC was authorized. Never share an active Weixin session with another OpenClaw consumer: use only the owner's own ClawBot and stop on stale-session or competing-consumer symptoms.
2. Use a safe owner-only browser QR flow; validate `ilink_user_id` from scan **against an independent identity proof** from subsequent inbound text. Do not assume an arbitrary first sender is the owner. Do not print QR, bot token, context token, user IDs, verification codes, payload text, or cursor.
3. Observe the live QR → verified inbound → send HTTP result → actual handset message, including no competing consumer. Record only sanitized version, timestamp, success/failure classification, and **independent device observation**.
4. Validate short idle, longer idle, reactivation, `-14` stale session, cursor progress with on-demand long-poll and upper request-timeout constraints. Determine whether scheduled polling is truly necessary before adopting Cron.
5. Only after a positive go/no-go decision implement Access owner UI, encrypted D1 generation-fenced binding/cursor, persisted pre-dispatch idempotency receipt, the **exact two MCP tools**, Portal registration, CI and selected-worker release gates. Do not interpret a mock green run as proof of these.
6. Distinct final acceptance: CI mock Pass, protocol live PoC Pass, secure Cloudflare/Portal Pass, real ChatGPT-to-phone Pass. Failed or unsupported iLink behavior means **stop**, not extra daemons, blind retries or automatic OpenClaw Gateway fallback.

## Explicit exclusions

No production Wrangler config, D1, Cloudflare secrets, Portal registration, Worker release allowlist, cron, external Node service, or automatic email/Weixin notifications are provided by this experiment. The temporary localhost page is not a persistent MCP endpoint; send remains blocked until the owner passes a fresh challenge and explicitly presses the one-time send button.


## Supervised local QR PoC (separate from automated tests)

From the isolated worktree, run `node apps/weixin-mcp-worker/poc/local-pairing.mjs`. On the **same Windows machine hosting WSL**, open `http://localhost:45346/` in a regular browser (WSL localhost forwarding must be enabled). Never expose that listener via a tunnel or public proxy. The server binds **127.0.0.1** only, expires after 12 minutes, and keeps QR, credentials, owner ID, cursor, inbound and outbound context strictly in volatile memory. Its SVG QR rendering invokes the already-installed `libqrencode.so.4` through Python `ctypes`; no third-party QR service or new production dependency is used.

Click **Create temporary QR** only when ready to scan the resulting QR with the owner's Weixin on a **separate mobile screen**. Click **Check scan confirmation**, then send the page's random `WX346-` proof **as an exact standalone inbound text message** to the scanned ClawBot conversation. Click **Verify incoming owner message**; a successful ID match *alone* never activates the send button. On `ready`, an additional explicit click authorizes **one** bounded PoC text message. The browser reports `accepted`, `rejected`, or `unknown`, never `delivered`; the owner must independently confirm handset visibility. A second send is never dispatched by the same session, including ambiguous/time-out results.

Safety: do not copy credentials or QR data into chat, logs, issues, screenshots, shell history or filenames. Verify no other consumer owns the bot session before using this experiment. QR states requiring a verify code or an unreviewed redirect intentionally stop in the prototype (they do not trigger fallback). Any loss of the terminal or session state voids the test; fresh scan is required. No credential remains valid for use by this application after process termination, though Weixin upstream revocation is **not** asserted.

**Manual acceptance evidence currently not satisfied:** browser visibility, scan confirmation, proof inbound, upstream send and handset receipt are separate gates. Document only sanitized status and timing after actual observation.
