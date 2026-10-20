# P0-5 — isolated GitHub OIDC, atomic Attempt Claim and durable callback recovery

**Date:** 2026-10-20. **Evidence:** Real GitHub Actions executions + real Cloudflare Worker, Workflows and D1. **Partial P0-5 feasibility PASS**; not full production executor acceptance.

## Scope and isolation

- Created a **temporary private GitHub repository** `lirtual/wf-p05-oidc-20261020-5bcc50`. This was separate from `lirtual/mcp-workers` and all business/production repositories.
- Created a dedicated D1 database `wf-p05-claim-20261020`, Worker `wf-p05-claim-20261020` and, for recovery testing, Cloudflare Workflow `wf-p05-notifier-20261020`.
- Used GitHub's actual `workflow_dispatch` and GitHub-hosted `ubuntu-latest` jobs with `id-token: write` permissions and OIDC JWTs. No shared GitHub Actions management MCP multi-PAT tokens were used as executor capability credentials.
- The test Worker used `jose` remote JWKS from `https://token.actions.githubusercontent.com/.well-known/jwks` and `jwtVerify` with expected issuer and audience, then verified repository `lirtual/wf-p05-oidc-20261020-5bcc50`, `ref=refs/heads/main`, `event_name=workflow_dispatch`, precise `job_workflow_ref` and numeric GitHub `run_id`. Actual JWT strings were neither logged nor committed.
- Both executions competed for **the same logical Attempt** `attempt-p05-20261020`. D1 used atomic `INSERT OR IGNORE` with `attempt_id` as its primary key; only the returned owner `run_id` was permitted to post callback completion.

## Observed real GitHub Actions outcomes

| Evidence | Actual observation | Result |
| --- | --- | --- |
| Unauthenticated or bogus Bearer | Worker returned HTTP **401** | PASS |
| Two valid GitHub OIDC tokens but **wrong audience** | Both Jobs observed HTTP **401** | PASS |
| Valid signature/issuer/audience plus required repo/ref/workflow claims | Both Jobs were verified and received HTTP **200** for Claim endpoint | PASS |
| Claim race: Run **39404533226** vs **39404528760** | Run `39404533226` received `claimed:true,new_claim:true`; Run `39404528760` received `claimed:false,new_claim:false` | PASS — one Claim owner |
| Losing Job tries to submit a completion callback | HTTP **403** | PASS — no non-owner callback |
| Winning Job sends duplicate callback IDs | Both callback HTTP requests returned 200; D1 had **one** `callback_receipts` row | PASS — idempotent receipt |
| Winning Job's mock business effect | D1 contained **one** `effects` row for the logical Attempt | PASS — test-only effect count |

Both GitHub Actions runs completed successfully. These are real GitHub-hosted physical jobs, not mocked OIDC strings. The Worker verified GitHub JWT cryptographic signatures using GitHub's published keys before any Attempt Claim operation.

## Receipt-first recovery across an actual Cloudflare Workflow

**Fault injected:** the winner persisted the callback receipt but deliberately did **not** send a Workflow notification. Cloudflare D1 originally showed one receipt with `delivered=0`, and no notification log rows.

A separate GitHub Actions run **39405031444**, itself carrying verified GitHub OIDC, invoked a test-only `/recover-oidc` endpoint. That endpoint retrieved the D1 receipt, created or found an isolated Workflow instance and called `sendEvent({type:'callback',...})`. The real Cloudflare Workflow consumed the event with `waitForEvent`, persisted the delivery record, and completed.

**Independently verified by Cloudflare management API:**

| Logical fact | Final remote state |
| --- | --- |
| Claim | Exactly one owner: Run `39404533226` |
| Simulated business effect | Exactly one row |
| Durable callback receipt | Exactly one row, `delivered=1` |
| Notification log | Exactly one row |
| Recovery Workflow instance | `complete`, output `{receiptId:'completed-39404533226',delivered:true}` |
| Recovery GitHub run | `39405031444` completed successfully |

This is concrete evidence for **Q26 atomic single-owner Claim** and **Q48 receipt persisted before notification + recoverable notification** in this test configuration. The actual implementation's reconciliation path should be **internal to Cloudflare** and not depend on starting another GitHub job just to wake the orchestrator. The recovery run here was an isolated test driver, not an approved new production control plane.

## Important limits / risks remaining open

- The D1 `effects` insert models a business operation; it does **not** prove exactly-once execution of arbitrary remote Browser, CLI or external MCP side effects. Actual executor starts, interruptions, fencing, cancellation, long-running job retries and dispatched-unknown states remain to be tested.
- A single Attempt Claim owner does **not** mean another job with the same logical Run ID or stale/misbound token can never run; production must define exact OIDC repository/ref/workflow trust policy, token freshness, job identity and privilege/capability registry.
- `callback_receipts` and test `effects` were written into the same D1 test database using a batch. This tests an isolated database effect, **not** atomicity with an unrelated external service.
- The test-only recovery endpoint accepted OIDC from another authorized run in the same test repo to drive the experiment; production recovery authorization must be narrower and independent of GitHub job ownership.
- No actual packet loss, Cloudflare region split, workflow-state migration, expired-instance reconciliation or forced Job cancellation was injected during this P0-5 round.
- A test result marked `Workflow complete` does not establish rollback or idempotence for external business operations.

**Overall:** P0-5 core OIDC+Claim+receipt-first recovery path = **real cloud feasibility PASS**; **full production P0-5 acceptance is OPEN** until real external side effects, cancellation, duplicate dispatch and cross-deployment recovery are proven.

## Traceability and cleanup

Related decisions: Q18, Q25–Q27, Q33, Q44, Q48, Q50; ADR-0011, ADR-0012, ADR-0018; [unified spec](technical-spec-draft.md), AC-15/16/17.

The temporary private repo and cloud resources must be deleted after evidence capture. Status will be updated in this report when deletion is independently verified. Never include OIDC raw JWT, GitHub OAuth PAT or any test secret in the PR.
