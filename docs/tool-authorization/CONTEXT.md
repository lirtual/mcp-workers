# MCP Tool Authorization — Domain Context

> Status: Active design terminology, 2026-10-13. Interview Q1–Q9 confirmed; implementation and production release remain pending.

## Language

**MCP Client**:
The software that discovers tools, decides when to request an invocation, and may require user approval before sending it.
_Avoid_: Assuming all clients implement the same approval UI or policies.

**Client Tool Approval**:
A client-side consent decision for a proposed invocation, based on its own policy, user interaction, and the tool's declared behavior.
_Avoid_: Treating approval as proof that a caller has access to the requested resource.

**Tool Permission Gate**:
An additional Worker-side decision that exposes, hides, permits, or denies a supported tool according to an application-level read/write/action toggle or approval.
_Avoid_: Conflating a tool gate with ingress authentication or underlying resource permissions.

**Ingress Authentication**:
Verification that a request is from a permitted caller before accepting MCP operations.
_Avoid_: Treating a user-facing approval dialogue as caller authentication.

**Resource Authority**:
The permissions possessed by the credentials or operating-system identity through which an operation actually reaches its target.
_Avoid_: Assuming the client's decision can confer privileges not held by that identity.

**Logical Database Connection**:
A named target database access relationship exposed by a database MCP service; separate logical connections may have different target identities and access levels.
_Avoid_: Confusing a logical connection with one global account used for all databases.

**Database Principal**:
The single upstream identity through which a logical database connection performs its supported operations, subject to the database's own grants.
_Avoid_: Treating a client's consent or a tool's classification as a grant of database authority.

**Optional Operation Preview**:
A non-mutating assessment of the likely impact of a proposed operation. A client can use it before an operation but is not obliged to do so; it is not an authorization request or a guarantee about future state.
_Avoid_: Confirmation prompt, locking the target, permission grant.

**Preview Operation**:
A separate client-visible read-only action that estimates the impact of an action without modifying the target.
_Avoid_: A mandatory approval step or permission grant.

**Execute Operation**:
A separate client-visible action that explicitly carries out a requested change and must accurately describe its potential side effects.
_Avoid_: An implicit side effect hidden behind a former preview-only invocation.

**Breaking Connection Migration**:
A deliberate transition from an outdated connection contract to its replacement, requiring operator action rather than silently guessing a compatible interpretation.
_Avoid_: Automatic credential promotion or compatibility aliases.

**Real Client Acceptance**:
Verification of the behavior observed through the intended MCP client's actual connected execution path, not just a simulated protocol test.
_Avoid_: Assuming a passing unit test or tool risk annotation proves that a particular approval dialog appeared.

**Operation Safety Contract**:
Behavioral guarantees about valid input, bounded effects, repeatability, uncertainty, and truthful reporting of operation outcomes.
_Avoid_: Calling validation or unknown-result reconciliation an extra client tool approval.

**Tool Risk Annotation**:
Advisory metadata describing whether an operation is read-only, destructive, idempotent, or interacts with external resources.
_Avoid_: Treating metadata as an enforceable security policy.

## Settled boundaries and remaining interview scope

Tool approval belongs to the MCP client; extra Worker tool gates and duplicate user-facing confirmations are targeted for removal, while ingress and resource authorization remain. Each logical database connection uses one upstream principal, while read, structured write and schema tool contracts stay distinct. Raindrop destructive operations retain optional preview. Migration proceeds per Worker (IMA, Raindrop, Database, Remote Control) with separate production approval. A breaking database credential migration is chosen; Raindrop preview and execute operations are separate tools; Remote Control release requires actual-client acceptance. Remaining choices are the database transport boundary, safe legacy Raindrop name replacement, and the Remote Control acceptance environment.
