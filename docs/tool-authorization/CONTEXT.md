# MCP Tool Authorization — Domain Context

> Status: Active design terminology, 2026-10-13. Q1–Q16 design decisions settled, with Q14 superseding earlier Raindrop preview decisions. Implementation and production release remain pending.

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

**Direct Cleanup Operation**:
An existing, destructive Raindrop tool name whose single invocation performs the requested cleanup without a preview or Worker-side confirmation stage.
_Avoid_: Calling it a read-only preview, or assuming retaining the old name guarantees compatible behavior.

**Semantic Breaking Change**:
A public tool's meaning or side effects change even though its name remains unchanged. For example a previously preview-default cleanup call will now mutate data.
_Avoid_: Treating name stability as behavioral compatibility or presuming the client refreshed its cached tool contract.

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

The client owns user-facing tool invocation approval. Worker-specific tool permission gates and duplicate confirmations are targeted for removal; ingress authentication, database/OS privileges, SQL validation, operation integrity and truthful risk metadata remain. Each logical Database connection has one `connection` field / upstream principal and distinct safe read, structured write and direct-only schema-management tools. Legacy `read/write/admin` config shapes are intentionally rejected after the separately authorized migration.

**Q14=B overrides Q5=A and Q8=A:** Raindrop retains existing cleanup tool names, removes both optional and mandatory preview behavior, and runs destructive cleanup in one call. Such same-name changed semantics require an explicit release/real-client cache refresh review.

The release order is IMA → Raindrop → Database → Remote Control using the existing manually approved GitHub Actions publisher. Remote Control acceptance uses the existing real ChatGPT/Portal/Worker/Agent path, begins with read-only review and needs separate owner permission before any write/Shell testing. Implementation, merge, actual cloud configuration and production release are not approved by these design records.
