# ADR 0029: Independently deliver trusted workflow definitions

- Status: Accepted for v0.2 architecture (owner-approved Q1–Q16); implementation-level contracts in to-spec
- Date: 2026-09-22
- Supersedes: ADR 0024 for **v0.2 definition delivery and lookup only**; ADR 0024 remains the historical v0.1 contract.
- Preserves: ADR 0003 (Git-owned authoring), ADR 0006 (canonical-content identity), ADR 0015 (single scheduler), ADR 0017 (restricted IR), ADR 0018 (fixed asynchronous MCP tools), ADR 0019 (registered capabilities), ADR 0022 (separate trust surfaces), ADR 0028 (MCP entry token is not admin authority).

## Context

v0.1 stores Git-authored workflow YAML in `apps/workflow-mcp-worker/workflows/`, compiles it into `src/generated/workflow-registry.ts`, and bundles that registry into each Worker deployment. The runtime already persists immutable pinned plans in D1. Thus workflow *authorship* is declarative, but workflow *delivery* and some business-specific connection and acceptance code remain tied to engine deployment. This is not the desired boundary for a general-purpose engine.

## Decision (owner-approved Q1–Q8, Round 1)

1. **Q1 — Independent source:** Business workflow definitions and business acceptance assets live in independent Git repository/repositories. The engine repository retains generic runtime, compiler, capability implementations, and platform-level test fixtures.
2. **Q2 — Controlled publication:** An authorized GitHub Actions publication path compiles and validates a trusted source revision, registers the immutable result through a protected administration surface, and activates it only after approval. Runtime execution never fetches arbitrary Git URLs, and v0.2 does not expose public runtime authoring.
3. **Q3 — Storage and authority:** Git remains the source of truth for authored definition content. D1 stores the active registry, immutable normalized plan versions, and state. R2 is used only when large packages or artifacts justify it; a runtime record is not an independent editable authoring source.
4. **Q4 — Connections:** Approved non-secret connection metadata may be registered without an engine redeploy. Long-lived credentials remain in existing Worker Secrets; unprovisioned secret references fail closed. There is no general-purpose encrypted credential vault in this increment.
5. **Q5 — Least privilege:** A definition may only reference registered and administratively approved capabilities, connections and concrete operations. It may not supply arbitrary endpoints, credentials, secret names, executors, or code. Conservative operation effects, retry policy, and explicit write controls remain in force.
6. **Q6 — Version and scheduling:** Activation changes only new Run admission. Existing Runs continue from their immutable pinned plans; deactivation prevents new admissions but does not implicitly cancel existing Runs. A schedule version transition must not duplicate an already admitted logical occurrence.
7. **Q7 — Failure and rollback:** Validate before activation, retain the previous active version on publication failure, and restore a previously validated digest on rollback. Keep historical plan and audit records; never rewrite running plans.
8. **Q8 — Delivery scope:** v0.2 focuses on trusted, Git-authored definition delivery with the existing seven MCP tools. It excludes arbitrary script execution, online editing, multi-user RBAC, dynamic capability/plugin marketplaces, and a general n8n replacement.

The current v0.1 runtime and previously accepted Raindrop/manual/schedule and heavy-executor evidence remain historical facts, not retroactive v0.2 acceptance.

## Additional decision (owner-approved Q9–Q16, Round 2)

9. **Q9 — Catalog layout:** Begin with one independently versioned Git workflow-definitions catalog repository, organized into business packages. Separate repositories are optional future isolation, not a v0.2 prerequisite.
10. **Q10 — Trust and approval:** The publisher binds its immutable package to the exact Git revision, canonical definition digest, and verified CI evidence. The protected administration surface independently validates content and authority; activation requires separate approval. A green CI claim, bearer token, or user-supplied SHA alone is insufficient.
11. **Q11 — Connection and policy version:** Each admitted Run pins the approved non-secret Connection Configuration Version and resolved Effective Operation Policy. Before any new external operation, a live disable/revocation guard still applies; policy pinning cannot override revocation. Secret values do not enter plans; credential rotation uses currently controlled Workers Secrets. Privilege may not be widened by a config update or by an old snapshot.
12. **Q12 — Atomic schedule handoff:** Registry activation and schedule progress are coordinated transactionally, with one admission per workflow/trigger/logical occurrence. A new cron/timezone takes over at an explicitly defined activation point; deactivation does not silently backfill old schedules. Existing Runs remain pinned.
13. **Q13 — Safe migration:** Import and validate existing bundled definitions/digests, prepare the active registry, test old pinned Run recovery, then switch reads and migrate business definitions in stages. Preserve a compatibility/rollback route and previously verified Raindrop and GitHub/R2 behavior; never drop the old registry first.
14. **Q14 — Single compiler boundary:** Trusted Node CI compiles YAML into restricted canonical plans. Runtime validates the plan envelope, digest, DSL/engine compatibility, and approved references, without parsing arbitrary YAML or executing author-provided code.
15. **Q15 — Real acceptance:** Isolated acceptance must demonstrate install/update/deactivate/rollback, old-Run recovery, authorization and credential revocation, and schedule deduplication. An independently authorized production cutover additionally verifies real manual, scheduled, and GitHub/R2 paths with sanitized evidence. Ordinary unit tests and green CI alone are insufficient.
16. **Q16 — Bounded first release:** v0.2 remains single-user with a protected publisher. Define and enforce measured limits for definition/package sizes, publication batch, activation concurrency, scheduler scanning, and history retention. Keep plans referenced by Runs; reject excess or unsupported operations explicitly. Exact numeric limits are for the buildable specification and tests, not implicit unlimited defaults.

These choices constrain the design, but do not imply production approval or claim the detailed transaction, admin protocol, or compatibility test has already been implemented.

## Consequences

- Adding or changing a workflow built from existing approved capabilities need not rebuild or deploy the engine.
- The publication and administration surface is a **different authority** from the shared MCP entry credential; deployment must not elevate that credential.
- Publication/activation, scheduler cursor transitions, connection snapshots, compatibility, and rollback require new regression coverage.
- Changing a platform capability implementation or its security/authorization behavior remains an engine-code review and deployment.
- The repository topology, publication trust model, pinning/revocation semantics, atomic handoff, safe migration, compiler boundary, acceptance scope, and bounded release are now settled. Their concrete schema, endpoint/auth mechanism, concurrency implementation, numeric limits and tests must be specified against the live code in to-spec. This ADR alone does not authorize implementation, PR merge, or production migration.

## Rejected for v0.2

- Fetching arbitrary Git contents during each `workflow_list`, `workflow_get`, or `workflow_run`.
- Making unreviewed runtime definitions a second writable source of truth.
- Permitting YAML-specified arbitrary remote endpoints/secret names/executors or arbitrary script execution.
- Overwriting a currently running plan or treating rollback as deleting historical definitions.
