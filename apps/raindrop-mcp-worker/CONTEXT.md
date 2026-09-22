# Raindrop MCP Worker

This bounded context exposes a private, lightweight Raindrop.io MCP Worker. It prioritizes correct official API semantics and bounded Cloudflare Worker execution over exhaustive API coverage.

## Language

**Raindrop**:
A bookmark or saved item in Raindrop.io. Public tool and response fields follow the upstream name and field semantics.
_Avoid_: Generic item when the distinction matters

**Official API semantics**:
The upstream operation meanings, parameters, paths, and results that the Worker maps into MCP tools. Source code or a local OpenAPI file is not proof that an upstream behavior is valid.

**MCP tool contract**:
The client-visible tool name, input, output, side effects, and error behavior. Under the approved v3 contract, tools are organized by resource and explicit action; read, write, delete, and batch operations remain distinct. The proposed v4 design may regroup non-dangerous operations but must preserve independently discoverable dangerous-operation safety boundaries (see ADR-0002).

**Capability acceptance state**:
The independently recorded states of implementation complete, contract tests passed, and live invocation accepted. Local tests never substitute for live acceptance.

**Preview**:
A read-only description of the current destructive target and expected impact. It is not a lock, transaction, approval system, or guarantee that upstream state will remain unchanged.

**Unknown write result**:
A write that reached the upstream request boundary but did not return enough evidence to determine whether it took effect. Such writes are never automatically replayed.

## Settled boundaries

1. The current goal is to make existing capabilities reliable and add missing capabilities only when needed; exhaustive coverage of every public Raindrop API is not a release criterion.
2. The Worker remains stateless and uses the existing MCP Portal plus separate `MCP_ACCESS_TOKEN` and `RAINDROP_ACCESS_TOKEN` credentials. It does not add D1, R2, KV, Queues, Workflows, or a new credential system.
3. Existing tool names and invocation shapes are not compatibility constraints. The public contract may be replaced with resource/action tools grounded in official semantics and Worker limits.
4. List operations are paginated and bounded. Batch writes require one explicit source collection and a non-empty explicit ID list; they never imply an entire collection or cross-collection server-side scan.
5. Writes are not automatically retried or rolled back. Multi-request operations distinguish succeeded, failed, unknown, and not-executed scopes using available upstream evidence.
6. Cleanup is preview-first and target-explicit. Official duplicate detection is reused; custom fuzzy or URL-normalization deduplication is out of scope. Duplicate copies with notes or highlights are skipped by automated cleanup.
7. The Worker retains official Raindrop suggestions but does not orchestrate MCP Sampling or provide a pure AI tag tool. The conversation model owns inference; the Worker owns upstream query and mutation.
8. Live writes are accepted only against dedicated test collections and disposable test data. Account, sharing, import/export, backup, upload, and permanent-copy APIs remain out of scope until separately requested.

The approved specification is published as a GitHub specification issue rather than committed as a repository spec file. The application ADR records the breaking public-contract decision; implementation tickets own concrete tool schemas, limits, tests, and rollout work.

## v4 Worker-native direction (decisions accepted 2026-09-21; design only)

**Worker-native MCP**: A stateless MCP adapter and domain layer designed for the Cloudflare Workers Free per-request CPU budget, not an API endpoint-for-tool mapping or an assumed long-lived server. Free suitability must be validated on an exact isolated deployment; it is not guaranteed by the architecture name.

**Immutable shared metadata**: Module-scoped, secret-free, immutable schemas and tool definitions that are safe to reuse across requests. A mutable `McpServer`, transport, upstream client, request handler, credential, budget, or request cache is not shared across requests.

**v3 baseline / v4 candidate**: v3 Spec #110 and Draft PR #120 remain frozen pending independent #119 resource and live acceptance. v4 is an independent, proposed design; its prototype, acceptance, and rollout cannot be reported as v3 completion.

