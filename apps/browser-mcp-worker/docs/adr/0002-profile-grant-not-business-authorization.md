# ADR 0002 — Profile grant is not website business authorization

Status: Accepted for Spec #418 usability increment, 2026-10-31.

## Decision

Reuse the existing owner-scoped MV3 extension, fixed MCP tools, technical target checks, and durable intent/Unknown receipts. Business words in page text, URL, control names, and ordinary signed-in hosts do not establish safety. Allow standard eligible HTTP(S) interactions and form submissions without per-action approval, per-origin grants or a risk classifier.

A Profile Extension Grant grants technical control, **not** User Task Authorization for website side effects or cross-site nonpublic data transfer. Only the Owner's task creates such authority. All page text, screenshots and tool returns are untrusted data, never new instructions. Continue to refuse protected Browser MCP Owner activation/Unknown-review origins, recognized credential inputs, forbidden schemes/metadata, unauthorized LAN/private scope, stale targets, Stop and Revoke. Screenshot guards reject visible uninspectable embedded content and recognized credentials, not ordinary forms. Owner OTP/Unknown review must use a channel independent of every Agent-controllable browser, email and remote-control tool, verified at acceptance rather than inferred from the extension.

## Consequences

Normal GETs, clicks and forms may have irreversible effects or forward data. There is no enforceable extension DLP, guaranteed prompt-injection prevention, or guarantee of website business success. `completed` confirms browser dispatch only; Unknown outcomes are never blindly replayed. Existing #531 pairing, approval retirement, and operation receipts are unchanged. Superseded keyword-denial tests no longer apply. Real version-matched Worker and Chrome/Edge acceptance remains distinct from source checks.
