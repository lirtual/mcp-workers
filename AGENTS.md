# AGENTS.md

## Agent skills

### Issue tracker

GitHub issues accessed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Reusable engineering decision guardrails

Before choosing architectures, adding dependencies or implementing features, follow `docs/agents/engineering-decision-guardrails.md`. First define the outcome/boundary, require evidence for each new component and revisit the choice rather than layering fixes on failed assumptions. A PoC is not production acceptance.

### Domain docs

Multi-context layout defined by `CONTEXT-MAP.md` and app-scoped `CONTEXT.md` / ADRs. See `docs/agents/domain.md`.
