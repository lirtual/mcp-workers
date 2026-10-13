# MCP Tool Authorization — Domain Context

> Status: Active design terminology, 2026-10-13. Interview Q1–Q10 and Q12 confirmed; Q11 single-call direct deletion confirmed with legacy naming unresolved. Implementation and production release remain pending.

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

**Preview Operation**:
An optional, separate read-only action that estimates the possible impact of an operation. It does not mutate, lock, grant permission, or require a following execution call.
_Avoid_: A mandatory approval step or a guaranteed snapshot.

**Execute Operation**:
A separate client-visible action that directly performs a requested change in a single invocation, without a prerequisite preview or Worker-side confirmation; it truthfully reports risk and execution outcome.
_Avoid_: An implicit side effect hidden behind a former preview-only invocation.

**Breaking Connection Migration**:
A deliberate transition from an outdated connection contract to its replacement, requiring operator action rather than silently guessing a compatible interpretation.
_Avoid_: Automatic credential promotion or compatibility aliases.

**Real Client Acceptance**:
Verification of the behavior observed through the intended MCP client's actual connected execution path, not just a simulated protocol test.
_Avoid_: Assuming a passing unit test or tool risk annotation proves that a particular approval dialog appeared.

**In-place Client Acceptance**:
Real-client validation through the existing connected service and target environment after separately approved test steps, rather than through a standalone test deployment.
_Avoid_: Treating selection of the environment as authorization to enable capabilities or manipulate production data.

**Operation Safety Contract**:
Behavioral guarantees about valid input, bounded effects, repeatability, uncertainty, and truthful reporting of operation outcomes.
_Avoid_: Calling validation or unknown-result reconciliation an extra client tool approval.

**Tool Risk Annotation**:
Advisory metadata describing whether an operation is read-only, destructive, idempotent, or interacts with external resources.
_Avoid_: Treating metadata as an enforceable security policy.

## Settled boundaries and remaining interview scope

Tool approval belongs to the MCP client; extra Worker tool gates and duplicate user-facing confirmations are targeted for removal, while ingress and resource authorization remain. Each logical database connection uses one upstream principal, while read, structured write and schema tool contracts stay distinct. Raindrop destructive operations retain optional preview. Migration proceeds per Worker (IMA, Raindrop, Database, Remote Control) with separate production approval. A breaking database credential migration is chosen; Raindrop preview and execute operations are separate tools; Remote Control release requires actual-client acceptance. Database DDL remains direct-only pending separate transport validation. Raindrop destructive actions execute in one call; optional preview never forces a second step. Existing-environment real-client acceptance is chosen for Remote Control, subject to separate authorization for state-changing tests. Remaining decisions cover exact database config schema, safe Raindrop legacy-name migration, Remote Control test authorization, and release-runbook sequencing.
