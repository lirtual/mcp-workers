# Workflow MCP Worker — S1 only

Implementation branch for [Issue #141](https://github.com/lirtual/mcp-workers/issues/141).
This is an **isolated S1 implementation** of Draft → Validate → Publish → Run → Result,
not a deployment or acceptance of S2/S3. It must not be deployed to production
without provisioning and reviewing the actual D1 database, binding and Portal secret.

## Boundaries

- Reuses the existing Portal bearer authentication on `/mcp`.
- YAML or JSON Drafts; optimistic revision CAS; atomic explicit Publish of immutable Plans.
- Finite DAG (32 nodes, at most 8 ready independent Steps), restricted references and conditions.
- Manual asynchronous Run ID; D1 and Cloudflare Workflows state and result.
- **Only** `s1.readonly_mcp` / `echo` through a fixed private Service Binding
  and `result.emit`. No dynamic Internet URL, external write, Shell, code evaluation,
  webhook, Cron, OAuth, stored target credential or GitHub heavy execution.
- D1 Run admission idempotency, fixed instance IDs and bounded lookup after ambiguous create.
  S1 does not add an overflow queue, a second DAG engine or an external lock service.
- Runtime execution must not be labeled production-proven based on unit tests or local Wrangler alone.

## Setup for local smoke tests only

Use Node 24, `corepack pnpm install`, then
`corepack pnpm --filter workflow-mcp-worker run check` and
`corepack pnpm --filter workflow-mcp-worker run deploy:dry-run`.

The Wrangler configuration deliberately contains an invalid placeholder D1 ID,
`workers_dev: false` and no production credentials. Never deploy that configuration as-is.

For local tests:
1. From the app directory, `wrangler d1 migrations apply workflow-mcp-worker --local`
   (use matching `--persist-to` for the dev server).
2. Start the read-only fixture with `wrangler dev --local --config tests/fixtures/wrangler.jsonc --port 8790`.
3. Start the S1 Worker with `wrangler dev --local --port 8787 --var MCP_ACCESS_TOKEN:<local-test-only-token>`.
4. Call `/mcp` with a matching local Bearer token; use `tools/list`, `workflow_create`,
   `workflow_validate`, `workflow_publish`, `workflow_run`, `workflow_status`
   and `workflow_result`. Never use real secrets or production D1.

Only two fixed app bindings are necessary: `DB` and `WORKFLOW`, plus
`READONLY_TARGET` for the isolated test seam. Actual deployment and live edge
validation need separate authorization.

## Evidence and remaining work

Local Wrangler E2E (2026-10-20), including the **current MCP SDK adapter**, passed
36 assertions at the Portal-authenticated MCP seam: Draft editing and invalid-Draft
preview, YAML readback, compile/Publish, concurrent identical Publish idempotency,
revision conflicts, pinned Run after republish, pause/replay, two successful read-only
MCP Steps and result retrieval, failed-dependency skipping and non-boolean runtime
conditions failing safely. The local-only `tests/local-e2e.mjs` needs both local
Wrangler processes and `S1_LOCAL_TOKEN` set to the same disposable auth token.

`tests/local-reserved-recovery.mjs` uses **isolated local D1 fault injection** (never
production D1) and passed: D1 reserved Run without a Workflow instance, same-ID
recovery, lost-ack reconciliation and explicit 8-slot capacity rejection.
A new aged-unknown fault case (11 minutes old) first fails on `run_capacity_exceeded`,
then passes after the fix: ingress admission reconciles the old instance ID,
marks an unconfirmed start `indeterminate` with `start_unconfirmed`, keeps the
original Run/idempotency key, releases its app capacity, and permits a fresh Run.
The same key never automatically creates a replacement instance; expired unknown
Runs cannot be silently rewritten to `succeeded` by a late Runner. Cleanup
removes injected capacity rows. Both programs are manual local integration suites,
not automatically invoked by ordinary unit tests.

**Isolated real Cloudflare edge evidence (2026-10-20):** a temporary, separately named
D1, S1 Worker, Workflows binding and private read-only fixture passed the same **32**
owner-facing MCP assertions through the current SDK. A remote-D1 fault injection
also passed: same-ID recovery of a reserved Run, lost-start-ack reconciliation,
and capacity-full admission rejection. A 15-second read-only fixture Step was
started and the isolated Worker redeployed while the Run was active; both Steps
subsequently succeeded with its original Published Version and expected output.
These are actual edge tests, not the local Wrangler simulator. The tests did not
exercise real network partitioning or all cross-engine incompatible migrations.

**Follow-up isolated Cloudflare edge evidence (2026-10-20, commit 4fa3849 and
isolated status-projection fix):** 36/36 public MCP end-to-end assertions passed.
Remote D1 fault injection also passed for an 11-minute-old `start_unknown` Run,
restored admission capacity, retained original idempotency identity, and
concurrent same-key new Run creation / old-Run status queries (no duplicate Run).
The edge test exposed a real Cloudflare/D1 visibility race: the Workflow native
status could be `complete` before the business outcome write became visible in D1.
Previously `workflow_status` prematurely returned `indeterminate`, even though
the Step's durable final state soon became `failed`. A failing contract test and
edge retry confirmed the fix: native `complete` alone does not establish the
business outcome; queued/running stays nonterminal while D1 settles. This new
fix has been proven against actual Cloudflare edge, not just local Wrangler.

**Latest isolated edge verification (2026-10-20, next S1 change):**
The new `0002_native_complete_seen.sql` migration was applied to disposable D1.
The strict Workflow lookup adapter was tested against the real edge exception
`(instance.not_found) Instance not found`; generic timeout, unavailable, and
substring-only errors remain **unavailable**, not evidence of absence.
The first remote D1 reserved-start replay correctly stayed `reserved` due to a
local-only missing-error spelling mismatch. A disposable authenticated diagnostic
endpoint established the exact edge marker, was removed, and the isolated
worker was redeployed without the probe. Subsequent **36/36 full edge MCP
assertions** and remote fault injection passed: same-ID reserved recovery,
lost-ACK reconciliation, capacity pressure and aged unknown starts, plus native
Workflow complete with a simulated permanently missing D1 business outcome.
The last case returns terminal `indeterminate` / `outcome_unconfirmed` only
after 10 minutes from **first seeing native complete**, never merely from Run
creation. A bounded ingress pass handles already-observed stale active Runs
without adding an independent scheduler.

**Remaining risk:** the exact Cloudflare missing-instance exception is an
observed **vendor runtime signature**, not a formally documented stable type.
If it changes, recovery fails closed to `start_unknown`, preserves the logical
Run and application capacity; it will not blindly dispatch. Real network
partitions and incompatible-engine-version migrations have not been simulated.
Two independent code reviewers remain outstanding. The current tests include **16
S1 unit/contract tests** and the existing 36-assertion owner-facing local E2E checks.

**Final status semantics audit:** per Cloudflare's documented native states,
`errored` and `terminated` are terminal orchestration outcomes, but cannot prove
business-side effects were safely rolled back. If D1 still has a nonterminal
business outcome, record `indeterminate` with `orchestration_errored` or
`orchestration_terminated` and release S1 capacity, retaining the original Run
identity. Unit/contract tests cover this classification; live network partition,
absent post-retention instances and incompatible engine upgrades remain unproven.

The temporary Cloudflare D1, Workflow, test Worker and fixture Worker were all
deleted afterward. The public test token and untracked deployment configuration
were removed locally; no production deployment or secret was modified. The optional
`S1_EDGE_REMOTE=1` fault-test path requires a freshly provisioned **isolated** D1
and a throwaway `wrangler.s1-cloud.jsonc` that is intentionally not committed.

Focused test-first review additionally closed two expression-safety gaps: references
may only access own data fields (not inherited JavaScript prototype members),
reserved Step IDs are rejected, and `if`/logical conditions require actual boolean
values rather than JavaScript string truthiness. S1 now has 12 unit/contract tests. A later final review also rejects YAML non-finite numbers (`.nan`, `.inf`) before JSON canonicalization (avoiding silent `null` conversion), and normalizes Run input-object key order before computing the admission idempotency digest. Canonical Plan and Run hashes use locale-independent key comparison, avoiding runtime-locale-dependent hashes.

Still required before closing S1: final standards/spec code review, latest-commit
CI verification, remaining network interruption cases where warranted, and
explicit final merge/release authorization. S2/S3 are not implemented.

Q1–Q50 design remains in [Draft PR #135](https://github.com/lirtual/mcp-workers/pull/135);
new S2/S3 facilities are not to be provisioned here.