**V4 first-round decisions** (Q1:B, Q2:B, Q3:A, Q4:A, Q5:B, Q6:B; see [decision log](./docs/decision-log.md) and [ADR-0002](./docs/adr/0002-worker-native-free-first.md)):

1. Permit moderate regrouping of client-facing MCP tools by resource/action while keeping dangerous operations independently identifiable and retaining their explicit scope, preview, confirmation and fail-closed protections. Do not assume a fixed target tool count.
2. Prefer the existing SDK initially; compare an SDK path and a smaller protocol-adapter proof of concept before any SDK replacement. Do not pre-approve a hand-rolled full MCP implementation.
3. Share only immutable, secret-free metadata. Keep credentials, mutable server and transport, upstream client, budgets, caches and request handlers isolated by request.
4. Preserve existing Raindrop business capabilities and necessary MCP resources/prompts; a lighter protocol adapter must not silently remove them.
5. Treat Workers Free as the preferred target, not a claim of proven compliance. If repeatable CPU breaches persist after constrained improvements, reconsider the external contract while preserving safety; do not release until agreed Free resource gates pass. No Paid upgrade is approved by this decision.
6. Preserve and freeze the v3 PR #120 scope. Design and verify v4 independently, without merging #120, switching production, or treating #119 as passed.

**V4 second-round decisions** (Q7:B, Q8:B, Q9:B, Q10:B, Q11:B, Q12:B; see [decision log](./docs/decision-log.md) and [ADR-0002](./docs/adr/0002-worker-native-free-first.md)):

7. Only purely read-only tools may be regrouped. Write, delete and batch operations remain independently exposed, with existing explicit safety boundaries; no generic combined read/write or hidden destructive action.
8. Compare the SDK baseline against a bounded lightweight-adapter prototype for `initialize`, `tools/list`, local diagnostics, representative read-only `tools/call`, and necessary resources/prompts. Evaluate protocol behavior alongside CPU; full production implementation is not approved.
9. Any proposed adapter must cover the v3 protocol capabilities actually used and verify transport, authorization, supported initialization and method behavior, error semantics, cancellation and relevant client compatibility; it is not required to implement every optional MCP feature. Precise version/capability test cases remain to be specified.
10. Expose v4 through an independent candidate endpoint or equivalent isolated entry before any client migration. Choose eventual Portal/client migration and production cutover only after separate acceptance; do not assume perpetual v3 aliases.
11. Assess the exact isolated Free deployment using repeated per-operation native CPU samples, distinguishing initial from subsequent requests and recording every over-limit sample, error and missing observation. The acceptance direction is **no persistent over-limit behavior**, not HTTP-success-only and not an approval to ignore occasional breaches. Sampling size, definition of persistence, pass/fail thresholds and handling of outliers remain open.
12. Design a dedicated v4 read-only, immutable-SHA-pinned measurement workflow, separate from the v3 workflow, with verifiable deployed-version identity. Its invocation, artifact, isolation, auth and rollback details remain to be decided; no workflow has yet been implemented.

**V4 third-round decisions** (Q13:B, Q14:A, Q15:B, Q16:B, Q17:B, Q18:B; see [decision log](./docs/decision-log.md) and [ADR-0002](./docs/adr/0002-worker-native-free-first.md)):

