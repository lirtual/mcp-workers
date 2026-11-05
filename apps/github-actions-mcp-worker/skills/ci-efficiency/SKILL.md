---
name: ci-efficiency
description: Audit, diagnose, design or optimize GitHub Actions CI efficiency, including slow PR checks, duplicate runs, runner usage, concurrency, caching, required checks and CI/CD release safety.
---

# Evidence-driven CI efficiency

Use this skill for CI efficiency audits and improvements, not routine GitHub Actions run status, dispatch, rerun or cancellation. Apply the repository's `AGENTS.md` / `CLAUDE.md`, current instructions, authorization, acceptance criteria and production boundaries. A skill is guidance, not authorization to change repositories or deploy.

## Choose the smallest useful investigation

- **Single failure or gate question:** inspect the affected run, jobs/steps, Workflow YAML and required checks as needed. Explain the specific failure or Unknown evidence; skip performance baselines and unrelated optimization advice.
- **Configuration safety review:** examine relevant YAML, branch/ruleset checks, concurrency and release triggers. Validate the affected paths and their safety boundaries; skip broad runtime statistics unless they inform the decision.
- **CI efficiency audit or optimization:** use the full measurement and change-review process below, scoped to actual bottlenecks. If current behavior is already efficient, recommend no change.

### Evidence and tool routing

- `@Github Actions` offers repository/workflow discovery, up to **30 recent runs** per `github_actions_runs_list` call, run status, job/step outcomes and artifact **metadata**. Its MCP tools do **not** provide full raw logs, Workflow YAML, branch protection/rulesets or artifact bodies. Avoid implying access to any of these through this connector.
- When necessary and authorized, use existing GitHub repository tools, local repository files or other available trustworthy sources for YAML, rulesets, logs and detailed run history. Check their actual coverage and permissions; report missing evidence as **Unknown** instead of asserting it does not exist. A 50-run sample is an upper target where accessible, not a prerequisite to every task or a promise of coverage.
- GitHub Actions Workflow YAML and repository protection rules are the current sources of truth. Historical reference documents are background, not live state. Distinguish CI, production deployment and long-running operational sessions before interpreting an action.

## 1. Establish the current state (full audit only)

1. Read actual workflows, called/reusable workflows, scripts, branch rules, release and environment protection, and repository-specific conventions at current revision. Distinguish PR CI, main CI, matrix/native acceptance, release and long-lived sessions; a slow operational session is not automatically inefficient CI.
2. Gather up to 50 recent runs **when available** across suitable sources, separating event, branch, conclusion, retries, attempt, runtime and frequency. The Actions MCP lists at most 30 recent runs per call, so describe actual data coverage rather than inferring 50-run completeness. For critical cases inspect jobs/steps and dependency graph. Record sample size and covered dates; historical runs do not establish current behavior.
3. Measure independent axes: wall-clock time from PR update until required checks complete (P50/P95 for successful comparable samples), sum of runner execution minutes, and reliability (failures, cancellation and reruns). Distinguish queueing, environment preparation, tests and build. Exclude failed-fast and cancelled runs from successful-run latency; distinguish queued overlap from billable runtime.
4. Identify the **critical path**; verify apparent duplication is the same validation on the same source and environment, not distinct security/OS/commit guarantees. Inspect caching and changed-component detection before proposing alternatives. **Done when** the baseline and coverage map have supporting evidence, and missing evidence is marked Unknown.

## 2. Choose minimally sufficient changes

- Prioritize verified waste; propose at most three high-value fixes first. Do not promise a fixed speedup. Avoid new CI infrastructure, reusable abstractions, complex caches, matrix sharding or paid runners without evidence of net benefit.
- PR concurrency may cancel superseded runs **only within the same PR**. Other PRs, main updates, `workflow_dispatch` candidates, `workflow_call` release checks, deployments and long-running sessions must remain isolated. Review workflow- and job-level groups, caller/callee `github` context, pending replacement and `cancel-in-progress`.
- Preserve explicit main validation policy. If main requires full checks, do not silently reuse PR affected-only selection or path filters to skip them. A single push containing multiple commits normally validates the push HEAD, not each intermediate commit.
- Change-scoped PR checks require trustworthy changed-file baselines, fail-safe handling for unknown paths, dependency-aware impact rules and a reliable aggregate gate. Avoid path-filtering an entire required workflow, which may leave required status pending. A skipped job can report success; the aggregate gate must ensure necessary checks actually ran and passed.
- Preserve native acceptance on required OS/architecture; check artifact provenance, source SHA, checksums, environment approval, release sequencing and deployment boundaries. Passing CI never by itself authorizes production release.
- For caching/installation/parallelism, measure setup/download/install/build phases first. Prefer existing supported caches and verified prebuilt tools when beneficial. Parallelize only after accounting for startup time, total runner-minutes and failure propagation; assess cold and warm caches. Do not extrapolate local builds to ephemeral hosted runners. **Done when** each proposed change names its evidence, expected impact, protected behavior and verifiable acceptance criteria.

## 3. Implement, validate and stop

1. For read-only requests, stop at grounded findings and a minimal recommendation. Implement only with authorization; production releases, production configuration, credentials and destructive operations require explicit authorization.
2. When implementation is authorized, keep changes local to the relevant repository. Preserve required check identities and branch protection, and verify that push or merge cannot unexpectedly trigger production deployment.
3. Verify relevant YAML and behavioral cases: same-PR supersession, different PR isolation, main not cancelled or silently skipped, manual/reusable release separation, gate failure propagation, native coverage and artifact provenance, according to affected paths.
4. For performance changes, compare successful-run wall-clock P50/P95, runner-minutes and reliability against a comparable baseline when evidence is available. Report **Pass / Not performed / Waived / Blocked / Unknown** independently. If gain is immaterial or maintenance cost rises, keep the simpler design.
5. **Stop** once the stated goal, affected paths and mandatory gates are supported by evidence. Do not create extra CI runs just to chase theoretical optimization.

## Historical context (load only for these repositories)

For work specifically concerning `lirtual/mcp-workers`, `lirtual/remote-control-agent`, `lirtual/github-actions`, `lirtual/cloudflare-actions` or `lirtual/scrape_relay`, read [`references/ci-review-2026-11.md`](references/ci-review-2026-11.md) only when past CI decisions or historical measurements materially help. Recheck all applicable facts at the current revision before acting.
