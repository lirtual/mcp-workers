# Weixin MCP Worker — bounded context (Spec #346)

Owns the single-owner Weixin ClawBot binding and an explicit outbound text tool, subject to an independently verified upstream iLink session contract. This context never owns Portal authentication, other Weixin contacts, broadcast, general OpenClaw Gateway, message history, or unsolicited background notifications.

**Status: unapproved upstream feasibility gate.** The `poc/` code is an isolated in-memory wire-protocol experiment with mocked responses; it is **not** a running Worker, MCP endpoint, Access management UI, durable binding or production feature. The release selector deliberately excludes it until Q8–Q14 are ratified, real-account PoC permission is separately granted, and independent handset delivery is demonstrated. Keep the Issue open and the PR Draft until complete.
