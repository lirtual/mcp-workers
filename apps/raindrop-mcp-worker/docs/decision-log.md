# Raindrop MCP architecture decision log

This file records user-settled decisions separately from proposed designs. Scope: `apps/raindrop-mcp-worker`. The v3 baseline remains governed by [Spec #110](https://github.com/lirtual/mcp-workers/issues/110) and [ADR-0001](./adr/0001-replace-legacy-tool-contract.md). A decision to investigate a design does not approve implementation, deployment, or release.

## 2026-09-21 — v4 Worker-native / Grill-with-docs round 1

Context: final Free native CPU acceptance for v3 Draft PR #120 is not proven in #119. The owner confirms the Cloudflare account uses Workers Free. Preserve earlier test evidence, without treating an older deployment's CPU values as a pass for the final SHA.

| Question | Choice | Settled decision |
| --- | --- | --- |
| Q1 | B | Permit moderate grouping of the public MCP tool surface by resource/action; dangerous operations retain explicit, independent and safe invocation boundaries. Do not commit to a numerical tool count yet. |
| Q2 | B | Prefer the existing SDK initially; compare against a lightweight protocol adapter in a bounded proof of concept before deciding whether replacement is justified. |
| Q3 | A | Only immutable, credential-free metadata may be shared across requests. Preserve request-local mutable server/transport, handlers, credentials, upstream client, budgets and caches. |
| Q4 | A | Preserve the existing Raindrop business capabilities and necessary MCP resources/prompts; only the protocol/adaptation layer is the initial redesign target. |
| Q5 | B | Prioritize Workers Free. If repeatable CPU overages persist, allow another public-contract design decision while preserving safety; do not publish an unaccepted build. No Paid upgrade approved. |
| Q6 | B | Freeze v3 Draft PR #120; conduct independent v4 design and acceptance. #119 remains open/unpassed, no v3 production switch or merge. |

### Existing ADR alignment and tensions

- **ADR-0001** remains the binding description of v3's explicit read, write, delete and batch tool separation. Q1 allows reconsidering non-dangerous grouping for v4, *not* relaxing destructive confirmation, source scope, fail-closed checks, or unknown-write handling. Grouping across a read/write or delete boundary requires a further documented decision; it is not pre-approved.
- **v3 Spec #110** explicitly keeps the SDK/framework during v3. Q2 only approves investigating a different v4 adapter. The decision to replace the SDK and its compatibility consequences remain open.
- **Q3 / Q4** retain existing request isolation, two-credential deployment shape and domain semantics; they do not add D1/R2/KV or a new authentication system.
- **Q5 / Q6** do not satisfy or close the v3 live acceptance / Free CPU gate, and do not turn a potential v4 prototype into evidence for the v3 HEAD.

See [ADR-0002](./adr/0002-worker-native-free-first.md) and [CONTEXT.md](../CONTEXT.md).

### Not decided / next frontier

1. Whether to keep dangerous writes, permanent deletes and bulk actions as independently named tools or separate typed action groups; precise safe-read merging bounds.
2. Mandatory MCP capabilities and conformance requirements for any new adapter (initialize, tools, resources, prompts, errors and transport).
3. Breaking-change strategy for ChatGPT MCP Portal/client; whether a side-by-side v4 endpoint or versioned tool names are needed.
4. Exact CPU acceptance sample method/statistics, error policy, free resource constraints and fallback behavior.
5. How to pin and trigger isolated deployments and verify exact source/deployment identity, without changing production or touching account data.
6. Conditions for making a separate decision on the frozen v3 PR after v4 evidence exists.

**Status**: first-round decisions recorded; architecture design only. No implementation, PR #120 merge, production cutover, account-data mutation, or claim that #119 is accepted.
