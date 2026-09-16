# ADR-0003: Bounded V1 Tool Surface

**Status:** Accepted

## Context
The reference project exposes up to 79 tools, including recursive smart tools and administrative capabilities. Mapping all of them into a Worker would increase risk and maintenance cost and can conflict with Workers Free request budgets.

## Decision
V1 exposes only core filesystem operations, direct download-link retrieval, bounded small-file upload, and basic OpenList task management. Large-file proxying, recursive scans, mirror, shares, offline download, torrents, and administrator APIs are out of scope.

## Consequences
The tool catalog is smaller and easier for models to use. Additional capabilities require explicit later design rather than silent parity expansion.
