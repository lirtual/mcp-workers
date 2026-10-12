# ADR-0006 — Allow unattended operations inside an authorized workspace

Status: retained with a revised execution boundary. Date: 2026-10-12. Decision input: Round 2 G2=A; isolation and workspace-root restrictions later superseded by [ADR-0011](./0011-direct-linux-user-no-path-allowlist.md).

> The unattended workflow decision remains, but the previous claims that operations are container-contained are no longer true. Actual exposure must be re-reviewed for an ordinary Linux user's accessible filesystem and secrets. This historical decision is not a production go-ahead. Client ingress for the revised ordinary Linux account security boundary is now the separately secreted Portal Bearer model in [ADR-0012](./0012-reuse-portal-bearer-auth-with-independent-secret.md), subject to end-to-end credential-delivery checks.

## Context

Remote Control MCP is intended for use from a remote AI client when the user is not physically at the Linux machine. Requiring a local confirmation for every file edit, command start or process interaction would defeat much of that use case. However, OAuth login alone cannot authorize arbitrary Shell operations and application pathname checks cannot provide OS isolation.

## Decision

- **Unattended operation is a v1 product requirement**, but only for operations permitted by an explicit workspace/tool policy and contained by the isolated execution boundary in ADR-0005.
- Within that authorized scope, development reads, selected writes and explicitly allowed development Shell/process activities may run without per-call local confirmation.
- Operations outside the authorized scope are **rejected**; do not fall back to host-wide permissions, silently escalate, or leave indefinite requests pending local approval when the machine is unattended.
- Host administration, unowned host process control, unauthorized mounts, privileged actions and unrestricted secret access are not implicitly permitted.
- A client's OAuth grant is an outer identity boundary, not a replacement for device/adapter-side authorization, tool argument validation or isolation.

## Consequences and trade-offs

- Positive: remote workflows can run when the user is away, without inventing a persistent cloud approval service.
- Cost: the workspace execution policy, credential exposure and data egress need careful treatment; prompt injection against a trusted AI client still matters inside the authorized workspace.
- Pending: exact tool allowlist, dangerous writes/deletes, interactive stdin and per-session authority; whether any scoped action requires extra confirmation. These belong to the next grilling frontier.
- No claim is made that arbitrary Shell is safe, or that ChatGPT will never ask the user to approve a tool call. Real-client permissions must be tested.
- Actual unattended write/Shell capability must **not** be exposed until isolation and authorization checks are implemented and validated.

## Rejected option

Mandatory local confirmation for every file write or Shell request was rejected because it makes unattended remote development impractical.
