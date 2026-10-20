---
status: accepted
date: 2026-10-20
---

# Use D1 for small execution results and R2 only for large artifacts

The Workflow MCP execution result contract stores small structured results and safe references in existing D1 records while using R2 for large files, screenshots and other significant artifacts (**Q34=A**). The default is *not* to upload every JSON result to R2 or to force large binary payloads into D1. Workflow Run metadata and lifecycle facts remain queryable from D1; artifact storage is a data plane, not a second scheduler.

## Rejected alternative

- Store all results and files, regardless of size and type, exclusively in D1.

## Consequences

Round 7 **Q49=A** requires preserving Artifacts and their references while nonterminal Runs need them, with finite retention and safe cleanup after termination; indefinite storage of all historical output is not required. Specific inline size limits, artifact naming and access control, post-terminal retention, redaction, upload verification, integrity and GC mechanisms remain **open**. D1 records must not expose sensitive R2 objects or reusable upload tokens to unauthorized callers. This decision does not create an additional R2-based workflow definition store and does not approve mirroring all GitHub stdout/stderr into R2.

Documentation-only agreement. No source implementation, infrastructure provisioning, merge, deploy, or Tickets.
