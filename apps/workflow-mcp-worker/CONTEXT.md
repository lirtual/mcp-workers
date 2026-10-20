# Workflow MCP Context

Workflow MCP is a planned, independently owned bounded context for orchestrating existing MCP capabilities and external operations. It is AI/MCP-first, not a clone of a general-purpose visual automation platform.

## Language

**Workflow**:
A declarative description of how capabilities and steps are coordinated to achieve a result.
_Avoid_: Script, GitHub Actions workflow (when referring to Workflow MCP definitions)

**Workflow Definition**:
The editable YAML/JSON description of a Workflow that can be created, changed, and published by the owner.
_Avoid_: Executable program, visual canvas

**Workflow MCP**:
The MCP-facing automation product that defines and manages Workflows while preserving the separate ownership of upstream MCP Workers.
_Avoid_: n8n replacement, unified MCP platform

**MCP Target**:
An MCP Server selected as a source of tools for a Workflow; prior registration is not required.
_Avoid_: Pre-registered Connection (when referring to every callable MCP Server)

**Draft**:
An editable Workflow Definition that has not been published as an executable version.
_Avoid_: Active workflow, Published Version

**Published Version**:
A fixed version of a Workflow Definition made available for execution by explicit publication.
_Avoid_: Live draft, latest mutable definition

**Run**:
One execution of a Workflow bound to a particular Published Version for its lifetime.
_Avoid_: Definition, GitHub Actions job

**Target Credential**:
An owner-authorized credential associated with a specific MCP Target rather than the Workflow MCP Portal identity.
_Avoid_: Portal token, global upstream credential

**Operation Authorization**:
The owner's approval of the external operations a Workflow may perform when its Published Version becomes active.
_Avoid_: Portal login, blanket approval of every discovered tool

**Webhook Event**:
A distinct external event that can trigger a Workflow, identified by the producer's stable event identity.
_Avoid_: Request body hash, duplicate HTTP delivery

**Schedule Occurrence**:
An intended time-based trigger of a Workflow, distinct from the time a delayed scheduler happens to process it.
_Avoid_: Scheduler invocation

**Attempt**:
One logical attempt to execute a Step, which can be represented by more than one candidate external job without granting all candidates permission to perform business work.
_Avoid_: Physical GitHub Actions run

**Attempt Claim**:
The binding of one Attempt to the single external execution candidate authorized to perform its work.
_Avoid_: Dispatch acknowledgement, expired lease

## Boundaries

- This context is planned under `apps/workflow-mcp-worker` in the existing `lirtual/mcp-workers` monorepo; implementation has **not** been authorized by the design discussion.
- Workflow MCP composes other capabilities. It does not take ownership of upstream MCP Workers' tools, credentials, business rules, or release lifecycles.
- ChatGPT / AI agents using MCP are the primary interaction surface. A visual editor is not a prerequisite.
- YAML/JSON is the intended declarative definition format. The authenticated owner can **create/edit Drafts through MCP**, validate and **explicitly Publish** them; simply saving a change does not automatically activate it. D1 stores definitions, Published Versions, and necessary metadata; Git commits/deployments are not required for definition publication.
- A **Run is pinned to the Published Version at admission**; edits/new publications do not mutate in-flight Run behavior. Retention, rollback, retirement and deploy-version compatibility still require design.
- Workflow MCP supports **dynamic discovery and invocation of arbitrary MCP Servers without preregistration**, initially via **Streamable HTTP** with tested current and recent protocol-version compatibility. SSE/stdio compatibility is deferred; this is a transport scope decision, not a static target allowlist. Exact version negotiation/conformance remains open.
- Target-specific authorization may **securely persist credentials for unattended recurring Workflows**. Target credentials are stored **encrypted in D1** using a **separate Worker Secret as master encryption key**, never the Portal token; the Portal token is not forwarded automatically. Encryption/key rotation and recovery protocols remain open.
- Dynamic targets are still subject to **SSRF/network safeguards** (metadata, loopback, unintended private ranges, DNS rebinding and redirect bypass defense). These safety controls do not become preregistration rules.
- **Publish validates and obtains necessary Operation Authorization, then activates** the Published Version. No second mandatory Enable step is required; pause/disable remains available. Already approved scheduled executions do not need repeated manual approval, but new high-risk tools, widened rights, or material contract changes require re-approval; compatible harmless changes do not automatically require it. Authorization identity, drift classification and in-flight pause/disable behavior remain open.
- The initial workflow graph is a **bounded DAG** with dependencies, conditions, and parallel steps; arbitrary loops and full dynamic graph semantics are out of initial scope.
- **Cloudflare Workflows** owns durable DAG orchestration, while **D1** holds definitions/versions, coordination and queryable state. Tool retries are bounded to read-only/proven-idempotent actions; uncertain externally-effectful writes are not blindly retried. **GitHub Actions** executes registered heavy capabilities (browser, CLI, Python) with GitHub **OIDC** and an atomic D1 **Attempt Claim** so only one candidate gets execution authority. Its dispatch credentials are independent and least-privilege, not the GitHub Actions management MCP multi-PAT pool. Exact result/claim/callback protocols remain open.
- Supported trigger types are **manual**, **webhook**, and **Cron**. Webhooks use their own authentication and a stable Event ID for logical Run deduplication; request-body hash is not event identity. Cron declares a timezone and defaults to `misfire: latest`, not full backlog replay. Exact identity retention, DST handling and recovery bookkeeping remain open.
- The initial product uses a **single owner** authenticated through the existing MCP Portal; no multi-user/RBAC system is required. Target-specific permissions and execution identity still require explicit design.
- The 2026-09-18 Workflow MCP v0.1 technical specification remains the review baseline. Git-only definitions and static MCP Connection requirements were superseded by Q5=B and Q7=B. Q11–Q27 now settle publishing lifecycle, pinned versions, D1 storage/encryption, Streamable HTTP compatibility policy, target/network permissions, trigger identity/misfires, safe retries and GitHub OIDC/Claim with execution credential separation. Exact protocols, failure guarantees and unconfirmed details remain open.

See [ADR-0001](docs/adr/0001-mcp-native-product-boundary.md), [ADR-0002](docs/adr/0002-runtime-managed-definitions.md), [ADR-0003](docs/adr/0003-dynamic-mcp-targets.md), [ADR-0004](docs/adr/0004-cloudflare-workflows-and-bounded-dag.md), [ADR-0005](docs/adr/0005-runtime-publication-and-run-versioning.md), [ADR-0006](docs/adr/0006-dynamic-mcp-boundaries.md), [ADR-0007](docs/adr/0007-registered-github-heavy-executor.md), [ADR-0008](docs/adr/0008-publish-authorization-and-tool-drift.md), [ADR-0009](docs/adr/0009-encrypted-d1-target-credentials.md), [ADR-0010](docs/adr/0010-trigger-admission-and-safe-retries.md), [ADR-0011](docs/adr/0011-github-runner-claim-and-least-privilege.md), and [Grill With Docs decisions](docs/design/grill-with-docs.md).
