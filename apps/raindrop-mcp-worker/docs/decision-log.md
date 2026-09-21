# Raindrop MCP architecture decision log

This file records user-settled decisions separately from proposed designs. Scope: `apps/raindrop-mcp-worker`. The v3 baseline remains governed by [Spec #110](https://github.com/lirtual/mcp-workers/issues/110) and [ADR-0001](./adr/0001-replace-legacy-tool-contract.md). A decision to investigate a design does not approve implementation, deployment, or release.

## 2026-09-21 — v4 Worker-native / Grill-with-docs final consensus (Q19–Q24)

All 24 Q1–Q24 decisions are settled as **architecture and acceptance-policy direction**, not as implementation, Free compliance, or production authorization.

| Question | Choice | Settled decision |
| --- | --- | --- |
| Q19 | A | Group **only pure-read** capabilities by Raindrop resource: bookmarks, collections, tags, highlights, diagnostics and audit, using typed `action` parameters. Write, delete and batch tools remain independently exposed. Final tool names/count, types, and v3→v4 mapping belong to to-spec. |
| Q20 | A | Existing SDK remains default. A replacement must pass required protocol/client compatibility, show reproducible **at least 20% lower native CPU** on key operations under comparable conditions, and have acceptable maintenance/security cost. Otherwise retain the SDK; no replacement is chosen here. |
| Q21 | A | Pin protocol version and capability set actually negotiated by v3; validate Streamable HTTP, auth, initialize, tools, necessary resources/prompts, errors and cancellation via contract tests **and actual ChatGPT MCP Portal read-only discovery/invocation**. Neither assumed target versions nor unused optional capabilities count as the baseline. |
| Q22 | B | Separate first-observed CPU samples; collect **30 subsequent labeled native observations per required operation across three windows**. Two consecutive observations >10 ms **or more than one** over 10 ms among the 30 = Fail. Exactly one over-limit observation needs explicit review and **cannot auto-pass**. Errors or missing telemetry block acceptance. First observations are retained, not automatically excused as cold starts; any over-limit first observation requires review. This is a project gate, not Cloudflare's enforcement promise. |
| Q23 | A | Dedicated v4 isolated Worker; manually triggered, read-only, commit-SHA-pinned workflow; verifiable deployed script/version identity, least-privilege credentials, raw native CPU artifacts, fail-closed handling; no production/v3 access or changes. Specific implementation details remain to-spec. |
| Q24 | B | Preserve v3 PR #120 and independent evidence. After **full** v4 acceptance, separately approve Portal/client migration and production cutover and only then decide v3 PR's disposition. No automatic #119 closure, merge or replacement. |

### Q1–Q24 cross-round consistency audit

| Earlier decisions | Final clarification and consistency |
| --- | --- |
| Q1:B, Q7:B, Q13:B → Q19:A | Moderate regrouping is limited to pure-read resource/action tools. Explicit write/delete/batch separation, scoped preview/confirmation and accurate unknown-write reporting remain. No generic read/write dispatcher. |
| Q2:B, Q8:B, Q9:B, Q14:A, Q15:B → Q20:A, Q21:A | SDK-first bounded comparison remains. Protocol tests and real client evidence are mandatory. The 20% native CPU criterion refines, rather than replaces, parity and maintenance/security conditions. If evidence is inconclusive, keep SDK. |
| Q3:A, Q4:A | Share immutable secret-free definitions only, isolate mutable server/transport, credential, handlers, budget, Raindrop client and caches per request. Preserve business capabilities and necessary resources/prompts. |
| Q5:B, Q11:B, Q16:B → Q22:B | Free-first, repeatable and exact-deployment measurements. The fixed 30-sample/three-window rule implements the predeclared project test. One >10 ms reading is **Review/Blocked, not Pass**; recurring breaches are Fail. No outcome is inferred from HTTP 200 or old samples. |
| Q6:B, Q10:B, Q12:B, Q17:B, Q18:B → Q23:A, Q24:B | Keep v3 frozen; separate v4 endpoint/workflow and independent cutover decision. A v4 read-only prototype is not full production-shaped acceptance. |

**ADR audit:** ADR-0001 remains accepted for v3 and retains its independent action and mutation safety intent. ADR-0002 adds v4 Free-first, limited pure-read grouping, SDK comparison and isolated evidence. No decision supersedes v3 Spec #110's *v3-specific* SDK constraint. Only v4 comparison is authorized at the design level.

### CPU acceptance and interpretation

- **Evidence identity:** require immutable source SHA, verified deployed Worker version and script name, Free entitlement, UTC event timestamp, operation label, raw native `cpuTimeMs`, HTTP/protocol status, errors and missing data; no inferred zeroes.
- **Sample stratification:** first-observed request recorded separately for each required operation; 30 **subsequent** requests per operation across three independent windows (10 each if evenly distributed). Maintain request ordering *within* each window for consecutive-overage detection; do not infer that a first-observed sample equals an independently proven cold start.
- **Fail / Blocked:** two consecutive later samples >10 ms or at least two later samples >10 ms in total are CPU **Fail**. Failed/invalid requests or missing native telemetry **block** acceptance; record the actual operation error or evidence gap separately and never treat missing data as zero.
- **Review, not automatic Pass:** exactly one over-limit later sample, or an over-limit first-observed sample; preserve raw data and written disposition before any release decision. Individual review does **not** override Cloudflare's actual platform limits.
- **No automatically proven Pass:** if all 30 later samples are <=10 ms, the first-observed sample is accounted for, telemetry is complete and all other relevant gates pass, this satisfies only the defined **CPU sample rule**. Full v4 release additionally requires protocol/Portal, write/side-effect safety, memory, subrequest and deployment tests. The small sample is not a statistical warranty or proof against later overages.
- **SDK comparative gate:** same operation fixtures and input/load/limits on exact deployed variants; demonstrate >=20% lower native CPU on predefined key operations, record baseline and comparison method in to-spec (e.g., a deterministic aggregate per operation), independently meet Free rule, and retain SDK if inconclusive. Percentage criterion alone does not grant release.

### To-spec dependencies (operational details, not new architectural decisions)

1. Produce complete v3-to-v4 mapping and exact typed read-only action schema, preserved data envelopes and authorization/validation; define key comparison operations.
2. Extract negotiated v3 protocol version/capabilities from actual trace and pin contract/client fixtures, errors, aborted streams and cancellation behavior. Confirm Portal read-only tests are available in the intended environment.
3. Define comparable measurement setup and 20% metric without cherry-picking; first-observation review disposition, data sufficiency and verification of 3 windows; separately specify required representative write/memory/subrequest gates.
4. Fix v4 Worker/workflow identifiers, permissible manual trigger refs, commit/version attestation, minimal credential provisioning, UTC raw artifact format/retention, no production access and rollback/failure cleanup. Ensure existing v3 mutation suites are not invoked.
5. Maintain v3 PR #120 and #119 independently. A separately reviewed release decision is required after v4 full acceptance.

**Readiness:** Q1–Q24 can enter **to-spec** with these implementation-level details as spec acceptance criteria; **not** ready for implementation, to-tickets, merger, Free-compliance signoff or production cutover. v3 #119 remains unpassed; PR #120 and #126 remain Draft/unmerged.

---

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
