# MCP Workers shared entry token and Workflow runtime configuration: implementation specification

- Status: Ready for ticket decomposition (design accepted; code and live migration not performed)
- Date: 2026-09-20
- Scope: `lirtual/mcp-workers` single-user production; seven core MCP Workers, with deployment/configuration work concentrated in `workflow-mcp-worker`
- Authority: ADR 0028, ADR 0022, ADR 0023, `docs/runtime-configuration.md`, and `docs/workflow-mcp/v0.1-spec.md` §27
- Tracker: publish dependent GitHub implementation issues in the subsequent `to-tickets` stage; this repository document is the authoritative buildable spec

## 1. Problem and outcome

All seven MCP Workers already name their MCP-entry runtime Secret `MCP_ACCESS_TOKEN`, but their installed *values* need not match. The Workflow deployment currently synthesizes a new MCP token, duplicates it in a smoke-only runtime secret, regenerates the executor lease key, writes an ephemeral GitHub job token to the long-lived GitHub runtime credential, and removes configured Cron triggers. It also exposes redundant settings that are owned by the repository or a deployment configuration. This makes normal deployments capable of invalidating live MCP clients and active executor leases.

**Outcome:** the seven independently deployed Workers accept one intentionally shared MCP caller token; Workflow retains only needed, independently privileged platform credentials and bindings; normal deploys neither change production credentials nor run authenticated heavy/connection smoke tests; real cron and webhook behavior remains intact. No new secret-distribution service, credential vault, or general RBAC is introduced.

## 2. User stories

1. As the single operator, I want one MCP access-token value across the seven MCP applications, so that I can configure supported MCP clients consistently.
2. As the single operator, I want each Worker to require `MCP_ACCESS_TOKEN` by name, so that deployment configuration stays predictable.
3. As the single operator, I want an explicit coordinated rotation procedure, so that a leaked shared token can be replaced with known impact across applications and clients.
4. As an MCP caller, I want invalid or absent credentials rejected, so that the shared token cannot be bypassed.
5. As an MCP caller, I want a routine Workflow deployment to preserve my existing authentication, so that code-only updates do not disconnect me.
6. As an operator, I want ordinary deployment checks without privileged test credentials, so that production secrets are not copied into CI.
7. As an operator, I want to request an authenticated end-to-end smoke test separately, so that heavyweight verification remains available without running on every push.
8. As an operator, I want production to omit dedicated smoke webhook and duplicate MCP test secrets, so that only real integrations require production credentials.
9. As a webhook producer, I want distinct authentication for an actual configured trigger, so that a shared MCP token does not grant webhook admission.
10. As a Workflow operator, I want GitHub dispatch/cancellation to remain usable after the deployment job exits, so that scheduled and manually initiated heavy tasks continue to run.
11. As an executor, I want an existing lease to remain valid through an ordinary deployment, so that running steps can complete.
12. As an operator, I want fixed configuration recorded once, so that routine deployments do not drift from repository configuration.
13. As a workflow author, I want schedules and currently supported R2 artifacts preserved, so that configuration cleanup does not remove working capabilities.
14. As an operator, I want missing essential credentials to fail closed before release, so that deployment does not publish an unusable runtime.
15. As an operator, I want reversible migration checkpoints, so that failures can be contained without exposing credentials or corrupting active runs.

## 3. Configuration contract

### 3.1 Seven MCP application entrypoints

| Worker | MCP caller Secret | Independent upstream/runtime requirements |
| --- | --- | --- |
| `ima-mcp-worker` | `MCP_ACCESS_TOKEN` (shared value) | `API_KEY`, `CLIENT_ID`; existing runtime bindings |
| `openlist-mcp-worker` | same | `OPENLIST_TOKEN`, endpoint/behavior settings |
| `weread-mcp-worker` | same | `WEREAD_API_KEY` |
| `database-mcp-worker` | same | `DATABASE_CONFIG`, existing rate-limit/DB bindings |
| `raindrop-mcp-worker` | same | `RAINDROP_ACCESS_TOKEN` |
| `instapaper-mcp-worker` | same | Instapaper consumer and OAuth credentials |
| `workflow-mcp-worker` | same | Workflow platform secrets, infrastructure bindings and configured real connection/trigger credentials |

Exactly one **name and value** is shared across MCP entry boundaries. Each Worker receives its own Cloudflare runtime Secret with that value. No shared runtime database, cross-Worker secret synchronization, token-issuing endpoint, or implicit sharing of upstream credentials is permitted. Retain each application's existing supported authentication transport and Portal behavior; this change does not add a new OAuth flow. Existing independently deployed Workers do not need to change their MCP handler merely to align the value.

### 3.2 Workflow baseline (subject to actual feature use)

