# ADR-0009 — Owned development sessions

Status: accepted. Date: 2026-10-12. Source: H2=A.

## Context

Development servers and longer jobs need to keep running after an MCP tool call returns. Limiting every command to a synchronous request would make this product less useful.

## Decision

Support locally tracked **Agent-owned development processes under the operator's existing Linux login account** that may continue beyond an individual MCP request. The earlier workspace-directory isolation assumption was superseded by [ADR-0011](./0011-direct-linux-user-no-path-allowlist.md); session ownership is about process identity, not filesystem path. Provide session identities, status checks, bounded output retrieval and explicit session stop operations. Do not automatically restart a process when its outcome is uncertain, and do not manage unrelated host processes.

## Consequences

This enables typical development workflows without a cloud task scheduler. It requires a small local session lifecycle, bounded output and cleanup policy. Exact session identity, input rules, restart recovery and limits are deferred for later review. This is a design record, not implementation or deployment approval.
