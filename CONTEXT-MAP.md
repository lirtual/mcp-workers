# Context Map

This repository contains multiple independently owned MCP application contexts. Each app keeps ownership of its own upstream domain, credentials, tools, and runtime behavior.

## Bounded contexts

### Existing MCP application contexts

The existing MCP apps are independent bounded contexts. Their tool contracts and upstream semantics remain owned by each app and are not redefined by the workflow system.

### Workflow Automation

The Workflow Automation context coordinates repeatable automation without absorbing the domain model of the systems it invokes.

It owns:

- workflow definitions and their lifecycle;
- trigger definitions and trigger events;
- workflow runs and step runs;
- execution requests and execution results;
- deduplication identity for trigger events;
- workflow-level inputs, outputs, artifacts, cancellation, and failure state.

It does not own:

- the business entities exposed by existing MCP apps;
- the credentials or internal persistence models of those apps;
- the external services invoked by a workflow.

## Context relationships

- Existing MCP application contexts may be invoked as capabilities by Workflow Automation, but remain autonomous.
- Workflow Automation may delegate execution to one or more execution backends without changing workflow meaning.
- External event sources may feed Workflow Automation through triggers without becoming part of the workflow domain itself.

## Compatibility rule

Adding Workflow Automation must not require existing MCP apps to adopt a shared runtime, shared database, shared credential model, or shared release lifecycle.