13. Candidate pure-read groups follow Raindrop domain resources (e.g., bookmark search/detail, collections, diagnostics) with explicit typed actions and preservation of data, pagination and error semantics. No group names, exact count or schemas are approved yet; write, delete and batch tools remain separate.
14. Retain the existing SDK by default. Replace it only if an alternative proves reproducible **native** CPU benefit, satisfies the required MCP/client protocol behavior, and has acceptable maintenance/security cost. If the evidence is inconclusive, keep the SDK; no replacement is yet selected.
15. Require protocol contract tests **and** real ChatGPT MCP Portal read-only discovery/call evidence, including error and cancellation behavior; mock or local-only evidence is insufficient for final adapter selection. Portal tests do not authorize production client migration.
16. Predeclare repeated per-operation CPU sample size, initial-versus-subsequent split, persistence and outlier policy, missing-telemetry/error handling and an explicit pass/fail rule *before* collecting release evidence. Review sporadic overages individually; never auto-pass or silently drop them. These numeric/statistical thresholds are **not settled in Q16**, and neither a 10 ms sample target nor a percentile alone guarantees Free enforcement.
17. Use a **dedicated v4 isolated Worker**, a separate read-only measurement workflow, immutable source SHA and verified deployed script/version, preserving production/v3 endpoints and credentials. Workflow permissions, sampling artifacts, immutable version proof and rollback remain to be specified.
18. Preserve the v3 code, test and review evidence; decide separately what to do with PR #120 after v4 acceptance. Do not automatically close, merge, replace or release v3 because of v4 progress.

**V4 final-consensus decisions** (Q19:A, Q20:A, Q21:A, Q22:B, Q23:A, Q24:B; see [decision log](./docs/decision-log.md) and [ADR-0002](./docs/adr/0002-worker-native-free-first.md)):

19. Organize *only* pure-read MCP capabilities by resource: bookmarks, collections, tags, highlights, diagnostics and audit, with explicitly typed `action` parameters. These are agreed grouping categories, **not** a final exact tool count, executable schema or authorization to group any mutation. Preserve all v3 domain results and protections; write/delete/batch tools remain independently exposed.
20. Existing SDK stays by default. An alternative requires successful v3-used MCP/client conformance, reproducible **at least 20% lower native CPU on key operations** under comparable isolated conditions, and acceptable implementation, maintenance and security cost. Inconclusive or insufficient evidence retains the SDK; neither design is currently proven Free compliant.
21. Pin the protocol version and capabilities **actually negotiated by v3** (derive/confirm from evidence in to-spec, not an assumed target) and test Streamable HTTP, authentication, initialization, tools, necessary resources/prompts, errors and cancellation, including actual ChatGPT MCP Portal read-only discovery/calls. Do not implement unused optional capabilities solely for theoretical completeness.
22. Define the project's Free CPU gate as follows: record first-observed requests separately; for each required operation collect **30 subsequent native CPU observations across three windows** (10 per window if equally distributed), preserving exact SHA/deployment version, UTC time, operation, raw samples and errors. **Two consecutive readings above 10 ms, or more than one above 10 ms in the subsequent 30, fail. Exactly one over-limit reading requires explicit review and cannot automatically pass. Errors or missing telemetry block the gate.** The first observation also requires recorded review if above the limit and must not be silently excluded or misidentified as a cold start. The sample rule is a conservative **project acceptance policy**, not Cloudflare's enforcement guarantee and not a declaration that v4 already passes.
23. Use a dedicated isolated v4 Worker and manually triggered **read-only** measurement workflow, pinned to an immutable commit SHA and independently verified script/deployed version; least-privilege credentials, raw CPU artifacts and fail-closed behavior. Existing v3 and production endpoints/credentials are untouched. The exact workflow name, authentication mechanism, version attestation, artifact retention and rollback steps are to-spec operational details; no workflow has been created by this decision.
24. Preserve v3 PR #120, reviews and tests as separate evidence; after full v4 acceptance, make a separate approval decision for Portal/client migration, production switch, and PR #120 disposition. v4 read-only prototype alone is insufficient for full-feature release or closing #119.

**Final consistency / readiness**: Q1–Q24 are mutually compatible as a *design and test policy*. ADR-0001 stays binding for v3; ADR-0002 governs v4's read-only grouping and experimental comparison without weakening mutation safety. This architecture is **ready to enter to-spec**, where exact tool/action schemas, complete v3 operation mapping, protocol fixtures, comparable CPU methodology (including 20% calculation and first-sample handling), later write/memory/subrequest acceptance, isolation credentials, artifacts and rollback must be made buildable and independently reviewed. To-spec approval is **not** implementation approval, acceptance, PR merge or production cutover.
