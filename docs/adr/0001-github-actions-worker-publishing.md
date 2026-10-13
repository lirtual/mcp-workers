# ADR-0001: Manual GitHub Actions publishing for four MCP Workers

- **Status:** Proposed — design decisions settled; final maintainer sign-off pending. **Not implementation or production authorization.**
- **Date:** 2026-10-13
- **Repository:** `lirtual/mcp-workers`
- **Design branch:** `design/github-actions-worker-deploy-20261013`

## Context

Four independent MCP Workers already run in Cloudflare: `raindrop-mcp-worker`, `ima-mcp-worker`, `database-mcp-worker`, and `remote-control-mcp-worker`. The existing `.github/workflows/ci.yml` checks some affected apps on pull requests and `main` pushes, but does not publish Workers. Existing documentation describes Cloudflare Workers Builds as the publisher. The desired publisher is GitHub Actions, **without introducing a second deployment workflow or an automatic production trigger**.

Read-only production reconnaissance on 2026-10-13 found four deployed Workers and **no Workers Builds triggers** for them, but did not establish that no other manual/API publisher exists. Current deployment source metadata was `wrangler` for Database/IMA and `api` for Raindrop/Remote Control. Secrets could be inventoried by **name only**, not value. Production has a real `REMOTE_CONTROL_DEVICE` VPC binding; the checked-in Remote Control Wrangler config has an all-zero placeholder. It must never be deployed unchanged.

The maintainer made decisions in four grilling rounds. The later **Q12 manual-only decision supersedes Q2's earlier automatic-push proposal**. This ADR is the consolidated intended design, not an approval to change production.

## Decision

### 1. One existing CI workflow, explicit release only

- Extend **only** `.github/workflows/ci.yml` with `workflow_dispatch` and an allowlisted, **exactly-one-Worker** input. The allowed targets are precisely the four Workers above. No new `deploy.yml`, deploy service, state database, queue, or automatic publisher.
- `pull_request` and `push(main)` run **checks only**; neither may publish or access production Cloudflare credentials. Reuse existing changed-path selection for PR/main **checks**. Add Remote Control to the checks and ensure shared `packages/*`, lockfile/workspace/toolchain, and relevant protocol changes cannot skip affected checks. Docs-only changes do not publish anything.
- An explicit `workflow_dispatch` is the **sole GitHub Actions production publication trigger**. Validate selected Worker and require trusted `main` at both dispatch and deploy time. Dispatch from another branch, a detached/old SHA, or an unknown Worker must fail closed. The manual run checks its selected Worker even when the changed-path detector otherwise finds no change.
- Application checks must actually pass on the same checked-out commit that is to be deployed. Database additionally requires its existing PostgreSQL/MySQL integration tests to **succeed**, not `skipped`. Remote Control must gain a minimal application `check` contract using its existing typecheck and tests; do not bypass tests just because the package currently lacks a `check` command. A deliberately skipped Database integration job must not block other Workers or be mistaken for success on a Database deploy.
- Runtime publishing uses the Worker's existing pinned Wrangler toolchain/scripts, plus the smallest necessary Remote Control deployment-config handling. The deployment must not implicitly modify independent production Secret values.

**Actual release flow:** manually choose a Worker in GitHub Actions → validate `main`/input → install pinned workspace dependencies → selected app checks (and Database integration where applicable) → enter `production` Environment → preflight and Wrangler deployment → read-only post-deploy validation → record result.

### 2. GitHub Environment and credential isolation

- Use the GitHub **`production` Environment**. Put a distinct, least-privileged `CLOUDFLARE_API_TOKEN` in an **Environment Secret** and the account ID in an Environment Variable. Restrict access to the intended Cloudflare account/resources and trusted `main` branch.
- Check actual GitHub plan/repository support for Environment Secrets, variables, and deployment branch policy **before merging/enabling**. Do not silently weaken the architecture to ordinary Repository Secrets if unavailable.
- The automatic PR/main check jobs never enter `production`; use `permissions: contents: read` unless a particular step demonstrably needs more. Production credentials reach only the explicitly selected manual deploy job, after checks and guards pass.
- `MCP_ACCESS_TOKEN` is **runtime ingress authentication**, unrelated to `CLOUDFLARE_API_TOKEN` deployment authorization. No MCP ingress Token, upstream credential, Agent/device Token, Cloudflare API response containing secret material, or real request authorization header may be copied to GitHub secrets for smoke testing, exposed in logs, or committed to code.

