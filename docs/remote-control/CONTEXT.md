# Remote Control MCP — Domain Context

> Status: Initial agreed vocabulary. The implementation, scope and authorization rules are still under design.

## Language

**Remote Control MCP**:
A single-user, self-hosted MCP product for requesting controlled operations on a remote host through an authorized AI client.
_Avoid_: **Remote Desktop MCP**, which suggests a screen-sharing GUI product and collides conceptually with the vendor's Remote Desktop Commander service.

**Linux Host**:
A machine or Linux environment targeted by remote operations. The product is designed around Linux execution semantics rather than a Windows-specific execution API.
_Avoid_: Equating a host with a WSL2 instance or assuming a particular Linux distribution.

**WSL2 Linux Environment**:
One possible deployment environment for a Linux Host, not the defining product or runtime requirement.

**Remote Operation**:
A requested action on a Linux Host whose permissions, results, and side effects must be defined independently of the AI client's natural-language request.

## Settled product boundaries

1. The product and repository-facing name is **Remote Control MCP** (`remote-control-mcp-worker` for the prospective Worker).
2. The platform orientation is **Linux-first**. WSL2 is a deployment variant, not a required operating system or a dependency of the core tool contract.
3. This is a separate MCP application boundary within `mcp-workers`; the existing Database, IMA, and Raindrop applications remain independent.

## Open questions (not decisions)

- Exact v1 capabilities: workspace files, shell/process management, system administration, or GUI control.
- Execution isolation: constrained container or ordinary Linux account; approval and unattended operation semantics.
- Client entry point and authorization scheme: direct resource OAuth, MCP Portal, or another verified arrangement.
- Device identity, local policy, operation receipt, interruption, and unknown-side-effect behavior.
- Exact Cloudflare VPC route, deployment lifecycle and end-to-end client compatibility.

Architecture and library choices belong in research and ADRs, not in this domain glossary.
