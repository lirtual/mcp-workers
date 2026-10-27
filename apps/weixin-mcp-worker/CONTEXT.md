# Weixin MCP Worker — bounded context (Spec #346)

Owns the **single-owner** Weixin ClawBot binding, bounded authenticated iLink monitoring, and explicit outbound text. Excludes arbitrary friends/groups, inbound chat mirroring, background notifications, and a full OpenClaw Gateway.

**Status: implementation in Draft PR #348, not deployable.** The owner-supervised localhost PoC proved one actual QR → identity proof → text send → handset delivery on 2026-10-27. One delayed handset receipt also exposed an ambiguous iLink API acknowledgment; absence of `ret` is classified as `unknown`, never as a proven failure.

The current staged Worker code defines exactly two MCP tools, Portal bearer boundary, encryption primitives, independent D1 schema, and durable send claim. The **owner-only Access QR/poll/proof/rebind/local-unbind UI** is implemented in the Draft branch but has not passed final acceptance; there is no provisioned D1 binding, verified production host, Wrangler deployment configuration, Portal registration or ChatGPT live call. A sending request cannot become usable without an encrypted, owner-verified ready session. No manual release selector entry has been granted.

The staged implementation serializes send, cursor sync and local unbind with a 120-second D1 lease; request IDs remain unique across generations. An already dispatched upstream write cannot be cancelled, and expiry is a bounded recovery mechanism, not exactly-once delivery. **QR issuance, polling and activation acquire the same lease.** Rebind and QR verification are still mock-tested only, and must pass real D1/Access concurrency validation before exposure. No Cron, durable object, queue or retry scheduler without measured necessity.

Follow [Issue #346](https://github.com/lirtual/mcp-workers/issues/346). Keep Issue open, PR Draft, production NO-GO.