### 3. Per-Worker serialization and safe source selection

- One deploy per Worker at a time; different Workers can deploy concurrently. Use a stable Worker-scoped concurrency group for manual release jobs with `cancel-in-progress: false`.
- Existing workflow-wide `cancel-in-progress: true` must **not** cancel running manual deployments when an unrelated PR/main push arrives. Preserve cancellation for check-only workloads separately if desired.
- GitHub concurrency pending runs are neither guaranteed FIFO nor guaranteed to preserve every queued request. Fail stale dispatches by verifying trusted `main` HEAD **again inside the acquired deploy job**, just before publication; do not automatically publish older commits. A later `main` push may require a fresh manual dispatch; no auto-reconciliation or automatic deployment exists. Record the exact source commit and deployed active version in non-secret evidence.
- Prevent a manual deploy of the same Worker from silently overriding a newer authorized deployment with an old SHA. Recovery from an older source follows the reviewed-commit procedure below instead of an arbitrary-SHA dispatch.

### 4. Runtime configuration preservation

- Keep the existing Worker names, endpoints, supported bindings and compatibility configuration. Respect `keep_vars: true` and preserve Cloudflare runtime Secrets without copying values to GitHub.
- Before deployment, compare non-secret required bindings/settings against the currently active Worker; do not accidentally drop Database `RATE_LIMITER`, IMA `R2_BUCKET`/`IMA_IMAGE_REFRESH_SHARD`, or other required bindings/vars. An intentional resource/config migration is **outside this ADR** and requires separate review.
- For Remote Control, keep the real `REMOTE_CONTROL_DEVICE` VPC Service ID in a `production` **Environment Variable** (Q5=B). It must be a non-placeholder and **equal the currently active Cloudflare binding ID and type**. Produce a temporary untracked Wrangler config for only the deployment; do not commit its live value or print the substituted config.
- Preserve Remote Control `observability.logs.invocation_logs=false`, the owner-approved **enabled** production gates `REMOTE_CONTROL_ENABLE_FILE_WRITES="true"` and `REMOTE_CONTROL_ENABLE_SHELL="true"`, and the existing runtime `REMOTE_CONTROL_DEVICE_TOKEN` unchanged. Confirm the **actual current production state** against both settings and the authoritative owner decision before and after deployment; fail closed on a mismatch rather than changing either switch. Enabled Shell/file writes retain their documented Linux-user and managed-session risk boundaries.
- This publisher change **does not itself enable, disable or re-authorize** Remote Control capabilities, mutate the Agent, rotate credentials, or waive any residual risks. T10 #12, v1 spec #2, and Shell/independent file-write approval #14 are **closed**; current owner authorization is recorded in #14. Each actual GitHub Actions **production deployment** still requires separate authorization and ordinary pre/post verification.

### 5. Deployment acceptance (Q10=A)

Automated checks run with **no shared MCP ingress Token in GitHub**:

| Layer | Minimum acceptance evidence | Failure result |
| --- | --- | --- |
| Before deploy | Chosen Worker/branch/SHA allowlisted; tests green; required existing resource/Secret **names** and Cloudflare configuration present; Remote Control VPC/logging/feature gates match | Do not deploy |
| After deploy | Cloudflare active deployment/version and intended Worker name; required non-secret bindings/security configuration remain correct | Mark manual run failed; stop that Worker's rollout |
| Public entry surface | Use the Worker's existing public health endpoint **where available**; otherwise do not invent a health endpoint; verify unauthenticated/invalid-token `/mcp` is denied without leaking private data (do not assume every denial must be HTTP 401 rather than an expected 403) | Mark failed; require operator review |
| First production cutover of each Worker | Human-led authenticated MCP initialize/tools-list and an explicitly safe read-only operation from the existing Portal/client; record outcome only, not token/response-sensitive material | Do not declare cutover accepted |
| Remote Control specifically | Above plus exact live VPC Service binding, `invocation_logs=false`, both owner-approved enabled gates (`true`), separate device credential presence, the accepted #14 Linux-user/Shell risk boundaries, and safe read-only marker verification when separately authorized | A mismatch fails this deployment; do not silently disable or broaden existing capabilities |

