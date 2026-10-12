# Remote Control MCP — Domain Context

> Status: Product terminology and Round 1 scope decisions accepted on 2026-10-12. Implementation design and permissions are still under discussion.

## Language

**Remote Control MCP**:
A single-user, self-hosted MCP product that allows an authorized AI client to request controlled operations on a Linux host.
_Avoid_: **Remote Desktop MCP**, which implies remote graphical screen access and conflicts with the similarly named vendor product.

**Linux Host**:
A Linux machine or Linux runtime environment targeted for remote operations.
_Avoid_: Treating WSL2 as the only supported host.

**WSL2 Linux Environment**:
A possible deployment variant of the Linux Host, not a product or protocol requirement.

**Workspace**:
An explicitly designated set of project directories and associated development resources in which remote operations are intended to occur.
_Avoid_: Equating a workspace with the entire host filesystem.

**Remote Operation**:
A request from an authorized client to inspect or change workspace resources, run a development command, or interact with a managed process; each operation has a defined authorization boundary and outcome.

**Managed Process**:
A development process started or tracked through Remote Control MCP and distinguishable from unrelated host processes.
_Avoid_: Assuming permission to manipulate every process on the Linux host.

**Remote MCP Client**:
A client that directly communicates with this product using MCP and has its own authenticated authorization relationship.
_Avoid_: Treating possession of a different MCP app's shared token as permission to control this Linux Host.

**Graphical Desktop Control**:
Remote viewing or manipulation of a desktop screen, mouse or keyboard. This is excluded from the first release.

## Settled product boundaries

1. The product name is **Remote Control MCP**; the prospective Worker identifier is `remote-control-mcp-worker`.
2. The system is **Linux-first**. WSL2 is a deployment variant and is not required for core execution.
3. This is a separate MCP application context, independent of the existing Database, IMA and Raindrop contexts.
4. First-release scope is **workspace file read/write, search, development Shell and managed processes**. Host-wide administration is out of scope.
5. **Direct remote MCP client connection with independent OAuth authorization** is required; relying solely on the existing MCP Portal is not the agreed entrypoint.
6. **Graphical desktop, mouse, keyboard and native Windows execution** are not first-release product capabilities.
7. **VPC-only private network connection** is a first-release constraint, without publicly publishing the device endpoint. The technical record for that choice lives in ADR-0004.

## Unsettled boundaries — not approved yet

- How workspace confinement is enforced against arbitrary Shell commands: isolated execution environment versus host user identity and local policy.
- When workspace operations may run unattended; what constitutes destructive or privileged activity and what to do when local approval cannot be given.
- Operation identity, receipt persistence, timeout/unknown outcome handling, retries, process restart/cancel and revocation semantics.
- Specific identity provider, OAuth component layout, credential rotation and actual client compatibility.
- Concrete limits (payload, output, time), supported tool shapes and rollout/monitoring policy.

Architecture and deployment implementation details belong in the research draft and ADRs, not in this vocabulary document.
