# Isolated Cloudflare P0-1/P0-2 feasibility evidence — 2026-10-20

**Result: CLOUD FEASIBILITY PASS (6/6 scenario groups); full production P0 acceptance remains OPEN.**

## Isolation and resources

Used an isolated, freshly created Cloudflare D1 database (`wf-p0-isolated-20261020-v1`), Workflow plus test Worker (`wf-p0-main-20261020-v1`), and a second Worker (`wf-p0-effect-20261020-v1`) as a mock side-effect service. The mock was deployed **without any public route** and called through a Cloudflare Service Binding. Test Worker HTTP requests required a newly generated temporary test secret. None of the existing 12 Workers, existing databases, existing Workflow, MCP integrations, production secrets, or GitHub Actions were modified.

Executed via the authorized WSL2 Ubuntu device using Wrangler 4.151.1 and live Cloudflare Workflows/D1, **not local Miniflare**. The mock performs a real isolated D1 insert before intentionally responding HTTP 503. Test retry policy was limited to 1 retry (2 total attempts) to obtain rapid evidence; this does not measure the full default retry budget.

## Cloud test results

| Check | Observable result | Verdict |
| --- | --- | --- |
| Unauthorized external request | HTTP 404 | PASS |
| Normal Workflow creation and completion | 1 Step, status `complete` | PASS |
| No guard, remote side effect then HTTP 503 | **2 attempts, 2 D1 side-effect inserts**, Workflow `errored` | PASS — duplicate-side-effect vulnerability reproduced |
| D1 guard before effect, same induced 503 | **2 attempts, 1 side-effect insert**, app outcome `indeterminate`, native Workflow `complete` | PASS — second side-effect prevented |
| Creation succeeded but D1 finalize intentionally withheld | response `start_unknown`, D1 `reserved`; Workflow instance looked up by deterministic ID and reconciled to `started`; 1 execution | PASS — simulated lost acknowledgement |
| 8 concurrent admissions with the same Run ID | 8 returned `started` (7 marked duplicates), **1 actual Step execution** | PASS |

The Cloudflare account's management API independently confirmed remote D1 facts: guarded test `guard-3626c2` had 2 trial rows, **1** effect row and `indeterminate`; unguarded test `unsafe-e764cb` had 2 trial rows and **2** effect rows. The API also confirmed the guarded Workflow instance as `complete` and unguarded instance as `errored`, while the Run with concurrent admissions had a single Step.

## Interpretation and boundaries

1. A D1 conditional insert can act as a durable **logical dispatch guard** for potentially effectful calls and prevent a repeated send after a failed response; it is not a guarantee that arbitrary target operations complete exactly once.
2. Native Cloudflare Workflow `complete` does **not** imply business success. A guarded remote write may have an app-level **indeterminate** outcome; final API aggregation must preserve that distinction.
3. Deterministic instance IDs, D1 admission records and same-ID instance lookup allow resolution of the **simulated** create-acknowledgement ambiguity. Eight concurrent identical requests resulted in only one Workflow execution in this trial; this is not a formal proof of all possible distributed races.
4. The mock's HTTP 503 follows successful D1 side-effect commit. The test did **not** forcibly drop a TCP connection, crash a cloud isolate mid-request or simulate all timing windows around `create()`.
5. These results support H1/H2 in [the technical specification](technical-spec-draft.md) but **do not close AC-23–AC-26 or production P0 gates** until real connection loss, restart/interruption, retention and cross-deploy scenarios are tested.
6. No dynamic MCP protocol/SSRF, Cron, GitHub OIDC/Claim or credential-rotation verification was performed in this test.

## Evidence and lifecycle

Cloud test run occurred 2026-10-20 at approximately 09:09 UTC. Test runner results were stored in the authorized WSL temporary directory `/tmp/workflow-p0-cloud-20261020/cloud-results.json` without exposing the temporary secret. This PR records the verified aggregate evidence; no PoC production code was committed.

**Cleanup completed and independently verified:** deleted the isolated main Worker, isolated Workflow, isolated mock Worker and temporary D1. Cloudflare account listing returned to **12 Workers, 4 D1 databases, 1 Workflow**, matching the read-only preflight totals; no resources matching the test names remain. A new temporary test secret was used only on the isolated Worker and disappeared with that Worker. No existing production resources were modified. The authorization credential used to deploy was the WSL user's pre-existing Wrangler session and was not copied into PR artifacts. All Q1–Q50 architecture decisions remain unchanged.