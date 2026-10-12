# Remote Control MCP — Domain Context

> Status: Product terminology and Round 1 (F1–F4) plus Round 2 (G1–G3) decisions accepted on 2026-10-12. Detailed authorization, process lifecycle and implementation remain under discussion.

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

**Execution Boundary**:
The security boundary separating authorized workspace activity from unrelated host data, processes and capabilities.
_Avoid_: Treating a directory filter or command blacklist by itself as the boundary.

**Unattended Remote Operation**:
An authorized workspace operation that may proceed while the device owner is not locally available to confirm each action.
_Avoid_: Assuming unattended means host-wide or unrestricted authorization.

**Operation ID**:
A stable identity for one remote operation, reused when querying or reconciling that operation rather than creating a new execution intent.

**Operation Receipt**:
The authoritative minimal record of whether a state-changing operation was admitted and which execution state is known, allowing interrupted calls to be reconciled.

**Unknown Outcome**:
A state in which an operation may have reached execution but available evidence cannot establish its final effect.
_Avoid_: Relabeling an uncertain operation as failed or safe to retry.

## Settled product boundaries

1. The product name is **Remote Control MCP**; the prospective Worker identifier is `remote-control-mcp-worker`.
2. The system is **Linux-first**. WSL2 is a deployment variant and is not required for core execution.
3. This is a separate MCP application context, independent of the existing Database, IMA and Raindrop contexts.
4. First-release scope is **workspace file read/write, search, development Shell and managed processes**. Host-wide administration is out of scope.
5. **Direct remote MCP client connection with independent OAuth authorization** is required; relying solely on the existing MCP Portal is not the agreed entrypoint.
6. **Graphical desktop, mouse, keyboard and native Windows execution** are not first-release product capabilities.
7. **VPC-only private network connection** is a first-release constraint, without publicly publishing the device endpoint. See ADR-0004.
8. The **Execution Boundary is an isolated Linux workspace environment**, not the entire host user's permissions; it must expose only authorized project resources. See ADR-0005.
9. **Unattended Remote Operations** are required for permitted workspace activity, including authorized development commands. Out-of-scope activity is denied rather than escalated. See ADR-0006.
10. State-changing operations must have stable **Operation IDs** and minimal local **Operation Receipts**. An **Unknown Outcome** cannot be blindly replayed. See ADR-0007.

## Unsettled boundaries — not approved yet

- Which upstream tools and parameters become remote capabilities; how destructive workspace writes, interactive process inputs and secret handling are authorized.
- Managed-process lifecycle: owned sessions, stopping/canceling, output paging, and behavior after device restart.
- Exact local receipt retention/storage, crash recovery, token revocation and cleanup rules.
- Specific identity provider, OAuth component layout, credential rotation and actual client compatibility.
- Concrete isolation mount/network policy, limits (payload, output, time), supported tool shapes and rollout/monitoring policy.

Architecture and deployment implementation details belong in the research draft and ADRs, not in this vocabulary document.
