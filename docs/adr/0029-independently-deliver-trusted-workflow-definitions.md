# ADR 0029: Independently deliver trusted workflow definitions

- Status: Accepted for v0.2 direction; detailed publication and migration contract pending Round 2
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

## Consequences

- Adding or changing a workflow built from existing approved capabilities need not rebuild or deploy the engine.
- The publication and administration surface is a **different authority** from the shared MCP entry credential; deployment must not elevate that credential.
- Publication/activation, scheduler cursor transitions, connection snapshots, compatibility, and rollback require new regression coverage.
- Changing a platform capability implementation or its security/authorization behavior remains an engine-code review and deployment.
- The exact independent repository layout, publication API, immutable bundle envelope, operation-policy pinning, transaction rules, and old-registry migration are **not settled** by this ADR; see the v0.2 decision log. No implementation or production migration is authorized merely by accepting this ADR.

## Rejected for v0.2

- Fetching arbitrary Git contents during each `workflow_list`, `workflow_get`, or `workflow_run`.
- Making unreviewed runtime definitions a second writable source of truth.
- Permitting YAML-specified arbitrary remote endpoints/secret names/executors or arbitrary script execution.
- Overwriting a currently running plan or treating rollback as deleting historical definitions.
