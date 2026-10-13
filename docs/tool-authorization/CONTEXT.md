# MCP Tool Authorization — Domain Context

> Status: Active design terminology, 2026-10-13. Q1=A (remove tool gates, retain boundary auth), Q2=B (one database principal per logical connection), Q3=A (client owns tool confirmation). Implementation and rollout remain undecided.

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

**Operation Safety Contract**:
Behavioral guarantees about valid input, bounded effects, repeatability, uncertainty, and truthful reporting of operation outcomes.
_Avoid_: Calling validation or unknown-result reconciliation an extra client tool approval.

**Tool Risk Annotation**:
Advisory metadata describing whether an operation is read-only, destructive, idempotent, or interacts with external resources.
_Avoid_: Treating metadata as an enforceable security policy.

## Settled boundaries and remaining interview scope

Tool approval belongs to the MCP client, extra Worker tool gates and duplicate user-facing confirmations are targeted for removal, and the ingress and resource-authorization boundaries remain. Each logical database connection has one database principal; different logical connections may use different principals. The design interview is still determining the database tool surface, the role of destructive-operation previews, and the release/acceptance plan.
