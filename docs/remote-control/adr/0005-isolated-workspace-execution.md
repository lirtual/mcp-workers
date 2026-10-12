# ADR-0005 — Isolate v1 execution to a containerized workspace

Status: accepted. Date: 2026-10-12. Decision input: Round 2 G1=A.

## Context

ADR-0002 includes development Shell and file writes but explicitly excludes host-wide administration. The upstream Desktop Commander allowedDirectories and blockedCommands settings are guardrails, not a sandbox: arbitrary Shell commands can escape application-level pathname restrictions. Running the executor under a normal host account would expose that account's accessible files, credentials and processes.

## Decision

- Use an **isolated Linux execution environment/container** for v1 Desktop Commander tool execution.
- Expose **only explicitly authorized project workspace mounts** and separately approved minimal runtime resources. Other host and WSL/Windows filesystems remain inaccessible by default.
- No privileged container, host PID namespace, Docker/container-runtime socket, broad host filesystem mounts or unnecessary host credentials. Running a command in the workspace does not confer host administration authority.
- Scope remote file operations, development Shell and managed processes to this isolated environment. Enforce a separate tool and parameter authorization boundary; container isolation is necessary but not sufficient.
- Keep the Linux-first model: the container runtime is a deployment/privilege boundary, not a new end-user remote GUI or a WSL2-specific tool interface.

## Consequences and trade-offs

- Positive: OS-level separation prevents the normal Linux host account's ambient permissions from becoming implicit AI permissions.
- Positive: one workspace containment model can support unattended workflows without writing a general shell command sandbox.
- Cost: container startup, network access and workspace mounts must be designed and tested; package installs/build caches may need explicit scoped access.
- Risk: a mount containing credentials or a broadly privileged service endpoint would weaken isolation. The specific mount set and egress policy remain separate approval decisions.
- Pending: choose the placement of the adapter relative to the container, mount profiles, uid mapping, persistence, and rollout; **do not implement these from assumptions**.

## Rejected option

Direct host execution as an ordinary Linux user was rejected for v1 development Shell because a normal user's broader host permissions would undermine the agreed workspace-only control boundary.

This ADR does not authorize adding credentials, mounting additional directories, changing the host or deploying a container.
