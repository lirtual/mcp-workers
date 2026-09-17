# Workflow Automation Domain Context

This glossary defines the canonical language for the Workflow Automation bounded context. It intentionally avoids implementation-specific technologies.

## Terms

### Workflow Definition
A reusable declarative description of an automation: how it starts, which steps it contains, how data flows between them, and what completion means.

### Workflow Definition Version
An immutable revision of a Workflow Definition identified by the canonical content of that definition rather than by the storage system that happened to contain it. Every Workflow Run is associated with exactly one definition version so later edits cannot change the meaning of an existing run.

### Definition Provenance
Metadata describing where a Workflow Definition Version came from, such as an authoring source or revision reference. Provenance explains origin but is not the identity of the definition version.

### Workflow Registry
The set of Workflow Definitions currently available for discovery and new-run admission. Registry membership is distinct from historical Workflow Definition Versions already referenced by existing runs.

### Pinned Plan
The normalized definition snapshot and resolved execution contracts retained for one admitted Workflow Run. A Pinned Plan allows a nonterminal Run to resume without being reinterpreted from a later Workflow Registry version.

### Trigger Definition
A reusable rule describing when a workflow should start and what event data it emits when activated.

### Trigger Event
A normalized occurrence produced by a Trigger Definition. A Trigger Event is immutable input to a Workflow Run.

### Event Key
A stable identity for a Trigger Event used to decide whether the same occurrence has already been accepted.

### Run Admission
The decision that an eligible start request is allowed to create or resolve to one Workflow Run. Repeated delivery of the same event may resolve to an existing admitted run rather than create another run.

### Admission Key
A stable identity used to correlate equivalent start requests for run admission. It is distinct from execution idempotency for downstream side effects.

### Manual Start
An explicit request by a caller to create a Workflow Run with supplied Workflow Input.

### External Event Start
A Workflow Run start caused by an authenticated event arriving from outside the workflow system.

### Scheduled Start
A Workflow Run start caused by a declared schedule.

### Schedule Occurrence
One intended firing of a schedule at a particular logical scheduled time.

### Schedule Misfire
A Schedule Occurrence that became due while the scheduler was unable to admit it at its intended time.

### Workflow Run
One concrete execution of a Workflow Definition, created from explicit input or a Trigger Event.

### Runtime Provenance
Metadata identifying the implementation/build context that interpreted or executed a Workflow Run or Step Attempt. Runtime Provenance explains execution context but does not change Workflow Definition Version identity.

### Dependency Snapshot
A recorded description of the effective external contract used by a Step Attempt, including dependency identity and a stable contract/schema fingerprint when available. A Dependency Snapshot is runtime evidence, not part of Workflow Definition Version identity and not by itself proof that a dependency change is incompatible.

### Concurrency Policy
A rule controlling whether multiple Workflow Runs that belong to the same concurrency scope may execute simultaneously or must wait for capacity.

### Cancellation Request
A durable request to stop a Workflow Run. Cancellation prevents new work from starting and asks active work to stop, but it does not imply reversal of already completed side effects.

### Step
A named unit of work inside a Workflow Definition. A Step receives resolved input and produces a result that later steps may reference.

### Step Dependency
A declared prerequisite relationship between two Steps. A dependent Step cannot become runnable until the prerequisite conditions of its dependencies are satisfied.

### Step Condition
A boolean rule that decides whether an otherwise runnable Step should execute or be skipped.

### Step Run
The logical execution of one Step within one Workflow Run. A Step Run preserves its identity across retries.

### Step Attempt
One execution attempt for a Step Run. A retried Step Run contains multiple Step Attempts but still represents one logical operation.

### Attempt Claim
The server-side authorization that grants one physical Executor Job permission to perform one registered Step Attempt. Duplicate candidate Jobs may exist, but at most one may hold the Attempt Claim.

### Claim Deadline
A time at which an unresolved Attempt Claim must be reconciled. A Claim Deadline is an observation deadline, not a transferable lease: its expiry does not authorize another Job to take over the same Attempt.

### Operation ID
A stable identifier for a logical business side effect. Retries/new Attempts of the same logical operation reuse the same Operation ID so an idempotent target can recognize duplicates.

### Indeterminate Outcome
A result state in which a side effect may have completed but available evidence cannot establish success or failure safely. An Indeterminate Outcome is not automatically retryable.

### Executor
A replaceable execution backend capable of performing a Step. Executor choice must not redefine the meaning of the Step.

### Candidate Job
A physical executor job started for a Step Attempt. Dispatch uncertainty may create more than one Candidate Job for an Attempt; only the Job holding the Attempt Claim is authorized to perform business work.

### Execution Request
The normalized request sent from workflow orchestration to an Executor.

### Execution Manifest
The complete execution contract for one authorized Step Attempt, including resolved non-secret input, capability identity, scoped references, limits, and correlation identifiers required by the Executor.

### Execution Result
The normalized terminal or intermediate result returned by an Executor for an Execution Request.

### Callback Inbox
Durable storage for authenticated executor callback facts before orchestration is notified. Callback Inbox records can be retried/reconciled when notification fails and do not independently decide workflow progression.

### Artifact
A named output too large, binary, or otherwise unsuitable to carry inline through ordinary workflow values.

### Artifact Reference
A stable workflow-level reference to an Artifact. It is independent of any executor-native temporary storage location.

### Artifact Upload Allocation
A short-lived authorization and destination allocated for an Executor to upload one Artifact directly into canonical storage. It does not grant general storage credentials.

### Workflow Input
Values supplied when a Workflow Run starts.

