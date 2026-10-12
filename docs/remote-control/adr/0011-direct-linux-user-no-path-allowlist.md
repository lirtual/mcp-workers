# ADR-0011 — Direct Linux execution without a container or project path allowlist

Status: accepted. Date: 2026-10-12. Supersedes the isolation and filesystem scope decisions in ADR-0005 and part of ADR-0002; modifies the confinement assumption of ADR-0006. The operator explicitly requested simplicity over the previous container/workspace design.

## Context

The previous v1 design assumed a Docker-isolated executor and an explicit project directory allowlist. The operator rejected both because they make personal remote control inconvenient. The intended use is now direct Linux file and development command access under an account's ordinary operating-system permissions, rather than an artificial list of approved repository roots.

## Decision

- Do not require or deploy a container-based execution sandbox for the v1 Linux Agent.
- Do not add a hard-coded or configurable application project directory allowlist for local file and Shell tools.
- Execute local tools as an ordinary, non-root Linux account and **inherit that account's operating-system filesystem and process permissions**. A more privileged account or passwordless sudo is not part of this authorization decision.
- Preserve the approved client-visible tool allowlist, identity/authentication check at ingress, device-side request verification, managed-process ownership, and local operation receipts. No host-wide administrative capability, arbitrary unrelated process termination, or automatic elevation is approved.
- Treat this as a deliberate **security trade-off**: a remote development Shell may read or modify any account-accessible content, including user configuration, application tokens, repositories and secrets. Application command blacklists and path validation do not create a security sandbox.
- Do not silently change existing production Linux permissions or existing worker ingress. This is an architecture update only.

## Consequences

- Positive: no container image, volume mounts, project-switch configuration or Docker lifecycle to maintain.
- Positive: normal Linux and WSL2 execution behave similarly.
- Cost: compromise or misuse of the remote MCP may affect everything visible to its Linux account, not merely an approved project directory. Secrets and credentials available to the chosen account may be exposed.
- A dedicated non-root account with minimal OS permissions is a **recommendation**, not a user-approved new directory restriction; which Linux account actually runs the Agent remains to be verified/decided.
- The previously accepted unattended execution experience remains desired, but must be explicitly reconciled with the expanded OS-level reach before operational deployment.

## Rejected prior decision

Container confinement and workspace-root mount allowlisting from ADR-0005 are superseded. ADR-0002's earlier project-root-only security implication is superseded; its exclusions of GUI and administrative privileges remain in force.

## Deferred

The operator asked whether the existing MCP Portal bearer-token pattern could replace the independent OAuth design. This is an **open authentication reconsideration**, not yet an acceptance of shared-token authorization. No OAuth or Portal implementation change is authorized by this record.
