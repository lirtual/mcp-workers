---
status: accepted
date: 2026-10-20
---

# Authenticate GitHub execution candidates and bind each logical Attempt to one owner

Registered GitHub Actions heavy-executor jobs prove their identity using GitHub OIDC and must obtain one atomic, D1-backed Attempt Claim before performing business work (**Q26=A**). A logical Attempt can have multiple candidate physical GitHub jobs after an ambiguous dispatch, but at most one candidate becomes the authorized execution owner. The execution/dispatch credential has independent, minimal repository/workflow scope and must **not** automatically inherit or share the multi-account PAT pool of the separate GitHub Actions management MCP (**Q27=A**).

## Rejected alternatives

- Relying on a GitHub Run ID and HTTP dispatch responses alone to avoid duplicate business execution.
- Reusing the full GitHub Actions MCP multi-PAT credential pool for a privileged execution path.

## Minimal-entity interpretation confirmed during review (2026-10-20)

**No new identity platform:** existing Portal (Q10) remains the only owner/client ingress authorization, and GitHub-issued OIDC is **solely Runner→Claim/Callback workload identity**, not another owner login. Both validations can live in the Workflow MCP Worker without a separate service, user registry, private OIDC issuer, self-issued per-Attempt Token, long-lived Runner secret or JWKS persistence database. One existing logical D1 Attempt owns the atomic single-winner condition; reuse the planned D1 callback receipt for receipt-first signaling, not a new broker.

**Reuse logic ≠ reuse broad credential authority:** reuse GitHub Actions MCP REST client/dispatch patterns where helpful, but Q27 rejects letting heavy executor inherit the separate management MCP's multi-PAT `GH_TOKEN` scope, or passing a general Portal token to the GitHub Job. A minimally scoped dispatch credential is needed only if an equally narrow, existing delegated execution path cannot be verified. No new dedicated Worker or per-Run credential entity follows from this ADR.

**OIDC signature alone is insufficient:** validate actual allowed issuer, audience, temporal claims and repository/ref/workflow identity, plus prove the claimant is an authorized candidate of this *specific* `attempt_id` / pinned capability. Normal workflows use documented `workflow_ref`; `job_workflow_ref` applies when using a reusable workflow and must not be mandated unconditionally. Two Jobs from a trusted repository are not automatically authorized for every Attempt. The remote GitHub `run_id` may be shared across reruns of a physical workflow; correctly distinguish `run_attempt` / available job identity and never silently transfer an existing owner on timeout. Keep candidate correlation in the smallest existing Attempt/dispatch state that can prove it; only propose a new projection if tests demonstrate it cannot be represented safely.

**Implementation gate:** any proposal for an extra table, token signing key, Claim daemon, runner secret, multi-account privilege bridge or service must identify the exact invariant, existing reuse alternatives, operational lifecycle and failing test requiring the extra entity. This gate does not relax security or create a new accepted Q decision.

## Consequences

OIDC issuer/audience/repository/workflow/ref validation, dispatch-unknown recovery, exact Claim schema and atomicity, lease scope, callback authenticity and deduplication, cancellation mechanics, result reconciliation, executor versioning and Artifact handling remain to be specified. Round 7 **Q48=A** (ADR-0018) requires callback fact persistence before notification, including idempotent handling of duplicates/late messages and recoverable notification failures. Round 5 **Q33=A** (ADR-0012) requires truthful best-effort cancellation; **Q34=A** (ADR-0013) splits small structured outputs from large R2 Artifacts; **Q35=A** (ADR-0014) requires nonterminal Run compatibility checks before release. The effect of Claim timeouts and whether/how ownership can be reconciled or transferred remain unresolved; a timeout alone is not evidence that the original physical task stopped. The heavy-capability registry is **not** a static registry of callable MCP Servers; Q7=B remains unchanged.

Design only: no GitHub Actions workflow code, PAT provisioning, release, deployment, merge, or Tickets.
