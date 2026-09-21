# Prefer a Worker-native, Free-first Raindrop MCP v4 architecture

Status: accepted architecture direction; implementation and concrete tool/SDK selection undecided. Date: 2026-09-21.

## Context

The approved v3 specification (#110) and Draft PR #120 implement a 26-tool stateless MCP Worker, but final isolated Free-plan native CPU acceptance (#119) is not established. An earlier version produced 17 labeled native CPU observations, 8 over the published 10 ms per-request Free HTTP CPU limit; these are a diagnostic baseline, not evidence for v3 HEAD or v4. The v3 server creates request-scoped service/server objects and registers tools, resources and prompts. Existing tool configuration and prepared schemas are already initialized at module scope; their existence alone does not identify the measured CPU hotspot.

ADR-0001 adopted v3's explicit resource/action contract, separately exposing read, write, delete and batch operations, in preference to the legacy 17-tool interface. An API-per-tool design is not automatically efficient on Workers Free, but reducing tool count or rewriting protocol support has not yet been shown to reduce native CPU.

## Decision — first Grill-with-docs round (Q1:B, Q2:B, Q3:A, Q4:A, Q5:B, Q6:B)

1. **Client-facing surface**: v4 may moderately regroup tools by resource/action, while preserving independently identifiable dangerous operations and explicit preview, scope, confirmation, error/unknown-result and fail-closed constraints. Exact names, count, compatibility and potential breaking migration are *not yet decided*.
2. **MCP runtime**: start with the existing SDK and compare it against a smaller adapter in a targeted proof of concept. An alternative adapter must meet the necessary MCP protocol and client behavior before it could be selected; this ADR does not authorize a rewrite or full custom protocol implementation.
3. **Isolation**: share only demonstrably immutable, secret-free metadata between requests. Keep mutable server, transport, per-request handlers, credentials, Raindrop client, budgets and caches request-scoped. This invariant is not waived for CPU.
4. **Capabilities**: preserve existing Raindrop business capabilities and necessary MCP resources/prompts, subject to separate decisions on representation and compatibility. No silent scope removal.
5. **Resource and release gate**: Free is the prioritized target, not a proven property. If repeatable native CPU breaches remain after constrained changes, consider revising the external contract without weakening safety. Do not report acceptance or release until agreed Free resource and client acceptance gates pass. No Paid upgrade is authorized.
6. **Separation of work**: freeze v3 Draft PR #120 and retain #119 as unpassed until its evidence is actually obtained. Conduct v4 design/prototype/acceptance independently; no merge, production cutover, credential mutation, or account-data change.

## Refinement — second Grill-with-docs round (Q7:B, Q8:B, Q9:B, Q10:B, Q11:B, Q12:B)

These decisions narrow the accepted first-round direction; they do not authorize runtime changes.

- **Read-only grouping (Q7)**: v4 may regroup **purely read-only** tools. Writes, deletes and batch operations remain independently exposed, with explicit confirmation, source scope, fail-closed safeguards and accurate unknown-write reporting. Do not combine reads with writes or hide dangerous actions in generic dispatch.
- **Comparative prototype (Q8)**: compare existing SDK and proposed lightweight adapter using initialize, tools/list, local diagnostics, representative read-only tools/call, necessary resource and prompt requests. Record protocol behavior as well as measured CPU. No full replacement is approved.
- **Minimum conformance (Q9)**: the candidate must support the v3-used MCP capabilities, with tests for authentication, transport, negotiated protocol behavior, error semantics, cancellation and target client compatibility; implementing unused optional features is not a requirement. Precise fixtures and protocol version pins are deferred.
- **Parallel entry (Q10)**: prove an independently isolated v4 endpoint before deciding whether and how Portal/client migration or production cutover occurs. No current v3 endpoint or token changes.
- **Resource evidence (Q11)**: use exact-deployment, operation-labeled native CPU samples on Free, with repeated observations for first and subsequent requests, all overages and failures recorded. Seek no persistent over-limit behavior; the sample size, persistence definition and numeric release criteria remain unresolved. Neither old deployment samples nor local profiling nor HTTP 200 alone satisfies acceptance.
- **Isolated measurement workflow (Q12)**: plan a distinct read-only v4 workflow pinned to an immutable source SHA and verified deployed script/version. No use of the frozen v3 workflow for v4; trigger scope, credential boundaries, artifact retention and rollback need further decisions.

## Relationship to ADR-0001 and v3 Spec #110

ADR-0001 remains accepted for the v3 baseline. Its separation of read, write, delete and batch tools is **not automatically replaced** by a v4 grouping proposal. A v4 grouping that combines read and write or hides destructive scope behind a generic action would conflict with the established safety intent and requires an explicit further decision and separate contract tests. Round-two Q7 further limits regrouping to purely read-only tools: it retains independently exposed write, delete and batch tools, so their v3 safety intent remains intact. No combined read/write action is authorized.

The v3 spec explicitly says not to replace the SDK or HTTP framework in that release. A *comparative v4 prototype* does not amend that v3 constraint. If a future v4 SDK replacement is approved, document the protocol and migration consequences in a new ADR/spec before implementation.

## Consequences

- Positive: focuses engineering on the actual Free runtime budget and permits evidence-based protocol/tool redesign while protecting existing Raindrop semantics.
- Cost: may require a distinct breaking client migration and extra protocol conformance tests; two design tracks must remain clearly separated.
- Risk: neither fewer tools nor a smaller adapter guarantees lower CPU. Only exact-version native Cloudflare CPU data can establish compliance; local profiling is diagnostic.

## Explicitly unresolved

Next Grill-with-docs round: precise read-only grouping and schema; quantitative SDK comparison and inconclusive-result handling; concrete MCP conformance cases; Portal migration and rollback policy; number of samples, statistical acceptance and errors/missing-telemetry handling; isolated workflow trigger, credentials, version identity and artifacts; and v3 PR disposition.

References: [v3 Spec #110](https://github.com/lirtual/mcp-workers/issues/110), [#119](https://github.com/lirtual/mcp-workers/issues/119), [Draft PR #120](https://github.com/lirtual/mcp-workers/pull/120), [ADR-0001](./0001-replace-legacy-tool-contract.md), [decision log](../decision-log.md).
