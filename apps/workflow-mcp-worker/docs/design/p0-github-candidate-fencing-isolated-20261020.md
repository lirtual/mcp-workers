# P0-5 isolation follow-up — GitHub OIDC candidate binding and same-Run re-execution

**Date:** 2026-10-20. **Evidence class:** two real GitHub Actions `workflow_dispatch` runs plus a real GitHub rerun, GitHub-issued OIDC JWTs, a fresh Cloudflare Worker and isolated D1. Test-only; no production code, credential, main branch, or production data modified.

## Why this check was necessary

[ADR-0011](../adr/0011-github-runner-claim-and-least-privilege.md) and [the unified spec](technical-spec-draft.md) clarify that a valid GitHub OIDC token proves **identity**, not permission to claim any logical Attempt. The earlier P0-5 two-Run race proved only one atomic Claim owner; it did not rule out an unrelated signed Run from the same repository, nor retries of a previously accepted GitHub workflow Run with a different `run_attempt`.

## Isolation

- A new **private** GitHub repository `lirtual/wf-p05-fencing-20261020-1efa98` contained one test `claim.yml` on its `main` branch. GitHub-hosted `ubuntu-latest` jobs requested signed OIDC tokens with only `id-token: write` and `contents: read`.
- New Cloudflare D1 `wf-p05-fencing-20261020` and test Worker of the same name. Worker verified GitHub JWKS signature, issuer `https://token.actions.githubusercontent.com`, expected audience, exact repository, `workflow_ref`, `ref`, event name and numeric `run_id`, `run_attempt`, `check_run_id`.
- A **single** D1 `attempts` row for `p05-fence-20261020`, with the explicitly authorized physical candidate `run_id=39408539052`, `run_attempt=1`; D1 `UPDATE ... WHERE owner_run_id IS NULL AND authorized_run_id=? AND authorized_run_attempt=?` served as the Claim gate. Separate `audit` and `effects` tables were **temporary test evidence only** and do not authorize new product entities.
- **Important harness caveat:** the test GitHub jobs paused before asking for OIDC so that the coordinator could observe the primary run ID and register the known candidate. This test does **not** solve production dispatch acknowledgement ambiguity or authorize a `sleep`-based synchronization mechanism.

## Verified test results

| Physical execution | Verified GitHub identity | D1 candidate authorization | HTTP / outcome | Effect |
| --- | --- | --- | --- | --- |
| Run `39408539052`, `run_attempt=1` | Valid OIDC | Match to authorized candidate | Claim accepted; D1 owner recorded | **1** isolated D1 mock effect |
| Run `39408589882`, `run_attempt=1` | Valid OIDC, same repo and same workflow | **Not** authorized to claim this Attempt | HTTP **403**, `not_authorized_candidate` | **0** |
| Rerun of **same** Run `39408539052`, `run_attempt=2` | Valid OIDC, same GitHub Run ID | Run ID matches, **attempt number does not** | HTTP **403**, `not_authorized_candidate` | **0** |

The two distinct GitHub runs and the rerun all reached the intended assertions. GitHub's REST API explicitly reported `run_attempt=2` after the rerun, and its job log showed HTTP 403 and `run_attempt:"2"`. The Cloudflare management D1 API independently reported exactly **one** Claim owner, **one** effect row and an audit sequence of `claimed`, `not_authorized_candidate`, `not_authorized_candidate`.

**Conclusion:** the minimal authorized physical candidate tuple `(workflow identity, repository/ref, GitHub run_id, run_attempt)` plus D1 conditional Claim prevented both tested impersonation modes. `check_run_id` provides further physical Job correlation, but there is no need to add a separate authentication service, per-Attempt token issuer, new lock daemon or candidate registry just for these measured cases.

## Boundaries / remaining unproven

1. Registration of allowed physical candidates was performed *after* observing the actual test Run ID, before the job Claim call. Real `workflow_dispatch` can return ambiguous/late run identity; reconciliation and admission of the intended candidate must be designed and tested **without preauthorizing every signed Job in the trusted repo**. The solution must remain fail-closed when linkage is unknown.
2. Only a small D1 insert modeled a business effect; arbitrary external side effects, force-cancel, job-level retry inside one Run attempt, multiple authorized candidate dispatches, check-run reuse, delayed callback and GitHub REST consistency were **not** tested.
3. The harness's rejection on `run_attempt=2` is an intentional **strict fencing policy**. Production retries can only start work if explicitly approved as **new admissible physical candidates** under the existing Attempt rules without risking a still-running owner. A timeout alone never grants the next candidate ownership.
4. This test used a newly created private repo and did not pass a Portal or broad GitHub Actions MCP PAT to Runner. OIDC tokens remained inside GitHub Runner and were not persisted in the repo/PR.
5. GH CLI briefly reported a transient remote D1 initialization failure from Wrangler, but the schema was successfully initialized using the connected Cloudflare management API; Worker deploy and all actual Job tests succeeded. This is a tooling/network issue, not evidence against Claim correctness.

Relevant docs: [GitHub OIDC JWT claims](https://docs.github.com/en/actions/reference/security/oidc) (`run_id`, `run_attempt`, `check_run_id`, `workflow_ref`). Results are recorded **before teardown** because the temporary private repo's Actions pages will not remain accessible after deletion.

**Cleanup completed and independently verified:** the isolated test Worker and D1 returned deletion success; temporary private GitHub repository `lirtual/wf-p05-fencing-20261020-1efa98` was deleted and later lookup reported it absent. Cloudflare inventory returned to **12 Workers, 4 D1 and 1 Workflow**, with no P0-5 fencing resources. There were no OIDC token or persistent Runner-secret artifacts in the PR. Other P0 items (full SSRF, Cron native `scheduled()` → Workflow Run, dispatch ambiguity, external cancellation) remain OPEN at this evidence stage.
