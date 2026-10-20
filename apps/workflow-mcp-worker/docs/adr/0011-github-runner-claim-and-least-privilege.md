---
status: accepted
date: 2026-10-20
---

# Authenticate GitHub execution candidates and bind each logical Attempt to one owner

Registered GitHub Actions heavy-executor jobs prove their identity using GitHub OIDC and must obtain one atomic, D1-backed Attempt Claim before performing business work (**Q26=A**). A logical Attempt can have multiple candidate physical GitHub jobs after an ambiguous dispatch, but at most one candidate becomes the authorized execution owner. The execution/dispatch credential has independent, minimal repository/workflow scope and must **not** automatically inherit or share the multi-account PAT pool of the separate GitHub Actions management MCP (**Q27=A**).

## Rejected alternatives

- Relying on a GitHub Run ID and HTTP dispatch responses alone to avoid duplicate business execution.
- Reusing the full GitHub Actions MCP multi-PAT credential pool for a privileged execution path.

## Consequences

OIDC issuer/audience/repository/workflow/ref validation, dispatch-unknown recovery, exact Claim schema and atomicity, lease scope, callback authenticity and deduplication, cancellation mechanics, result reconciliation, executor versioning and Artifact handling remain to be specified. Round 7 **Q48=A** (ADR-0018) requires callback fact persistence before notification, including idempotent handling of duplicates/late messages and recoverable notification failures. Round 5 **Q33=A** (ADR-0012) requires truthful best-effort cancellation; **Q34=A** (ADR-0013) splits small structured outputs from large R2 Artifacts; **Q35=A** (ADR-0014) requires nonterminal Run compatibility checks before release. The effect of Claim timeouts and whether/how ownership can be reconciled or transferred remain unresolved; a timeout alone is not evidence that the original physical task stopped. The heavy-capability registry is **not** a static registry of callable MCP Servers; Q7=B remains unchanged.

Design only: no GitHub Actions workflow code, PAT provisioning, release, deployment, merge, or Tickets.
