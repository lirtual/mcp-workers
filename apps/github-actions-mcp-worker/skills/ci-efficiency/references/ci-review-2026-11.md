# CI optimization review — historical reference (2026-11-04)

This document captures **design decisions and time-bound audit observations**, not live configuration or implementation instructions. Always compare current main, rulesets, check names, and actual release triggers before changing any repository.

## User-confirmed scope / choices

- Q1=A: prioritize time to required PR checks, constrain runner-minute usage and maintenance overhead.
- Q2=A: trustworthy change-scoped PR validation; main requires full necessary validation; preserve required release and native checks. Clarify actual main policy against current files, and treat any mismatch as a correctness task, not an efficiency gain.
- Q3=A: optimize existing workflows independently; share principles only, no new central CI service or cross-repository dependency.
- Q4=A: `scrape_relay` remains unchanged; do not restore historical GitHub Actions.
- Historical decision: read-only analysis before implementation; normal code/PR scope and mandatory gates subject to current user authorization. Production publish, production environment/config/data, credentials and destructive operations require explicit approval.

## Audit snapshot

- Observed about 50 recent runs per repo and sampled job/step timing (not exhaustive recent 50-job decomposition). Successful PR CI p50/p95 approximate historical samples: `mcp-workers` 61s/304s (n=13), `github-actions` 63s/74s (n=11), `cloudflare-actions` 27s/38s (n=25), `remote-control-agent` 150s/395s (n=21). Samples and time windows differ; p95 particularly sensitive to small n and queue anomalies.
- `mcp-workers`: one database-affected PR example Application checks ~196s then Database integration ~103s, Gate ~2s; 4/13 sampled successful PRs ran database integration. Current affected-app selector already exists; don't duplicate. Review PR/main job-level concurrency, caller/callee groups and conditional Gate semantics. Preflight + parallel database integration is **conditional**, and may slow ordinary PRs due to an extra job; gate and candidate provenance must remain intact.
- `remote-control-agent`: native five-platform Linux x64/ARM64, macOS ARM64/Intel and Windows x64 verification has distinct coverage. Some PR runs overlapped after new pushes, and some macOS runs queued for minutes. Investigate PR-only supersession, preserving main/manual release candidates, artifact SHA/provenance and checksums.
- `github-actions`: static CI around one minute; long-lived `chrome` / `openlist` sessions are operational workflows, not ordinary CI. Replacing `go run actionlint` is not necessarily on the critical path; verify main path filter against full-main requirement.
- `cloudflare-actions`: PR CI around half a minute, existing caching and release flow; no measured case for substantial restructuring. Prefer no change unless a new, material risk is found.
- `scrape_relay`: historical CI was deliberately removed in October 2026; it is **out of scope** for this optimization. Old runs are not current CI evidence.

## Proposed minimal order, subject to renewed checks

1. `mcp-workers`: isolate PR concurrency from main, manual and reusable release checks. Confirm normal main coverage matches Q2 and preserves required gate semantics; validate real branch rules before changing required checks.
2. `remote-control-agent`: PR-only supersession without changing five-platform matrix, release workflow, protected candidates or main results.
3. `github-actions`: reconcile main full-check requirement with actual path filters, only if audit verifies the mismatch and avoids unrelated operational sessions. This is correctness, not speedup.
4. `mcp-workers` database parallelism: measure additional preflight startup/runner cost versus database-related PR critical-path gain, and non-database PR regression; implement only with meaningful net benefit and unchanged origin/gate guarantees.
5. `cloudflare-actions` and `scrape_relay`: unchanged unless new evidence/requirements justify otherwise.

## Known unresolved evidence / limits

- Branch protection / required status check names were unavailable to the audit due to permissions. Treat as **Unknown**; do not claim they were checked.
- Live after-change performance, mandatory check alignment, tested release-caller context and production impact were **Not performed** during the design review.
- Do not infer precise monetary cost reduction from run overlap or wall-clock times. Cancellation can reduce resource use but a single isolated PR run will not necessarily finish sooner.
- Specific SHA IDs, runtimes, installed dependencies, paths and policy can change; read source-of-truth config rather than copying historical facts.

## Acceptance evidence requested upon implementation

- Old PR run superseded; newest PR checks pass; unrelated PRs isolated.
- Main update triggers complete required checks, not cancelled by another main update; do not claim per-commit runs for a multi-commit push.
- Workflow-call release path, manual candidate, branch protection and Required Checks preserved; skipped/failing necessary job never yields passing gate.
- Necessary native architectures/platforms and artifact provenance preserved.
- Comparable successful-run latency, runner-minutes and reliability before/after, with sample/date and Pass / Not performed / Waived / Blocked / Unknown.
- Production publish remains separately authorized and verified; a merged PR is not production acceptance.
