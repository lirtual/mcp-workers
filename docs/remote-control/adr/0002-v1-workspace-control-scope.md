# ADR-0002 — Workspace-scoped Linux control for v1

Status: accepted. Date: 2026-10-12. Decision inputs: Round 1 F1=A and F3=A.

## Context

The Remote Control MCP product could either expose a whole Linux host administration surface or focus on project development. It could also add remote GUI viewing, mouse and keyboard capabilities. Those choices substantially change the threat model, tool surface, execution dependencies and maintenance cost.

## Decision

- The first release targets **workspace file read/write, search, development Shell commands and managed process interactions**.
- Host-wide system administration and unrelated host-process control are **not included** in the first-release contract.
- Linux graphical desktop viewing, mouse control, keyboard control, video and native Windows operations are **out of scope** for the first release.
- A read-only connection/authorization probe may precede exposing write/Shell functionality; a passing probe never grants write or Shell authority.

## Consequences and trade-offs

- Positive: one coherent developer-oriented product, without a second GUI/video transport or a general system administration framework.
- Positive: fewer privileged operations and a smaller client-visible tool contract.
- Trade-off: this initial product cannot be assumed to manage the entire machine, privileged system settings or unowned background processes.
- Critical limitation: **a workspace pathname allowlist alone cannot constrain arbitrary Shell**. A separate decision must establish the real execution/OS isolation boundary, unattended authority and writable mounts before enabling Shell in production.
- This ADR does **not** determine the runtime isolation method, specific tools, command permissions, approvals, retries, or deployment authorization.

## Rejected options

1. Host-wide Linux administration in v1: larger security and recovery surface than needed for the accepted developer-focused scope.
2. Screen/mouse/keyboard GUI control in v1: materially different subsystem and needless complexity for the accepted initial use case.
