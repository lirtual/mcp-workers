# ADR-0001 — Linux-first Remote Control MCP

Status: accepted. Date: 2026-10-12.

## Context

The original Remote Desktop MCP VPC-only research document used WSL2 as its first device environment, but the product is now named **Remote Control MCP** and is intended to support Linux hosts more generally. Binding the MCP tool contracts, agent transport and lifecycle to WSL-specific filesystem paths or Windows interop would make normal Linux installation and later server deployment unnecessarily difficult.

## Decision

- Design the product and its local execution interface **Linux-first**.
- Treat WSL2 as a supported Linux deployment variant that may be used for initial real-world tests, **not** as the required operating system.
- Keep WSL-specific installation, network and interop accommodations outside the core tool contract and ordinary Linux operation semantics.
- The official product name is **Remote Control MCP**; its proposed application name is `remote-control-mcp-worker`.

## Consequences and trade-offs

- Positive: a single Linux execution model can serve workstations, servers, and WSL2 without maintaining a WSL-only core.
- Positive: avoids misleading remote-desktop/GUI branding when the product's initial control surface is being defined.
- Cost: Linux distribution/service-manager differences and the WSL2 network namespace need integration tests or deployment instructions.
- Excluded from this ADR: deciding whether the first release supports host-wide Shell, Windows-native commands, GUI input, containers, direct OAuth, or a particular tunnel endpoint. These are unresolved frontier decisions, not implied approvals.
- This ADR **does not authorize implementation, host-control privileges, deployment, or changes to existing production Workers**.

## Rejected option

A WSL2-only product was rejected because it would couple a general-purpose remote host control tool to one Windows-hosted Linux environment without any functional need.
