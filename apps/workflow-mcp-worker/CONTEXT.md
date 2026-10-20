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

**Paused Workflow**:
A Workflow that no longer admits new triggers while its already admitted Runs remain independent.
_Avoid_: Cancelled Run, deleted definition

**Cancellation Request**:
An instruction to try to stop a Run's further work; it does not establish that externally dispatched work stopped or that earlier effects were reversed.
_Avoid_: Confirmed cancellation, rollback

**Artifact**:
A persisted large output of a Run, such as a file or screenshot, referenced separately from its smaller structured result.
_Avoid_: Run, generic log line

**Authorization Wait**:
A Run state where an external operation cannot proceed until the owner approves its specific MCP target, tool and permitted scope.
_Avoid_: Paused Workflow, pre-registered Connection

**Archived Workflow**:
A retired Workflow that no longer accepts new Runs while its required historical Published Versions and associated Runs remain available under retention rules.
_Avoid_: Immediate hard deletion, Paused Workflow

**Indeterminate Outcome**:
An outcome for which the effects or termination of externally delegated work cannot be confirmed.
_Avoid_: Failed, Cancelled, Rolled back

**Published Plan**:
The immutable, validated executable representation of a Published Version, kept stable for every Run that references it.
_Avoid_: Live Draft, latest editable YAML

**Callback Receipt**:
A durable record of an authenticated external Attempt callback that survives failure to notify the waiting orchestrator.
_Avoid_: Successful completion, transient wake-up message

## Boundaries

- This context is planned under `apps/workflow-mcp-worker` in the existing `lirtual/mcp-workers` monorepo; implementation has **not** been authorized by the design discussion.
- Workflow MCP composes other capabilities. It does not take ownership of upstream MCP Workers' tools, credentials, business rules, or release lifecycles.
- ChatGPT / AI agents using MCP are the primary interaction surface. A visual editor is not a prerequisite.
- YAML/JSON is the intended declarative definition format. The authenticated owner can **create/edit Drafts through MCP**, validate and **explicitly Publish** them; simply saving a change does not automatically activate it. D1 stores definitions, Published Versions, and necessary metadata; Git commits/deployments are not required for definition publication.
- A **Run is pinned to the Published Version at admission**; edits/new publications do not mutate in-flight Run behavior. Draft edits use revision/conflict checks; Publish validates, canonicalizes and compiles an **immutable Published Plan**, activating it atomically only after authorization; earlier plans stay active if publication fails. **Pause/disable blocks new admissions only**, leaving existing Runs to continue unless separately cancelled. Archiving retains versions/history needed by active Runs and permitted retention; no immediate hard deletion. Plans/Artifacts required by nonterminal Runs are never reclaimed early; terminated history and Artifacts use finite retention (Q45, Q49). Engine/runner deployments require compatibility checks against nonterminal Runs; incompatible releases must block or follow an explicitly reviewed migration (Q29, Q35). Exact retention and compatibility algorithm remain open.
- Workflow MCP supports **dynamic discovery and invocation of arbitrary MCP Servers without preregistration**, initially via **Streamable HTTP** with tested current and recent protocol-version compatibility. SSE/stdio compatibility is deferred; this is a transport scope decision, not a static target allowlist. Exact version negotiation/conformance remains open.
- Target-specific authorization may **securely persist credentials for unattended recurring Workflows**. Target credentials are stored **encrypted in D1** using a **separate Worker Secret as master encryption key**, never the Portal token; the Portal token is not forwarded automatically. Target credential rotation under unchanged target/authorization scope requires **no republish**, while revoked authorization cannot be used for subsequent calls. Encryption/key rotation and recovery implementation remain open (Q30).
- Dynamic targets are still subject to **SSRF/network safeguards** (metadata, loopback, unintended private ranges, DNS rebinding and redirect bypass defense). These safety controls do not become preregistration rules.
- **Publish validates and obtains necessary Operation Authorization, then activates** the Published Version. No second mandatory Enable step is required; pause/disable remains available. Already approved scheduled executions do not need repeated manual approval, but new high-risk tools, widened rights, or material contract changes require re-approval; compatible harmless changes do not automatically require it. Operation Authorization binds the specific MCP target identity, tool and permitted operation scope; same-named tools at a different target never automatically inherit approval. A Run that computes an unapproved target/tool at runtime **waits for new authorization before external execution**, including unattended schedules; no blanket dynamic-pattern grant is implied. An incompatible MCP Tool Schema must stop invocation with a contract error: AI may not silently rewrite an active Published Plan (Q46). Exact identity, resumption and drift classification remain open (Q28, Q37).
- The initial workflow graph is a **bounded DAG** with dependencies, conditions, and parallel steps; arbitrary loops and full dynamic graph semantics are out of initial scope. Expressions are typed, restricted field references/comparisons/boolean conditions, with no arbitrary JavaScript eval or custom functions. A Step runs by default only when dependencies succeed; explicit failure/always conditions remain subject to the Run cancellation gate. Both total Steps and ready-Step parallelism are bounded; new Run admission beyond application capacity is explicitly rejected without a custom persistent overflow queue, while Cloudflare's internal instance queue remains a platform detail (Q47). Exact syntax and limits await the technical spec.
- **Cloudflare Workflows** owns durable DAG orchestration, while **D1** holds definitions/versions, coordination and queryable state. Tool retries are bounded to read-only/proven-idempotent actions; uncertain externally-effectful writes are not blindly retried. **GitHub Actions** executes registered heavy capabilities (browser, CLI, Python) with GitHub **OIDC** and an atomic D1 **Attempt Claim** so only one candidate gets execution authority. Its dispatch credentials are independent and least-privilege, not the GitHub Actions management MCP multi-PAT pool. External Attempt callbacks must have a durable, idempotent **Callback Receipt persisted before notifying the Cloudflare Workflow**, with recoverable notification failure (Q48). Cancellation requests are best effort; external work is reported stopped only after confirmation, and uncertain effects have an explicit **indeterminate** outcome distinct from `failed` and `cancelled`. Small structured results reside in D1; large files/screenshots use R2 Artifact references, not all JSON in R2. Exact result/claim/callback protocols and size/retention thresholds remain open (Q33–Q34).
- Supported trigger types are **manual**, **webhook**, and **Cron**. Webhooks use their own authentication and a stable Event ID for logical Run deduplication; request-body hash is not event identity. Cron declares a timezone and defaults to `misfire: latest`, not full backlog replay. Webhook deduplication identity includes Workflow + Trigger + source + event ID with finite retention. Cron skips nonexistent DST local times and triggers a repeated local time only once. Precise TTL, admission atomicity and recovery bookkeeping remain open (Q31–Q32).
- The initial product uses a **single owner** authenticated through the existing MCP Portal; no multi-user/RBAC system is required. **MCP management tools remain atomic operations** (create/update/validate/publish/pause and run inspection/control) rather than a catch-all `workflow_manage(action=...)` tool (Q36). Every manual `workflow_run` is asynchronous, returning a Run ID promptly; status/log/result tools are separate (Q43). First release excludes arbitrary internal Attempt/D1/GitHub Job administration (Q50); precise schema/naming is proposed in the consolidated spec. Target-specific permissions and execution identity details still require explicit design.
- The 2026-09-18 Workflow MCP v0.1 technical specification remains the review baseline. Git-only definitions and static MCP Connection requirements were superseded by Q5=B and Q7=B. Q1–Q50 establish the MCP-native bounded product, runtime-authored Drafts and compiled immutable Published Plans, dynamic safe approved MCP targets, D1 encrypted credentials and small data/R2 Artifacts, Cloudflare Workflows durable progression, idempotent callback receipts and GitHub OIDC/Claim, safe retries and indeterminate outcomes, application capacity rejection, release compatibility and a minimal atomic MCP surface. Exact technical proposals and unverified risks remain separated in the consolidated spec. Exact protocols, failure guarantees and unconfirmed details remain open.

