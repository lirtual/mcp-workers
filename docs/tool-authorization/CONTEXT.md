# MCP Tool Authorization — Domain Context

> Status: Terminology baseline for cross-Worker design interview, 2026-10-13. Tool-gate removal scope is not yet finalized.

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

**Operation Safety Contract**:
Behavioral guarantees about valid input, bounded effects, repeatability, uncertainty, and truthful reporting of operation outcomes.
_Avoid_: Calling validation or unknown-result reconciliation an extra client tool approval.

**Tool Risk Annotation**:
Advisory metadata describing whether an operation is read-only, destructive, idempotent, or interacts with external resources.
_Avoid_: Treating metadata as an enforceable security policy.

## Scope of the interview

The requested cross-Worker direction is to transfer tool invocation approval to MCP clients such as ChatGPT and avoid redundant Worker-level read/write tool gates. The distinction between gates, authentication, resource authority, and operation safety must be maintained while the exact migration scope is agreed.