A Cloudflare script upload, green CI, or deploy API success by itself is **not** production acceptance. Do not perform a credentialed production test from CI, run write/Shell operations, re-read historically logged headers, or claim a missing T10 result passed.

### 6. Failed acceptance and safe recovery (Q13=A; Q9=A; Q11=A)

- A failed post-deployment verification makes the manual job **red** and records non-secret diagnostic/commit/version information. **Pause that Worker's further rollout** until the operator reviews the failure; do not block healthy unrelated Workers as a blanket rule. This is an operational hold, **not an extra persistent release-control database**.
- There is **no automatic redeployment, automatic source revert, or Cloudflare historical-version rollback** on failure.
- Restore a known-good source through a **reviewed revert/recovery commit on `main`**, rerun its applicable CI checks, then explicitly dispatch the affected Worker from the new `main` HEAD. Ensure today's correct Secrets, VPC binding, security switches and other resources survive. No arbitrary historical SHA input to normal manual deploy.
- Especially for Remote Control, historical Worker versions may contain old credentials/bindings or uncertain logging configuration. The existing T10 records explicitly prohibit treating a previous Cloudflare Version ID as a guaranteed safe rollback target.

### 7. Staged publisher cutover (Q8=A, now manual-only)

Use this order, **one separately authorized and accepted Worker at a time**:

1. Raindrop
2. IMA (R2 and Durable Object)
3. Database (Database integration and Rate Limiter)
4. Remote Control **last**, preserving the already owner-approved permissions in closed Issue #14 and requiring a separate authorization for the **manual deployment**

For each Worker: inventory active version/non-secret bindings → confirm no competing automatic publisher or active Builds trigger (disconnect if present, after authorization) → prepare GitHub `production` credential/environment access → manually dispatch only that Worker → perform automated and human cutover acceptance → record release evidence. There is **no stage enabling automatic publishing**. GitHub branch merges and PRs continue to run checks only, before and after the cutover.

### 8. One shared `MCP_ACCESS_TOKEN` target — separate operation (Q14=A)

The maintainer's desired **target** is one and the same `MCP_ACCESS_TOKEN` runtime Secret **value** across **all four** independent Workers and their authorized MCP clients, not merely a common Secret name. Each Worker has a separate Cloudflare Secret binding. The upstream secrets remain separate:

| Worker | Shared ingress Secret name | Independent production credentials |
| --- | --- | --- |
| Raindrop | `MCP_ACCESS_TOKEN` | `RAINDROP_ACCESS_TOKEN` |
| IMA | `MCP_ACCESS_TOKEN` | `API_KEY`, `CLIENT_ID` |
| Database | `MCP_ACCESS_TOKEN` | `DATABASE_CONFIG` |
| Remote Control | `MCP_ACCESS_TOKEN` | `REMOTE_CONTROL_DEVICE_TOKEN` |

**Q14=A (settled): first finish GitHub Actions manual-only publishing migration without changing any runtime Secret; then undertake a separate, explicitly authorized coordinated four-Worker token alignment/rotation.** Cloudflare Secret enumeration cannot prove values are currently the same. The existing runbook documents sharing across the first three Workers only, while Remote Control T10 documents its independent recent ingress-token rotation. No claim that all four production values already match is warranted.

Do **not** reuse a credential potentially present in prior Remote Control Invocation Logs as the common Token. The final shared value creates a larger compromise/blast radius; all four Workers and clients would require coordinated revocation/rotation following any compromise. Token alignment is non-atomic: plan controlled operator-side generation/storage, staged per-Worker updates, corresponding client updates, authorized and denied-access checks, failure recovery, and explicit Remote Control T10 owner/security acceptance. Do not implement secret-value synchronization in CI and do not write Secret values into the repository, ADR, chat or logs. This decision **does not authorize any rotation**.

