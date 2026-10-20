# Isolated P0-1/P0-2 local feasibility evidence — 2026-10-20

**Status:** Local proof-of-concept tests passed; cloud and production acceptance remain pending. No production resources were changed.

Test setup: WSL2 Ubuntu 24.04, Node 22.21.0, Wrangler 4.151.1 in local mode with local D1 and Workflows, and a local simulated remote HTTP effect server. All test files were created in a temporary directory outside the GitHub repository.

| Case | Observed result |
| --- | --- |
| Baseline without dispatch guard | 2 step attempts produced 2 remote mock effects after the mock returned HTTP 503 following the effect |
| D1 dispatch guard | 2 step attempts produced 1 remote mock effect; application result is `indeterminate` |
| Simulated lost create acknowledgement | D1 reservation remained, `get(instance_id)` reconciled it to started, and only 1 Workflow executed |
| Conflicting idempotency input | Explicit `idempotency_conflict`, no second Run |
| Eight concurrent identical admissions | 1 Run and 1 Workflow execution; after fixing the test-only duplicate-ID lookup, all 8 callers received started |
| Local Wrangler restart | Stored D1 guard and completed Workflow instance remained queryable |

The tests deliberately used one retry (2 total attempts) to shorten execution; this does not alter the documented default of five retries. The remote-side uncertainty was simulated with an HTTP 503 after the effect, not an actual dropped TCP acknowledgement. The create-response ambiguity was simulated by withholding the D1 started update after a successful local create, not by causing actual cloud network loss.

One correctness gap found and corrected in the isolated test code: an internal Workflow status of complete does not mean the business operation succeeded; the application must separately expose an indeterminate remote outcome.

**Still required before cloud P0 closure:** actual isolated Cloudflare Worker/D1 verification, interruption and true response-loss injection, duplicate-ID lookup timing and retention cases, and fail-closed validation of unsafe retries. Other P0 risks (dynamic MCP SSRF, protocol compatibility, Cron, and GitHub OIDC Claim) were not tested here.

References: [unified proposed technical specification](technical-spec-draft.md), especially H1/H2 and AC-23 through AC-26. All Q1–Q50 decisions remain unchanged.