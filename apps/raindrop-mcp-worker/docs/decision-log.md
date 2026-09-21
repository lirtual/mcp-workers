# Raindrop MCP architecture decision log

This file records user-settled decisions separately from proposed designs. Scope: `apps/raindrop-mcp-worker`. The v3 baseline remains governed by [Spec #110](https://github.com/lirtual/mcp-workers/issues/110) and [ADR-0001](./adr/0001-replace-legacy-tool-contract.md). A decision to investigate a design does not approve implementation, deployment, or release.

## 2026-09-21 — v4 Worker-native / Grill-with-docs round 3

Q13–Q18 are **settled architecture decisions**, but no implementation, precise performance cutoff or release decision is approved.

| Question | Choice | Settled decision |
| --- | --- | --- |
| Q13 | B | Group **purely read-only** tools by Raindrop resource, e.g., bookmark search/detail, collections and diagnostics, with explicit action parameters and preserved domain semantics. Names, exact groups and schemas remain open; writes/deletes/batches stay separate. |
| Q14 | A | Retain the current MCP SDK by default. Select a lighter adapter only on reproducible native CPU benefit plus functional/client parity and acceptable maintenance/security costs. Inconclusive comparison means retain SDK. |
| Q15 | B | Require protocol contract tests and actual ChatGPT MCP Portal read-only discovery/call, covering authentication, transport, errors and cancellation. Local mocks alone cannot certify client compatibility. |
| Q16 | B | **Predeclare** CPU sample sizes, initial/subsequent split, persistence criterion, outlier handling, failure/missing data policy and pass/fail rule before validation. Individual sporadic overages require review, not automatic acceptance. Exact numbers and rule are not yet decided. |
| Q17 | B | Use dedicated v4 isolated Worker, separate read-only workflow, immutable source SHA and verified deployed version; protect v3/production endpoint and credentials. Workflow execution details remain open. |
| Q18 | B | Keep v3 test/review evidence. Decide separately whether to close, retain, merge or supersede PR #120 after independent v4 acceptance; no implicit cutover. |

### Consistency with ADR-0001 and ADR-0002

- **ADR-0001** remains accepted for the v3 baseline. Q13's *read-only* grouping is compatible with Q7's explicit write/delete/batch segregation; it does not authorize a generic read/write dispatcher or a reduction of destructive safeguards.
- **ADR-0002** now explicitly records Q13–Q18. Q14 confirms the existing SDK is the default in any inconclusive comparison; Q15 makes real Portal compatibility a requirement for adapter selection. This is a v4 investigation, not a change to the v3 no-SDK-replacement requirement.
- **Q16** is a *decision to predeclare a test policy*, not that the policy has already been chosen. Free entitlement is owner-confirmed, but native CPU and other Free resource compliance are unproven. A locally timed profile, earlier v3 CPU data, HTTP 200, or v4 read-only proof does not pass the v3 #119 live acceptance.
- **Q17/Q18** retain independent release and deployment lifecycles. No permission for production, credentials or account data changes; PRs #120/#126 stay Draft and unmerged.

### CPU acceptance policy: decisions versus open numbers

**Decided:** evaluate the exact SHA **and deployed Worker version** under the confirmed Free plan; compare operations individually, distinguish first-observed and subsequent requests (do not label a first-observed 38 ms as a cold start without supporting evidence), preserve raw UTC observations with op label, errors and missing telemetry, and reject persistent over-limit behavior. Any exception requires written review before a release decision.

**Unsettled:** number of repeats and measurement windows; meaning of persistent (e.g., frequency and clustering of overages); whether/which percentile is used; treatment of first observations and individual spikes; criteria for an error, missing telemetry or a failed probe; and whether a separate regression bound against the v3 baseline is required. Do not turn a candidate value into a decision or conflate Cloudflare enforcement with our own evidence standard. Verify representative *writes* and request/memory/subrequest limits in later production-shaped acceptance; read-only prototype alone does not cover these.

### Smallest comparative prototype: open dependencies

1. Map every v3 read operation to candidate groups; choose exact names, typed action schemas, output equivalence and protected fields.
2. Define identical SDK/adapter fixtures (initialize and protocol negotiation, tools/list, diagnostics, representative tools/call, resources/list and read, prompts/list and get, malformed method/authorization, abort) and pass/fail for the actual Portal.
3. Pin SDK and candidate source/deployed version; compare same inputs, request sizes, isolation and native CPU statistics, plus implementation/maintenance/security cost.
4. Specify v4 isolated worker name, safe credentials, read-only workflow trigger, immutable SHA verification, artifacts, rollback and failure cleanup. Do not trigger existing v3 mutation suites.
5. Finalize numeric CPU/resource gate and exact post-prototype expansion criteria. Inconclusive results retain SDK and keep the release blocked; no automatic Paid migration.
6. Retain v3 PR status until a separate decision after v4 evidence.

**Gate:** ready for a *final, focused consensus round* on the above remaining policy choices, **not** yet ready for to-spec/implementation because quantitative and operational acceptance are undefined.

---

## 2026-09-21 — v4 Worker-native / Grill-with-docs round 2

These user-settled choices depend on first-round Q1–Q6; they refine the candidate architecture, not the existing v3 release requirements.

| Question | Choice | Settled decision |
| --- | --- | --- |
| Q7 | B | Only purely read-only tools may be regrouped. Explicit write, delete and batch tools remain independent with their existing confirmation, source-scope and fail-closed protections. |
| Q8 | B | Compare SDK and lightweight-adapter prototype for initialize, tools/list, local diagnostics, representative read-only call, resources and prompts. Compare behavior **and** CPU; full port is not approved. |
| Q9 | B | An alternative adapter must cover v3-used protocol capabilities and test authentication, transport, error semantics, cancellation, and actual client compatibility. Not every optional protocol feature is required. |
| Q10 | B | Verify a distinct v4 candidate endpoint first. Make a separate decision on Portal/client migration and production cutover after acceptance; do not yet promise legacy aliases. |
| Q11 | B | Profile the exact isolated Free deployment with repeated labeled native CPU samples per operation, segregating first and subsequent requests and recording all overages and errors. A no-persistent-overage direction is set, **not** an unlimited allowance for occasional overage, an HTTP 200 shortcut, or an already-agreed statistical release gate. |
| Q12 | B | Design an independent immutable-SHA-pinned, read-only v4 measurement workflow, not a modification to the frozen v3 workflow. Verify deployed script/version identity; triggering, permissions and rollback remain to be specified. |

### Reconciliation with existing records

- **ADR-0001** still governs v3, explicitly separating reads/writes/deletes/batches. Q7 resolves the v4 grouping uncertainty in favor of *read-only-only* regrouping; it does not supersede the safety intent of ADR-0001 or approve merging any write/delete/batch with reads or each other.
- **ADR-0002** covers the Free-first design and SDK comparison. Q8 and Q9 refine comparison scope and minimum v3-used protocol behavior, without choosing an alternate adapter or authorizing full protocol implementation.
- **Q10 / Q12** refine ADR-0002's v3/v4 separation: independent candidate entry and read-only, version-pinned workflow; they are design decisions only, not permission to deploy or mutate credentials.
- **Q11** sets an evidence strategy, not an agreed numeric sampling, percentile, outlier or failure threshold. Old native CPU samples and local profiles cannot certify a final v4 release. #119 remains unpassed.

### Dependencies for round 3

1. Define candidate read-only tool groups, discoverability and input/output shape while preserving exact v3 domain semantics.
2. Set the SDK-vs-adapter comparison rubric: native CPU evidence, functional parity, maintenance/complexity and the decision when inconclusive.
3. Pin protocol versions, transport requirements and client compatibility fixtures, including error/cancellation behavior.
4. Specify sample count, repeated-overage definition, failures/missing telemetry policy and release gate.
5. Define isolated script identity, triggering, minimal credential policy, immutable-SHA validation and safe rollback.
6. Decide which v3 PR disposition, if any, depends on successful v4 validation. No implicit merge or cutover.

**Status:** round-two decisions recorded, no v4 implementation; PR #120 remains Draft and unmerged; #119 remains unpassed; PR #126 documentation only, Draft and unmerged.

---

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