### Workflow Output
Values explicitly exposed by a completed Workflow Run.

### Step Output
Values produced by a Step Run and addressable by later workflow logic.

### Run State
The lifecycle state of a Workflow Run, including queued, running, waiting, cancel-requested, succeeded, failed, cancelled, timed out, and other explicitly defined unresolved states.

### Event Timeline
The ordered structured history of domain-significant lifecycle events for a Workflow Run. It is authoritative for user-facing execution history and distinct from implementation debug output.

### Raw Execution Log
Verbose executor or adapter diagnostic output that may help investigate failures but does not define workflow state.

### Deduplication
The rule that prevents the same Trigger Event from starting duplicate Workflow Runs when the workflow is configured for at-most-once event acceptance.

### Capability
An operation a workflow may invoke. A Capability describes what work is requested independently of which Executor performs it.

### Capability Descriptor
The declared contract for a Capability, including its input and output shapes, side-effect and retry characteristics, and which Executors are allowed to perform it.

### Capability Adapter
A boundary that exposes an external protocol or service as one or more workflow Capabilities without turning that external protocol into an Executor.

### Connection
A named, administratively approved relationship to an external service or capability provider.

### Connection Reference
A symbolic reference to a Connection. Workflow Definitions select approved Connections by reference rather than supplying arbitrary destinations or credentials inline.

### Connection Credential
Sensitive authentication material owned by a Connection. Workflow Definitions never contain Connection Credential values.

### Platform Credential
A privileged credential required by the workflow platform itself to operate an infrastructure integration. Platform Credentials are distinct from workflow business secrets and are never delegated through ordinary workflow data.

### Privileged Code Capability
An explicit Capability for executing user-supplied code in an execution environment. It is distinct from ordinary declarative workflow steps and carries a stronger trust boundary. Generic user-supplied code execution is outside v0.1.

### Secret Reference
A symbolic reference to a secret value. Workflow definitions may contain Secret References but must not contain the corresponding secret values.

### Credential Lease
A short-lived, narrowly scoped authorization granted to an Executor for one registered execution purpose after executor identity and Attempt Claim are validated. A Credential Lease is not the underlying long-lived business credential.

### Trust Surface
A separately authenticated interface whose authority is intentionally limited to one class of actors and operations. Authority from one Trust Surface does not imply authority on another.

### Canonical Workflow Representation
A deterministic, normalized representation of a Workflow Definition used for validation, comparison, and version identity. Authoring syntax is not itself the canonical representation.

### Workflow Expression
A restricted declarative expression that reads workflow data and computes conditions or values without ambient access to code execution, network, files, or other undeclared capabilities.

## Invariants

- Trigger, Workflow, Capability, and Executor are distinct concepts and must not be conflated.
- Trigger Events are normalized before workflow logic consumes them.
- Repeated delivery of one event can resolve to one admitted Workflow Run without implying exactly-once downstream side effects.
- Run admission deduplication, Attempt Claim authorization, and business idempotency are separate reliability mechanisms.
- Workflow meaning must not depend on which Executor performs a Step.
- Capability-to-Executor routing is deterministic for one Pinned Plan.
- Existing MCP application domains remain external capabilities; Workflow Automation does not absorb their business models.
- A Workflow Run has a durable identity independent of any individual Step Run, Step Attempt, Candidate Job, or Executor invocation.
- A Workflow Run is bound to one immutable Workflow Definition Version and resumes from its Pinned Plan rather than a later registry definition.
- Definition Provenance, Runtime Provenance, and Dependency Snapshots do not define Workflow Definition Version identity.
- A Step Run preserves one logical identity across all of its Step Attempts.
- Retries of one logical business operation reuse the same Operation ID.
- Multiple Candidate Jobs may exist for one remote Attempt, but at most one may hold the Attempt Claim and perform business work.
- Claim Deadline expiry never transfers an Attempt Claim automatically.
- A valid executor identity token does not authorize arbitrary work; authorization must bind to a server-registered Attempt and expected executor identity.
- An Indeterminate Outcome is not automatically retryable.
- Failure of one DAG branch does not erase the outcome of independent branches.
- Cancellation does not imply compensation or rollback of completed side effects.
- Once cancellation is requested, no new Step starts; dependency-level `always()` does not override the run-level cancellation gate.
- Artifact identity is independent of executor-native temporary storage.
- Artifact Upload Allocations grant temporary object-scoped authority rather than durable storage credentials.
- Callback facts are durably recorded before orchestration notification and do not independently advance the DAG.
- Late, duplicate, terminal-run, cancelled-run, or superseded-Attempt callbacks cannot directly rewrite the current business outcome.
- Event Timeline entries define user-facing execution history; Raw Execution Logs do not define workflow state.
- Workflow definitions contain Secret References and Connection References, never secret or Connection Credential values.
- Platform Credentials are infrastructure authority and never become workflow inputs, outputs, or executor business credentials.
- Executors receive only credentials/references selected by server-side Capability and Connection configuration; they cannot request arbitrary secret names.
- Arbitrary user-supplied code is not the default Step model and generic user-code execution is deferred from v0.1.
- External protocol adapters, including MCP adapters, expose Capabilities and do not become Executors merely because they perform remote calls.
- Dependency fingerprint change alone does not prove incompatibility; the actual selected operation contract must be validated.
- Authoring format and Canonical Workflow Representation are distinct; version identity is derived from the canonical representation.
- Workflow Expressions are declarative and cannot escape into arbitrary code execution or undeclared I/O.
- Credentials and authority do not cross Trust Surfaces unless an explicit delegation protocol grants a narrower temporary authority.
