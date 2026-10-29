# ADR 0001 — Pure MV3 extension over WSS to a Cloudflare owner coordinator

Status: Accepted for Spec #418, T1 base.

## Decision

Use the existing desktop Chrome/Edge profile with an unpacked MV3 extension. The extension initiates TLS WebSocket connections to its own dedicated Cloudflare Worker and one owner-scoped SQLite-backed Durable Object. The MCP endpoint reuses the shared Portal Bearer validator but requires an independently configured token value. The extension has an independent high-entropy Endpoint credential. It stores control authorization locally and does not rely on an OS Agent, Native Messaging, local Node service, hosted browser, a second Worker, or KV/D1/R2.

## Reasons

This is the only approach within the owner's "extension only, existing logged-in profile" deployment boundary. The DO holds bounded owner coordination and connection generation, and the extension executes only curated actions inside its Profile under local control. Remote Control's Agent and retired Browser Handoff are intentionally separate.

## Consequences

Cloudflare Access owner approval and high-impact browser operations belong to later tickets, not to this T1 scaffold. Cloudflare DO state and actual website outcomes are not atomic, so consequential actions must use prepare/execute and Unknown receipts rather than replay; no such actions are enabled in T1. Browser profile compromise, DNS rebinding and sensitive text leakage cannot be solved merely by WSS encryption.