## Final deep-review notes (2026-10-13)

The minimal architecture above is retained. The following **implementation clarifications and release-blocking checks** were found by comparing the actual CI, Wrangler files, Cloudflare's current non-secret production metadata, and GitHub Actions behavior. They are not new deployment subsystems or authorizations.

1. **Manual selection must not use push-diff fallback.** The current `checks` step uses `github.event.before`; `workflow_dispatch` does not supply the same push-diff semantics. Select the explicit allowlisted Worker for manual checks, so it cannot accidentally run/check all Workers. Extend PR/main affected-app checks to Remote Control without adding production auto-deploy.
2. **Separate workflow cancellation from production serialization.** The existing workflow-level `concurrency: ci-...main` and `cancel-in-progress: true` must not cancel a manual release or unnecessarily serialize independent Workers. Scope old cancellation to check-only runs; lock deployment at **job level** by selected Worker with `cancel-in-progress: false`. Multiple queued manual deployments need not be retained indefinitely; safe non-FIFO handling and head-SHA recheck must be demonstrated.
3. **Fail closed on skipped dependency jobs.** GitHub `needs` skips downstream jobs if any required job was skipped unless its explicit condition permits continuing. Database publish requires both application checks and an actual `success` from integration tests; a non-Database publish must not be blocked by a deliberately skipped Database job. Test these branches in workflow-level offline/PR validation.
4. **Release credential scope.** Inject `CLOUDFLARE_API_TOKEN` only into the actual deployment/preflight/readback steps, not the entire job's install/test environment. Ensure the `production` Environment and branch restrictions really work on this **private** repository and verify its GitHub entitlement first. The manual dispatch must match trusted `main` and check HEAD again before deploy.
5. **Source/config drift must not be masked by `keep_vars`.** Live read-only metadata on 2026-10-13 reports IMA automatic tracing enabled, while `apps/ima-mcp-worker/wrangler.jsonc` does not explicitly configure `observability.traces.enabled`. Its production `R2_PUBLIC_BASE_URL` is also a live plain-text binding not declared as a `vars` key in source. Retain `keep_vars`, verify the effective Wrangler deployment configuration and preserve observability, secrets, R2/DO/rate-limit and VPC binding invariants. Do **not** implement a generic drift-reconciliation engine; add only the necessary reviewed settings if test evidence shows risk.
6. **Remote Control temporary config must resolve correctly.** An ephemeral Wrangler file must preserve relative `main`/schema paths (for example by locating it under the Worker app directory or appropriately rewriting paths), replace the one expected VPC placeholder exactly once, and be ignored/removed after deployment. Never print the resolved config. Match the **current owner-approved** enabled Shell/file-write gates from Issue #14; retain T10/T11 documented residual risks without reopening already closed admissions.
7. **The shared-ingress-Token follow-up needs a logging/privacy gate.** Cloudflare read-only metadata reports `invocation_logs=true` for Database/IMA/Raindrop but `false` for Remote Control. Remote Control's T10 documents historical request authorization headers in Invocation Logs. Before extending a **single new** ingress Token across all four Workers, ensure the logging/redaction policies of **all four** cannot expose its Authorization value; disabling sensitive invocation capture where appropriate is preferable to accepting unassessed exposure. Perform any such change in the separately approved Token-alignment phase, not as a silent side effect of this deployment migration.
8. **Negative health checks have limited meaning.** An unauthenticated 401/403 or an Edge challenge alone does not prove the MCP application was reached or its middleware behaved correctly. Combine cheap read-only control-plane checks with the agreed human Portal MCP initialize/tools-list and safe read-only call before declaring each first cutover accepted.

**Explicit non-goals reaffirmed:** no second deploy workflow, run registry, custom pending-work manager, general-purpose Cloudflare diff engine, token-value comparison, automatic release, or automatic rollback. These findings must be handled in the implementation plan and acceptance tests; until then this remains a proposed ADR awaiting final approval.