| Category | Names / ownership | Required behavior |
| --- | --- | --- |
| Long-lived runtime Secrets | `MCP_ACCESS_TOKEN`, `EXECUTOR_LEASE_SECRET`, `GITHUB_ACTIONS_TOKEN`, `R2_SECRET_ACCESS_KEY` | Four independently privileged Secrets. Never generate or replace in an ordinary deployment. `GITHUB_ACTIONS_TOKEN` must be a persistent, repository-scoped, least-privilege GitHub authorization, not the deployment job's `github.token`. |
| Non-secret runtime credential identifier | `R2_ACCESS_KEY_ID` | Required by the current R2 S3 signer; may be stored as a normal runtime variable, but still belongs to the same R2 credential pair and must be updated coherently on rotation. |
| Non-secret infrastructure identifiers | `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `GITHUB_REPOSITORY`, `GITHUB_REPOSITORY_ID` | Maintain one documented version-controlled/deployment source for each; account/repository IDs are identifiers, not Secrets. Avoid duplicate dashboard overrides and CI copies. |
| Fixed code/config defaults | `GITHUB_EXECUTOR_REF`, `GITHUB_EXECUTOR_WORKFLOW`, `GITHUB_OIDC_ISSUER`, `GITHUB_OIDC_JWKS_URL`, `GITHUB_OIDC_AUDIENCE` | Preserve the existing resolved values and strict repository/ref/workflow/OIDC validation; eliminate unnecessary dashboard overrides. An intentional deployment change is a reviewed source change. |
| Cloudflare bindings | `DB`, `WORKFLOW`, `ARTIFACTS`, `CF_VERSION_METADATA` | Keep D1, Workflows, R2 and version metadata; keep the one-minute scheduler Cron defined in the Wrangler deployment configuration. |
| Genuine integrations | Configured connection credentials and **per-real-trigger** webhook credentials | Required only when an enabled real connection/trigger refers to them. Never silently substitute the shared MCP caller token. |
| Removed production-only test settings | `SMOKE_READONLY_MCP_TOKEN`, `TRIGGER_SMOKE_WEBHOOK_TOKEN`, `SMOKE_MODERN_MCP_ENDPOINT` and any leftover test-only overrides | Eliminate from production `secrets.required`, deployed `vars`, code paths and bound compiled definitions unless the purpose has become a genuine, explicitly approved connection. |

The four-Secret target is for the **platform baseline** with `R2_ACCESS_KEY_ID` retained separately. Do not treat it as a maximum across real business integrations, or collapse unrelated secrets into one JSON value just to reach a count. `R2_SECRET_ACCESS_KEY` remains necessary with the current direct R2 presigned upload/download design. Preserve the existing self-contained deployment environment, stable `main` branch and independent Workers.

### 3.3 Existing smoke fixtures and business schedules

The current production registry includes `trigger-http-smoke.yaml`, referencing `TRIGGER_SMOKE_WEBHOOK_TOKEN` **and** a five-minute smoke schedule; it also includes `mcp-connection-smoke.yaml` with `smoke-modern` referring to `SMOKE_READONLY_MCP_TOKEN`. Removing a variable alone leaves dangling compiled references. Convert the dedicated smoke trigger/connection fixtures to local or separately run acceptance fixtures (or remove those fixtures from the *production* compiled registry), and update the registry generator, tests, tracer and documentation together. Do not remove the generic webhook route, actual webhook support or the one-minute scheduler tick. Other intentionally retained demonstration workflows must have valid, explicit credentials and no hidden dependence on the removed names. Never invoke the shared MCP caller token as a substitute for webhook authentication.

`raindrop-daily-snapshot` and any enabled genuine schedule must remain schedulable; removing a smoke schedule is not authorization to remove Cron capability. Reconcile the deployment generator, which currently writes `triggers.crons=[]`, with the canonical checked-in `wrangler.jsonc` and existing scheduler tests.

## 4. Module-level changes and interfaces

1. **Runtime configuration**: align `apps/workflow-mcp-worker/wrangler.jsonc`, `src/types.ts`, `scripts/build-deploy-config.ts` and the runtime accessors to the above ownership rules. Preserve required validation for secrets actually used. The generated deployment config must not drop Cron; it must not synthesize a smoke endpoint in the production runtime.
2. **GitHub deploy workflow**: change `.github/workflows/workflow-mcp-deploy.yml` so the default push/ordinary manual deployment uses persisted Cloudflare secrets without `openssl rand` or a `--secrets-file` containing ephemeral replacements. Remove the current generation/verification steps whose sole purpose is bootstrapping those test secrets. Keep release checks, nonterminal-run compatibility, migrations, deployment, health check and evidence summary, with no production credential in logs/artifacts.
3. **Outbound GitHub auth**: provision `GITHUB_ACTIONS_TOKEN` through an explicit one-time/runtime rotation procedure backed by the repository-scoped fine-grained credential from ADR 0023. Recheck its post-job dispatch, lookup and cancellation with the actual Worker after the deploy job ends. CI may still use its own `github.token` for CI-only GitHub operations, but must never install it as the Worker runtime token.
4. **Authentication and connection definitions**: keep `src/portal-auth.ts` validating `MCP_ACCESS_TOKEN`. Update `src/connections.ts`, `src/triggers.ts` as needed, workflow fixture YAML, `src/generated/workflow-registry.ts` and tests so removed production smoke credentials are not referenced. Keep generic connection auth schemes and real webhook auth unchanged.
5. **R2 and executor**: preserve `src/r2-signing.ts`, `src/artifacts.ts` and `src/lease.ts` contract behavior; change configuration source/type only where justified. Never expose signing credentials or short-lived leases to MCP clients.
6. **Test interfaces**: separate light deploy probes from `scripts/run-deploy-tracer.ts` and `scripts/verify-deploy-executor.ts`. Retain a separately invoked, explicitly authorized heavy + connection end-to-end acceptance path; do not require `WORKFLOW_MCP_ACCESS_TOKEN` or production Token copies in the ordinary job. The separate tracer may receive an authorized MCP token from the invoker's secure test context; it is not a second Worker runtime Secret.
7. **Cross-app documentation**: keep `docs/runtime-configuration.md` and each affected README/sample config aligned with the canonical shared-token contract, the credential-scope distinction, and the step-by-step migration. No app should silently create a second MCP entry token.

No database schema or model-facing MCP tool/API change is required by this feature. If implementation discovers an unavoidable behavior change, update this spec and its governing ADR before coding beyond scope.

## 5. Migration and rollback contract

**Preflight, no mutation:** the operator confirmed on 2026-09-20 that the seven production Workers already share one `MCP_ACCESS_TOKEN` value. Inventory Secret **presence and type** (not the value), existing clients/Portal connections, smoke-fixture dependencies, Workflow active/nonterminal runs, scheduler activation and GitHub/R2 readiness. Preserve that installed value, record a no-rotation/rollback checkpoint, and do not force client reconnect. Operator confirmation is not an independently readable comparison of Cloudflare Secret values.

**Prepare:** implement and test the no-auto-rotation deploy and the new required-secret contract before removing existing runtime bindings. Provision distinct persistent GitHub, R2 and lease credentials where missing; coordinate with active executor leases, especially if an existing lease key must be replaced. Preserve the current live value until the caller cutover is authorized. Where a required platform credential is missing, stop migration before deploying instead of generating an emergency fallback. Check real schedules/triggers after configuration build.

**MCP continuity (no cutover necessary):** do **not** reinstall or rotate the existing shared `MCP_ACCESS_TOKEN` on any Worker, and do not update existing clients/Portal connectors. Verify ordinary connected-client behavior and fail-closed missing/invalid-token rejection through existing supported seams without publishing credentials. Investigate any unexpected mismatch independently and stop if the assumption of an already shared value is contradicted. Any later security-driven rotation would be a distinct, expressly authorized task.

**Post-cutover:** verify scheduler activation and a safe scheduler tick/maintenance path, regular MCP/connection behavior, and a deliberately invoked heavy GitHub/R2 acceptance run **after** the deployment job ended. The first genuine Raindrop 09:00 business occurrence is verified only after #107 adds that workflow, under #108; it must not block #123 itself. Only once the code no longer references redundant secrets and all checks pass, explicitly delete superseded production smoke bindings and obsolete dashboard overrides; verify those names remain absent after the next deployment.

**Rollback:** if validation fails, stop further mutations; restore the previous compatible Worker version and its recorded per-Worker MCP client credentials only through an authorized coordinated operation. Preserve nonterminal-run compatibility and do not replace a lease key while old claims might still be active. Investigate and reconcile any already-admitted business run before retrying; never infer rollback of downstream side effects from reverting code.

## 6. Acceptance matrix and tests

Use existing high-level seams (Wrangler generated-config inspection, HTTP `/health` and `/mcp`, actual compiled registry, D1/Workflows/R2 and GitHub Actions) rather than adding extensive internal mocks.

| ID | Given / when | Expected result |
| --- | --- | --- |
| C01 | All seven Workers configured with the chosen value | Each accepts the shared token through its existing MCP/Portal path; a missing or incorrect token is rejected, never fail-open. |
| C02 | A routine Workflow deployment without an authorized MCP credential in CI | Release checks, migration/compatibility check, health and unauthenticated MCP probe succeed without exposing or changing the production MCP token. |
| C03 | Run two routine Workflow deploys | Existing MCP token, lease key and R2 credentials are unchanged; in-flight claims remain verifiable and Portal connections remain usable. |
| C04 | Inspect generated Wrangler config and Worker schedule | The configured minute Cron survives generation/deployment and the scheduler tick/maintenance path works after CI ends. Actual Raindrop business admission is deferred to #108 after #107; do not create a dummy production schedule. |
| C05 | Inspect production workflow registry, required-secret list and runtime vars | No production references remain to the removed dedicated smoke token/webhook/endpoint names; real webhook and connection authorization remain separate. |
| C06 | Invoke `/hooks/...` with only the shared MCP token | A real trigger is *not* authenticated by the MCP token; a valid per-trigger credential and event key still admits one deduplicated run. |
| C07 | After deploy job ends, dispatch, inspect and cancel a GitHub run | The runtime's persistent `GITHUB_ACTIONS_TOKEN` works; CI job token is not installed as runtime authority. |
| C08 | Run explicitly authorized heavy acceptance | Actual GitHub OIDC/Attempt Claim, callback and direct R2 artifact write/read succeed without durable R2 credentials exposed to the executor. |
| C09 | Required production secret missing | Deployment fails closed with its missing name; no generated fallback or silent accidental secret reset. |
| C10 | Preserve the operator-confirmed existing shared token through migration | No `MCP_ACCESS_TOKEN` binding is rewritten or rotated, and connected clients remain usable without reauthorization; investigate any observed mismatch rather than initiating a bulk rotation. |
| C11 | Inspect logs, CI artifacts and configuration files | No shared token, upstream secret, lease key, R2 secret or presigned URL is leaked. |
| C12 | Check existing `tests/deploy-gate.test.ts`, connection/compiler/trigger tests | Assertions change to reflect the new contract, no old snapshot demands ephemeral credentials or mandatory heavy tracers on push. |

Also run the existing `pnpm --filter workflow-mcp-worker check`, root CI for affected apps, and the independent full acceptance gate before declaring the migration complete. CI-only tests do **not** establish that the seven live secrets have the same value: perform live authorized verification.

## 7. Explicitly out of scope

- Implementing changes, mutating Cloudflare secrets, GitHub secrets or connected MCP clients during this specification stage.
- A central secret vault, automatic cross-Worker propagation, multi-user identity, role management, or a new OAuth flow.
- Reusing the shared MCP caller token for GitHub, webhook, administrator, R2 or unrelated upstream API access.
- Replacing R2 direct uploads with an artifact proxy just to remove S3 presigning credentials.
- Redesigning workflow orchestration, changing D1 schema, implementing new business automations, or guaranteeing atomic zero-downtime rotation.
- Disabling the scheduler, changing the protocol of existing MCP tools, or removing genuine webhook functionality.

## 8. Implementation ticket DAG (published)

This spec is decomposed into existing and new GitHub issues. Existing tickets were revised rather than duplicated; all links below are live tracker identifiers.

| Ticket | Slice / phase | Blocked by |
| --- | --- | --- |
| [#105](https://github.com/lirtual/mcp-workers/issues/105) T14 | Expand: derive fixed non-secret config while preserving Cron and compatibility | none |
| [#121](https://github.com/lirtual/mcp-workers/issues/121) T18 | Cross-app MCP token contract checks and safe rotation runbook | none |
| [#122](https://github.com/lirtual/mcp-workers/issues/122) T19 | Separate smoke fixtures and light release probe without runtime test credentials | none |
| [#106](https://github.com/lirtual/mcp-workers/issues/106) T15 | Contract: persistent deployment credentials and clean runtime/CI configuration, **code-only** | #105, #122 |
| [#123](https://github.com/lirtual/mcp-workers/issues/123) T20 | Preserve the existing shared MCP token; separately authorize Workflow production configuration migration and acceptance | #121, #106 |
| [#107](https://github.com/lirtual/mcp-workers/issues/107) T16 | First actual Raindrop manual business workflow (existing separate feature) | #106, #123 |
| [#108](https://github.com/lirtual/mcp-workers/issues/108) T17 | Observe real 09:00 scheduled occurrence after production deployment | #106, #107, #123 |

No live Cloudflare Secret mutation, production deploy or GitHub secret change is authorized by publishing these tickets. In particular, #123 requires a new explicit operator go-ahead after its preflight. Only currently unblocked work should receive the `ready-for-agent` label; do not close the existing Workflow parent or unrelated tickets during decomposition.

## 9. Completion definition and handoff

Implementation is complete only after C01–C12, documentation/runbook updates, and live acceptance after deploy-job completion have passed. The four confirmed decisions from the grilling round remain authoritative: Q1:B shared MCP value; Q2:A lightweight automatic deploy; Q3:A no production smoke-only webhook; Q4:A repository-owned static config. Implementation tickets are published above; Workflow production configuration changes and live acceptance remain separately authorized operational steps; shared MCP token rotation is not needed.
