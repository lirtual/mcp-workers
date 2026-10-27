# Weixin MCP Worker — bounded context (Spec #346)

Owns the **single-owner** Weixin ClawBot binding, bounded authenticated iLink monitoring, and explicit outbound text. Excludes arbitrary friends/groups, inbound chat mirroring, background notifications, and a full OpenClaw Gateway.

**Status: implementation in Draft PR #348, not deployable.** The owner-supervised localhost PoC proved one actual QR → identity proof → text send → handset delivery on 2026-10-27. One delayed handset receipt also exposed an ambiguous iLink API acknowledgment; absence of `ret` is classified as `unknown`, never as a proven failure.

The current staged Worker code defines exactly two MCP tools, Portal bearer boundary, encryption primitives, independent D1 schema, and durable send claim. The **owner-only Access QR admin interface is not yet implemented**, and there is no provisioned D1 binding, verified production host, Wrangler deployment configuration, Portal registration or ChatGPT live call. A sending request cannot become usable without an encrypted, owner-verified ready session. No manual release selector entry has been granted.

Critical implementation gap: cross-request state-change fencing during in-flight sends/rebind. The D1 generation check before transport alone does not fully eliminate rebind/send TOCTOU. Do not enable management rebind or production writes before a tested fence resolves this. No Cron, durable object, queue or retry scheduler without measured necessity.

Follow [Issue #346](https://github.com/lirtual/mcp-workers/issues/346). Keep Issue open, PR Draft, production NO-GO.
