# ADR-0014 — Require real-client acceptance before exposing Remote Control writes and Shell

Status: **Accepted real-client requirement and existing-environment test topology; authorization pending**. Date: 2026-10-13.
Decision input: cross-Worker grilling Q9=A and Q12=B. Related: [cross-Worker approval ADR](../../tool-authorization/adr/0001-delegate-tool-approval-to-client.md), [ADR-0011](./0011-direct-linux-user-no-path-allowlist.md), [ADR-0012](./0012-reuse-portal-bearer-auth-with-independent-secret.md), and [T10 release evidence](../T10-RELEASE-ACCEPTANCE.md).

## Context

Remote Control is a single-user VPC-only MCP relay that uses an independently authenticated MCP ingress and device credential. Its Agent operates under the existing Linux account without a container or project-root sandbox. Current Worker tool discovery and invocation are additionally gated by `REMOTE_CONTROL_ENABLE_FILE_WRITES` and `REMOTE_CONTROL_ENABLE_SHELL`. Removing these Worker-side tool permission gates is a product-level direction, **not** an authorization to make the live device writable.

A static Bearer credential and MCP metadata cannot guarantee that ChatGPT or every other client will display a specific approval prompt. Real connection behavior, tool names, permissions and execution must therefore be tested before releasing the new tool surface.

## Decision (Q9=A)

1. **Actual client required:** Perform pre-release acceptance using the real ChatGPT client through the actual MCP Portal connection and Worker-to-private-Agent path. Offline unit tests or direct HTTP requests alone are insufficient.
2. **MCP and auth cases:** Verify authenticated initialize, tools/list and correct tool names/argument schemas; unauthorized / invalid credential requests fail closed; the device-side credential remains independent; tools that read versus mutate or invoke Shell expose truthful risk annotations.
3. **Safe test operations:** Use designated disposable fixture files and a harmless bounded development command to validate one read, write, status receipt, managed Shell start/output/stop when applicable, uncertain-result recovery and relevant failure behavior. Do not touch production data, secrets, privileged services or unrelated host processes in test operations.
4. **Actual authority:** Check the real Linux user identity and its effective access/privilege pathways, including sudo, Docker socket and WSL cross-mount/interop where applicable, before Shell exposure. Record the approved boundary and unresolved risks without logging tokens or private file contents. Existing T07/T09/T10 review obligations are not waived.
5. **Approval semantics:** Record observed ChatGPT approval behavior, including when it prompts or declines, but do **not** require or claim that ChatGPT necessarily supports a configurable 'always allow' option. Client-specific consent is not a service-side authorization guarantee.
6. **Release separation:** Implementation, test-environment creation, main merge, Cloudflare deployment, client registration changes and enabling production writes/Shell are independently controlled actions. Production stays as-is unless explicitly authorized. Keep a reviewed recovery route that never silently restores stale credentials or Cloudflare invocation logging.
7. **Do not treat tool-gate removal as removal of:** ingress authentication, device verification, OS permissions, local argument validation, managed-process ownership, operation IDs, receipts, or unknown-outcome non-replay.

## Consequences and trade-offs

- Positive: tests match the client's real tool discovery and approval path, reducing mismatch between offline success and real use.
- Positive: centralized user-facing approval avoids duplicated UI and Worker permission toggles after a separately authorized release.
- Cost: a real client test path and live identity audit are more effort than unit tests; the chosen test environment must be decided in Q12.
- Cost: without application feature gates, any correctly authenticated client can invoke the available operations within the Linux Agent account's authority. The client may execute without a visible user prompt depending on its implementation or settings.
- Blocking: a failing or unavailable real-client result prevents asserting release acceptance; it is not cured by claiming that a tool descriptor or a generic HTTP smoke test proves ChatGPT behavior.

## Q12=B — Existing-environment client acceptance topology

- Use the existing **ChatGPT MCP Portal → Cloudflare Worker → VPC Service → Linux Agent** route and established non-root Linux identity, rather than constructing a second Worker or long-lived isolated test setup.
- The actual Linux account may access personal files and credentials outside disposable fixtures. This decision is an explicit simplicity/risk trade-off; it does **not** expand OS privileges or waive the identity and T07/T09/T10 reviews.
- The validation plan must minimize state changes: safe fixture paths, bounded commands, no secrets or live-data writes, no unrelated process termination, clear observed client approval behavior (including possible lack of a prompt), reliable receipts and a prepared recovery path. Any remaining Shell stop race must be resolved before that operation is released.
- **This ADR is NOT a deployment or testing authorization.** Current production file-write and Shell gates remain unchanged. Future in-place tests needing a gate, Worker version, connected plugin or Agent configuration change must be separately and explicitly approved first; do not bypass the gates to perform tests.
- Once permitted, record only redacted, non-secret pass/fail evidence with the active version and verified environment state, then separately seek the production release decision.

## Pending next decision

**Q15:** concrete minimal test matrix, allowed fixtures and staged authorization/recovery process for in-place testing on the existing Linux host. Neither Shell nor file-write enabling or execution has been approved in this design round.
