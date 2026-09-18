# ADR 0002: Separate Workflow Orchestration from Compute Execution

- Status: Accepted
- Date: 2026-09-17

## Context

The workflow system must support long-lived automation, retries, waiting for external events, and durable run state while also being able to perform tasks that require a full Linux environment, browser automation, CLI tools, or heavier compute. Treating a single execution environment as both workflow engine and universal worker would either constrain capability or make orchestration unnecessarily expensive and fragile.

Actionsflow demonstrated that Cloudflare ingress plus GitHub Actions execution is viable, but its generation and execution model makes GitHub Actions the workflow engine. Modern durable orchestration allows those responsibilities to be separated.

## Decision

Workflow orchestration and step execution are separate responsibilities.

The workflow system owns durable run state, step ordering, retries, waits, cancellation, and result coordination. Executors only perform normalized execution requests and return normalized execution results.

The initial architecture uses:

- Cloudflare Worker as MCP/API control plane;
- Cloudflare Workflows as durable orchestration engine;
- GitHub Actions as a remote compute executor for tasks requiring capabilities unsuitable for Worker execution;
- Worker-native or HTTP/MCP execution paths for lightweight steps where appropriate.

GitHub Actions is not the source of truth for workflow state and is not the workflow definition engine.

## Consequences

### Positive

- Long waits and orchestration do not occupy GitHub-hosted compute.
- Heavy tasks can use a full runner environment without forcing the whole workflow into that environment.
- Additional executors can be introduced behind the same execution contract.
- Workflow state remains coherent even when an external executor is delayed, retried, or unavailable.

### Negative

- The system needs a callback/event protocol between orchestration and remote executors.
- Cross-system cancellation is best-effort unless each executor supports it explicitly.
- Observability must correlate workflow runs, step runs, and remote execution identifiers.
- More than one runtime participates in a single workflow, increasing integration testing needs.

## Rejected alternatives

### GitHub Actions as the workflow engine

This copies the historical Actionsflow model but couples workflow semantics to GitHub workflow generation and consumes runner time for orchestration concerns.

### Cloudflare-only execution

This simplifies deployment but cannot reliably cover all desired CLI, browser, binary-processing, and heavier-compute tasks.
