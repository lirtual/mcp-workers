# Cloudflare P0 failure-window extension — isolated evidence

**Date:** 2026-10-20. **Scope:** brand-new throwaway Cloudflare Workers + Workflow + D1. This is a feasibility experiment, not authorization to implement or merge Workflow MCP.

## Setup

- WSL2 and Wrangler 4.151.1 deployed a test Worker named `wf-p0-window-main-20261020`, a private mock-effect Worker reachable only through a Service Binding, and a D1 database named `wf-p0-window-20261020`.
- Additional isolated read-only public Worker `wf-p0-window-readonly-20261020` was used only for a safe outbound HTTPS connectivity probe.
- Main testing endpoint was protected by a fresh temporary secret. No existing Worker, existing Workflow, existing D1, production credential or Github Actions resource was altered.
- Test source and raw aggregated results were retained temporarily in WSL `/tmp/workflow-p0-window-20261020` and **not committed** into the product source tree.

## P0-1: actual broken response stream after remote commit

A separate Cloudflare mock-effect Worker committed a D1 insert and then returned a response stream that failed with `injected_response_stream_abort`. The Workflow-side caller consumed the body and observed a real stream failure, not merely an HTTP 503 status.

| Mode | Cloudflare Workflow attempts | Independent D1 effect inserts | Cloudflare instance | Application outcome |
| --- | ---: | ---: | --- | --- |
| No dispatch guard (run `unguarded-202bc1`) | 2 | **2** | errored | not confirmed |
| D1 pre-dispatch guard (run `guarded-5d71f0`) | 2 | **1** | complete | **indeterminate** |

The Cloudflare management API independently queried the live D1 rows and instance statuses, confirming all counts and outcomes. This provides stronger real-cloud evidence for a broken HTTP *response body stream* after remote effect commit. It does **not** prove universal exactly-once, cloud isolate kill between guard and effect, or a raw TCP connection reset during request dispatch.

## P0-2: waiting Workflow across a real deployment

A Workflow instance `waiting-a135d7` executed its `before-event` durable step under application code **v1**, then waited for `resume`. While it was waiting, the isolated test Worker was deployed with a real **v2** code change (the version marker changed from `v1` to `v2`). The `resume` event was subsequently delivered.

- Cloudflare instance completed successfully.
- The persisted D1 `before` and `after` markers were both **v1**.
- The Cloudflare management API independently confirmed output: `{before: "v1", after: "v1", code_version: "v1"}`.

**Conclusion:** for this tested waiting instance, Cloudflare continued the original v1 Workflow code after v2 deployment and did not unexpectedly execute the v2 implementation. This is useful evidence of instance version affinity; it is **not** evidence that arbitrary incompatible protocol/definition changes, schema migrations or expired instances are safe. The prior simulated `create()` acknowledgement-loss/8-concurrent-admission tests were not repeated.

## P0-3: basic public Worker-to-Worker outbound HTTPS

With the `global_fetch_strictly_public` compatibility flag, a freshly deployed test Worker made a dynamic outbound HTTPS `fetch()` to a different public `workers.dev` test Worker, receiving **HTTP 200** and an expected read-only JSON body. This proves one safe public Worker-to-Worker connectivity path, *not* complete MCP protocol interoperability.

**Not passed / not attempted:** full SSRF adversarial cases (private network, metadata, redirects and DNS rebinding), real MCP 2025/2026 client-server protocol negotiation, credential isolation, redirect/header leakage. A proposed adversarial test command was blocked by the execution tool's security check, so the security proof remains **OPEN**. This result must not be used to claim arbitrary dynamic MCP URLs are safe.

## Acceptance interpretation

- P0-1 response-body interruption **partial cloud PASS**: effect guarded, one observed external write, truthful indeterminate.
- P0-2 live deployment with waiting instance **partial cloud PASS**: v1 affinity and resumed completion demonstrated.
- P0-3 public Worker HTTPS connectivity **narrow PASS**: public read-only route reachable with strict-public flag.
- **P0 still OPEN:** real request interruption before/after create, isolate termination, active schema incompatibilities, long retention/restart, comprehensive SSRF, production MCP SDK protocol negotiation, GitHub OIDC/Claim, dynamic Cron.

These are experimental observations, not a change to owner-approved architecture Q1–Q50. Source file names, numeric limits and API contract details remain design proposals, not implicit implementation approval.

**Cleanup requirement:** after capturing evidence, remove the new isolated Workers, Workflow, D1 and test secret; independently verify the account returns to its preflight inventory of 12 Workers, 4 D1 and 1 Workflow.
