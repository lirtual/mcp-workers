# Weixin MCP Worker — bounded context (Spec #346)

Owns the **single-owner** Weixin ClawBot binding, bounded authenticated iLink monitoring, and explicit outbound text. Excludes arbitrary friends/groups, inbound chat mirroring, background notifications, and a full OpenClaw Gateway.

**Status (2026-10-27):** [Issue #346](https://github.com/lirtual/mcp-workers/issues/346) is closed, PRs #348 and #364 are merged, and the production Worker and ChatGPT connection have been verified. The owner has confirmed two outbound messages on the handset. Both upstream send receipts remain `unknown`; handset confirmation must not be inferred from those receipts. A ready binding does not guarantee a valid context after prolonged inactivity.

The Worker performs one bounded, on-demand `getUpdates` sync before each new outbound request. It accepts context only from direct messages by the verified owner to the bound bot, encrypts the cursor/context, and discards inbound message bodies. A failed sync blocks the new send. The 120-second D1 lease serializes send, cursor sync, QR issue/poll/activation and local unbind; request IDs are generation-fenced and previously `unknown` writes are never automatically retried. There is no Cron, Queue, Durable Object or background polling.

The Access-protected owner pairing page, dedicated D1 and Portal integration are operational. Long-idle recovery remains an upstream-dependent boundary, not a verified guarantee. Further Portal registration and production changes must follow existing release authorization; changes to source do not independently change production.
