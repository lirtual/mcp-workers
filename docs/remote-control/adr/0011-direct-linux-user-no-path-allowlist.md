# ADR-0011 — Direct Linux execution without a container or project path allowlist

Status: accepted. Date: 2026-10-12. Supersedes the isolation and filesystem scope decisions in ADR-0005 and part of ADR-0002; modifies the confinement assumption of ADR-0006. The operator explicitly requested simplicity over the previous container/workspace design.

## Context

The previous v1 design assumed a Docker-isolated executor and an explicit project directory allowlist. The operator rejected both because they make personal remote control inconvenient. The intended use is now direct Linux file and development command access under an account's ordinary operating-system permissions, rather than an artificial list of approved repository roots.

## Decision

- Do not require or deploy a container-based execution sandbox for the v1 Linux Agent.
- Do not add a hard-coded or configurable application project directory allowlist for local file and Shell tools.
- Execute v1 Linux Agent as **the operator's existing ordinary, non-root Linux login account**. The user explicitly confirmed this after declining a dedicated service account. File and Shell operations inherit the account's effective OS permissions; do not create an additional service account.
- Preserve the approved client-visible tool allowlist, identity/authentication check at ingress, device-side request verification, managed-process ownership, and local operation receipts. No host-wide administrative capability, arbitrary unrelated process termination, or automatic elevation is approved.
- Treat this as a deliberate **security trade-off**: a remote development Shell may read or modify any account-accessible content, including user configuration, application tokens, repositories and secrets. Application command blacklists and path validation do not create a security sandbox.
- Do not silently change existing production Linux permissions or existing worker ingress. This is an architecture update only.

## Consequences

- Positive: no container image, volume mounts, project-switch configuration or Docker lifecycle to maintain.
- Positive: normal Linux and WSL2 execution behave similarly.
- Cost: compromise or misuse of the remote MCP may affect everything visible to its Linux account, not merely an approved project directory. Secrets and credentials available to the chosen account may be exposed.
- The operator explicitly chose the existing login account. Its resources, SSH keys, credentials and process/network privileges may therefore be reachable. Before Shell launch, verify and document any passwordless sudo, Docker group/socket access, WSL Windows interop/mount access and other unexpectedly elevated capabilities. Account **choice is settled**, but its actual permissions are not yet measured.
- Unattended execution remains desired, but arbitrary Shell cannot be contained by blocked-command lists. Never claim that merely omitting a sudo tool prevents Shell escalation if the account has effective privilege pathways.

## Rejected prior decision

Container confinement and workspace-root mount allowlisting from ADR-0005 are superseded. ADR-0002's earlier project-root-only security implication is superseded; its exclusions of GUI and administrative privileges remain in force.

## Deferred

The operator subsequently accepted the existing MCP Portal static Bearer pattern with a **new independent secret value** in [ADR-0012](./0012-reuse-portal-bearer-auth-with-independent-secret.md), superseding earlier OAuth ADRs. No Portal configuration or production changes are authorized by this historical execution-scope record.
