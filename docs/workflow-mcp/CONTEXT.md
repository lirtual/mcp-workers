# Workflow Automation Domain Context

This glossary defines the canonical language for the Workflow Automation bounded context. It intentionally avoids implementation-specific technologies.

## Terms

### Workflow Definition
A reusable declarative description of an automation: how it starts, which steps it contains, how data flows between them, and what completion means.

### Trigger Definition
A reusable rule describing when a workflow should start and what event data it emits when activated.

### Trigger Event
A normalized occurrence produced by a Trigger Definition. A Trigger Event is immutable input to a Workflow Run.

### Event Key
A stable identity for a Trigger Event used to decide whether the same occurrence has already been accepted.

### Workflow Run
One concrete execution of a Workflow Definition, created from explicit input or a Trigger Event.

### Step
A named unit of work inside a Workflow Definition. A Step receives resolved input and produces a result that later steps may reference.

### Step Run
One concrete attempt to execute a Step within a Workflow Run.

### Executor
A replaceable execution backend capable of performing a Step. Executor choice must not redefine the meaning of the Step.

### Execution Request
The normalized request sent from workflow orchestration to an Executor.

### Execution Result
The normalized terminal or intermediate result returned by an Executor for an Execution Request.

### Artifact
A named output too large, binary, or otherwise unsuitable to carry inline through ordinary workflow values.

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
An operation a workflow may invoke. A Capability may be implemented by an internal step, an external service, or another MCP server without changing the workflow-level contract.

## Invariants

- Trigger, Workflow, and Executor are distinct concepts and must not be conflated.
- Trigger Events are normalized before workflow logic consumes them.
- Workflow meaning must not depend on which Executor performs a Step.
- Existing MCP application domains remain external capabilities; Workflow Automation does not absorb their business models.
- A Workflow Run has a durable identity independent of any individual Step Run or Executor invocation.