See [ADR-0001](docs/adr/0001-mcp-native-product-boundary.md), [ADR-0002](docs/adr/0002-runtime-managed-definitions.md), [ADR-0003](docs/adr/0003-dynamic-mcp-targets.md), [ADR-0004](docs/adr/0004-cloudflare-workflows-and-bounded-dag.md), [ADR-0005](docs/adr/0005-runtime-publication-and-run-versioning.md), [ADR-0006](docs/adr/0006-dynamic-mcp-boundaries.md), [ADR-0007](docs/adr/0007-registered-github-heavy-executor.md), [ADR-0008](docs/adr/0008-publish-authorization-and-tool-drift.md), [ADR-0009](docs/adr/0009-encrypted-d1-target-credentials.md), [ADR-0010](docs/adr/0010-trigger-admission-and-safe-retries.md), [ADR-0011](docs/adr/0011-github-runner-claim-and-least-privilege.md), [ADR-0012](docs/adr/0012-pause-and-cancellation-truth.md), [ADR-0013](docs/adr/0013-small-results-in-d1-large-artifacts-in-r2.md), [ADR-0014](docs/adr/0014-active-run-deployment-compatibility.md), [ADR-0015](docs/adr/0015-bounded-dag-expression-contract.md), [ADR-0016](docs/adr/0016-asynchronous-run-and-indeterminate-outcome.md), [ADR-0017](docs/adr/0017-published-execution-plan-and-schema-drift.md), [ADR-0018](docs/adr/0018-durable-external-callback-facts.md), [Grill With Docs decisions](docs/design/grill-with-docs.md), and [consolidated technical spec draft](docs/design/technical-spec-draft.md).
