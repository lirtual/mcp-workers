# Workflow Automation Domain Context

This glossary defines the canonical language for the Workflow Automation bounded context. It intentionally avoids implementation-specific technologies.

## Terms

### Workflow Definition
A reusable declarative description of an automation: how it starts, which steps it contains, how data flows between them, and what completion means.

### Workflow Definition Version
An immutable revision of a Workflow Definition identified by the canonical content of that definition rather than by the storage system that happened to contain it. Every Workflow Run is associated with exactly one definition version so later edits cannot change the meaning of an existing run.

### Definition Provenance
Metadata describing where a Workflow Definition Version came from, such as an authoring source or revision reference. Provenance explains origin but is not the identity of the definition version.

### Trigger Definition
A reusable rule describing when a workflow should start and what event data it emits when activated.

### Trigger Event
A normalized occurrence produced by a Trigger Definition. A Trigger Event is immutable input to a Workflow Run.

### Event Key
A stable identity for a Trigger Event used to decide whether the same occurrence has already been accepted.

### Manual Start
An explicit request by a caller to create a Workflow Run with supplied Workflow Input.

### External Event Start
A Workflow Run start caused by an authenticated event arriving from outside the workflow system.

### Scheduled Start
A Workflow Run start caused by a declared schedule.

### Workflow Run
One concrete execution of a Workflow Definition, created from explicit input or a Trigger Event.

### Step
A named unit of work inside a Workflow Definition. A Step receives resolved input and produces a result that later steps may reference.

### Step Dependency
A declared prerequisite relationship between two Steps. A dependent Step cannot become runnable until the prerequisite conditions of its dependencies are satisfied.

### Step Condition
A boolean rule that decides whether an otherwise runnable Step should execute or be skipped.

### Step Run
The logical execution of one Step within one Workflow Run. A Step Run preserves its identity across retries.

### Step Attempt
One physical attempt to perform a Step Run. A retried Step Run contains multiple Step Attempts but still represents one logical operation.

### Operation ID
A stable identifier for a logical side effect. Retries of the same logical operation reuse the same Operation ID so an idempotent target can recognize duplicates.

### Executor
A replaceable execution backend capable of performing a Step. Executor choice must not redefine the meaning of the Step.

### Execution Request
The normalized request sent from workflow orchestration to an Executor.

### Execution Result
The normalized terminal or intermediate result returned by an Executor for an Execution Request.

### Artifact
A named output too large, binary, or otherwise unsuitable to carry inline through ordinary workflow values.

### Artifact Reference
A stable workflow-level reference to an Artifact. It is independent of any executor-native temporary storage location.

### Workflow Input
Values supplied when a Workflow Run starts.

### Workflow Output
Values explicitly exposed by a completed Workflow Run.

### Step Output
Values produced by a Step Run and addressable by later workflow logic.

### Run State
The lifecycle state of a Workflow Run, including queued, running, waiting, succeeded, failed, cancelled, and timed out states.

### Deduplication
The rule that prevents the same Trigger Event from starting duplicate Workflow Runs when the workflow is configured for at-most-once event acceptance.

### Capability
An operation a workflow may invoke. A Capability describes what work is requested independently of which Executor performs it.

### Capability Adapter
A boundary that exposes an external protocol or service as one or more workflow Capabilities without turning that external protocol into an Executor.

### Connection
A named, administratively approved relationship to an external service or capability provider.

### Connection Reference
A symbolic reference to a Connection. Workflow Definitions select approved Connections by reference rather than supplying arbitrary destinations or credentials inline.

### Privileged Code Capability
An explicit Capability for executing user-supplied code in an execution environment. It is distinct from ordinary declarative workflow steps and carries a stronger trust boundary.

### Secret Reference
A symbolic reference to a secret value. Workflow definitions may contain Secret References but must not contain the corresponding secret values.

### Credential Lease
A short-lived, narrowly scoped authorization granted to an Executor for one execution purpose. A Credential Lease is not the underlying long-lived business credential.

## Invariants

- Trigger, Workflow, Capability, and Executor are distinct concepts and must not be conflated.
- Trigger Events are normalized before workflow logic consumes them.
- Workflow meaning must not depend on which Executor performs a Step.
- Existing MCP application domains remain external capabilities; Workflow Automation does not absorb their business models.
- A Workflow Run has a durable identity independent of any individual Step Run, Step Attempt, or Executor invocation.
- A Workflow Run is bound to one immutable Workflow Definition Version.
- Definition Provenance does not define version identity.
- A Step Run preserves one logical identity across all of its Step Attempts.
- Retries of one logical side effect reuse the same Operation ID.
- Failure of one DAG branch does not erase the outcome of independent branches.
- Artifact identity is independent of executor-native temporary storage.
- Workflow definitions contain Secret References and Connection References, never secret values.
- Arbitrary user-supplied code is a privileged capability rather than the default Step model.
- External protocol adapters, including MCP adapters, expose Capabilities and do not become Executors merely because they perform remote calls.