## Production runtime bindings and GitHub secret-minimization audit (2026-10-13)

**Read-only finding, not permission to mutate any binding.** Verified all four active Cloudflare Worker settings, Secret **names only**, and current source use. The target GitHub `production` Environment does **not** need any of the four Workers' runtime Secrets or ordinary tuning vars. It only needs: `CLOUDFLARE_API_TOKEN` (Environment Secret), `CLOUDFLARE_ACCOUNT_ID` (non-secret Environment Variable), and for Remote Control dispatch `REMOTE_CONTROL_VPC_SERVICE_ID` (non-secret Environment Variable per settled Q5=B). The last value is checked against the live `REMOTE_CONTROL_DEVICE` binding before the deploy; do not publish its value.

| Worker | Required Cloudflare runtime credentials | Tuning vars and availability | Resource and feature dependencies |
| --- | --- | --- | --- |
| Database | `MCP_ACCESS_TOKEN`, `DATABASE_CONFIG` | `MAX_ROWS`, `MAX_RESULT_BYTES`, `MAX_SCHEMA_BYTES`, `QUERY_TIMEOUT_MS`, `MAX_WRITE_AFFECTED_ROWS` **already optional in code**: deployed values match built-in defaults `500`, `1048576`, `524288`, `15000`, `20` respectively | `RATE_LIMITER` **required** by `enforceRateLimit`; do not drop |
| IMA | `MCP_ACCESS_TOKEN`, `API_KEY`, `CLIENT_ID` | `R2_PUBLIC_BASE_URL` is a plain-text runtime var, but **currently required** by `src/index.ts` startup/ready checks; do not remove just to make deployment easier | `R2_BUCKET` required at startup; `IMA_IMAGE_REFRESH_SHARD` needed for image re-signing; preserve both |
| Raindrop | `MCP_ACCESS_TOKEN`, `RAINDROP_ACCESS_TOKEN` | `RAINDROP_RATE_LIMIT_MAX_RETRIES` **already optional**: missing/invalid defaults to `3` | No extra runtime resource binding |
| Remote Control | `MCP_ACCESS_TOKEN`, `REMOTE_CONTROL_DEVICE_TOKEN` | `REMOTE_CONTROL_ENABLE_FILE_WRITES` and `REMOTE_CONTROL_ENABLE_SHELL` are **optional fail-closed feature gates**; only exact string `"true"` enables their capability | `REMOTE_CONTROL_DEVICE` VPC Service required for device calls and must stay bound |

**Resolved owner-authorized Remote Control posture:** Cloudflare now reports both feature gates as `"true"`; this is **intentional**, not an unexplained drift. Closed GitHub Issue [#14](https://github.com/lirtual/mcp-workers/issues/14) records Shell production acceptance and an **independent owner decision** to retain file writes enabled; the maintainer confirmed both here on 2026-10-13. Earlier T10 documents and some older Remote Control spec prose describe a historical **read-only** release and must not override the newer #14 decision. Source `isToolEnabled` requires exact `=== "true"`. Manual publishing must **preserve and verify both existing `true` values**, not remove them under an optional-variable cleanup or restore the historical `false` baseline. Scope-limited acceptance of Linux-user privileges and managed-process residual risks is recorded in #14; do not claim Shell is sandboxed, silently widen the target host, or change the device authorization. Live `invocation_logs=false` must continue unchanged.

**Configuration ownership rule:** ordinary tuning parameters with secure built-in defaults do not need GitHub variables and need not be removed from Cloudflare to permit publication. `keep_vars:true` preserves dashboard-maintained plain vars, and Cloudflare Wrangler preserves existing runtime Secrets across normal deployments; do not mirror them in GitHub. An actual removal/cleanup of redundant dashboard vars is a separate verified change, not part of deployment-publisher migration. Never weaken the IMA feature contract or delete R2/DO/rate-limit/VPC bindings merely to reduce the number of fields. Cloudflare Secret names may be checked without reading or comparing their values. The global `MCP_ACCESS_TOKEN` alignment remains a **later, separately authorized** action per Q14=A.

### Authoritative Remote Control acceptance chronology

- **#12 (T10)**: closed; earlier read-only evidence and residual risks remain historical evidence, not a current command to disable approved later features.
- **#2 (v1 spec)**: closed; architecture archive, not the current Shell/write gate state.
- **#14 (T11)**: closed on 2026-10-13 after production Shell acceptance and a separate owner confirmation to **retain** `REMOTE_CONTROL_ENABLE_FILE_WRITES=true`; both production gates are now `true` and current Cloudflare bindings agree.
- Latest decision priority for the manual-deployment spec: **current owner instruction and #14 approval** over earlier read-only snapshots; preserve the existing write/Shell enabled state and risk boundary. The migration adds **no new** permissions and triggers **no production operation**.

## Scope, evidence and consequences

**Implementation-in-scope, after explicit sign-off:** extend existing `ci.yml` to support manual single-Worker deploy and Remote Control checks; use the existing/pinned Wrangler toolchain and conditional Database integration; implement safe manual-release concurrency/preflight/readback checks and temporary VPC config for Remote Control; update old Cloudflare Builds-only and three-Worker deployment docs to reflect the final operating model; perform offline/PR checks without production credentials.

**Out-of-scope:** a second GitHub Actions workflow, automatic deploy on `main` or PR, multiple Workers in one manual dispatch, arbitrary SHA publishing, new release database/queue, new worker infrastructure, automatic rollback, secret rotation/token unification execution, remote-agent/Shell/write capability changes, Remote Control T10 closure, or a production cutover without separately granted approval.

**Benefits:** a single CI and publishing interface; no unintended release on merge; independent Worker deployment with proven checks; preserves runtime Secret ownership; minimal new infrastructure.

**Risks/costs:** manual releases can lag behind `main`; Environment feature/credential setup must be verified for this private repository; Cloudflare configuration drift can still cause unintended changes without explicit pre/post comparison; recovery requires a new reviewed `main` commit and dispatch; a shared ingress Token increases the security impact of exposure; Remote Control's approved Shell and file-write capabilities can exercise the named Linux account's full accessible authority and retain documented residual risks.

## Decision register and status

| Decision | Confirmed disposition |
| --- | --- |
| Q1 | B — migrate all four Workers |
| Q2 | Earlier C (auto + manual), **superseded by Q12** |
| Q3 | A — reuse existing `ci.yml` and gate deploy on checks |
| Q4 | A — GitHub `production` Environment for dedicated deployment token |
| Q5 | B — GitHub Environment Variable for VPC Service ID with live-binding comparison |
| Q6 | A — check affected Worker(s) on push/PR; **not** an automatic deployment selection |
| Q7 | A — per-Worker serialized manual releases; unrelated Workers parallel |
| Q8 | A — staged **manual** cutover, Remote Control last |
| Q9 | A — rebuild from reviewed GitHub source, no direct historical Cloudflare rollback |
| Q10 | A — automated safe readback/unauthorized/health checks; human first-cutover Portal verification |
| Q11 | A — reviewed revert/recovery commit on `main`, then manual deploy |
| Q12 | **Manual-only** production dispatch; no push/PR deployment |
| Q13 | A — failed check halts affected Worker's rollout, human review, no automatic rollback |
| Q14 | A — complete publisher migration first; token unification is a separate approved change |

**Design decisions are settled; final maintainer acceptance and explicit implementation authorization are still pending.** Implementation must remain on an isolated branch until reviewed. **No `main` change, Cloudflare deploy, Cloudflare binding write, GitHub production credential configuration, or runtime Secret rotation is authorized by this ADR.**

Reference evidence: current `.github/workflows/ci.yml`; `apps/*-mcp-worker/wrangler.jsonc`; `docs/runtime-configuration.md`; `docs/mcp-shared-token-runbook.md`; `docs/remote-control/T10-RELEASE-ACCEPTANCE.md`; read-only Cloudflare deployment/binding/Secret-name inventory (2026-10-13); [Cloudflare GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/); [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/); [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/).
