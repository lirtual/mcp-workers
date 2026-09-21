# PR #120 — Independent review handoff (2026-09-21)

> Implementation/CI evidence transfer only. **Not** a Standards/Spec reviewer signature, live acceptance, or release authorization. This document-only commit advances the PR HEAD beyond the implementation SHA below. Reviewers **must fetch the current remote HEAD** and inspect its complete `main...HEAD` diff before signing.

## Goal and sources

Independently review [PR #120](https://github.com/lirtual/mcp-workers/pull/120) against approved [spec #110](https://github.com/lirtual/mcp-workers/issues/110) (§5.1, AC-02/12/14/15) and open [contract ticket #118](https://github.com/lirtual/mcp-workers/issues/118).

### Suggested Skills

- `skills://plugins/matt-skills-curated/code-review`
- `skills://plugins/matt-skills-curated/handoff`

## Frozen implementation evidence; not a new HEAD assertion

- Verified **implementation HEAD before this documentation commit**: `b73195b96c38b72f52478baceba99862e5a8d69b` (PR Open, Draft).
- Observed merge-base with `main`: `9434aa25d96244087e6b27fb2302c0e620a8d14c`.
- Prior baseline: `c05c4c95628c5950a44198bcc76eb886f79158fb`; implementation SHA is six commits ahead, none behind.
- A later documentation commit, concurrent updates, or movement of `main` **requires rechecking PR HEAD, actual merge-base, and all final-SHA checks**. Do not label older CI as verification of a newer SHA.
- `AGENTS.md` was absent from the GitHub root and app directory at the observed SHA; inspect the local worktree for applicable instructions. Read `apps/raindrop-mcp-worker/CONTEXT.md` and `docs/adr/0001-replace-legacy-tool-contract.md`.

## Implementation and RED → GREEN evidence (not sign-off)

1. Malformed-business-result RED: `ff2faab34920abb586efd9075f7b213adb782faf`, [failed CI #35592147652](https://github.com/lirtual/mcp-workers/actions/runs/35592147652). Six target assertions failed on the old behavior.
2. Runtime validation: `src/services/business-contracts.ts:5–45` and `src/services/raindrop.service.ts:304–401,412–554,611–619,717–757`. Malformed reads yield structured `UPSTREAM_ERROR`. Acknowledged writes with invalid/unusable result data preserve `status:succeeded`, `data:null`, `outputOmitted:true`; no automatic replay or false `WRITE_OUTCOME_UNKNOWN`.
3. Per-tool output schemas: `src/tools/output-contracts.ts:33–100`, registered in `src/tools/index.ts:26–31`. They distinguish `ok:true/data/meta` from `ok:false/error/meta` and allow unknown official extension fields.
4. Legal-argument Client matrix RED: `7d349251a8b36630d30bab2c92f9645e21bd6cec`, [failed CI #35592695343](https://github.com/lirtual/mcp-workers/actions/runs/35592695343): `highlight_delete` preview `targets` did not match its exported Schema. Minimal fix: `b34a7f91dc527a5fdf6727707875537eb26dc4cd`, `output-contracts.ts:55–62`.
5. Final negative fixtures: `b73195b96c38b72f52478baceba99862e5a8d69b`. `tests/tool_contract.test.ts:273–327` covers malformed reads, missing required fields and acknowledged malformed write results. `tests/v3_all_tools_success_contract.test.ts:28–201` exercises 26 legal-argument MCP Client + InMemoryTransport calls against fake HTTP, asserting method, path, body, count, output schema and success/blocked shape; explicitly included in `package.json` `test:local`.
6. [Final implementation-SHA CI #35593080066](https://github.com/lirtual/mcp-workers/actions/runs/35593080066): Application checks **success**, 19 Raindrop files, **250 passed / 3 skipped**, ESLint **26 warnings / 0 errors**, typecheck, deterministic Schema and Wrangler dry-run passed. Database integration **success**. This is offline evidence for `b73195b9`, not a subsequent documentation SHA.

## Separate reviewer responsibilities

**Standards Agent — fresh, isolated context:** Inspect complete `main...current HEAD` diff, entry authorization, body timeout/cancellation, queue deadline, read-only POST suggestion, non-replay of submitted writes, `WRITE_OUTCOME_UNKNOWN`, response/resource budgets, error consistency, Sampling/legacy reachability and dangerous gates. Report Pass/Fail/Blocked with precise source lines and tests. Do not accept implementation self-review as sign-off.

**Spec Agent — separate fresh context:** Independently compare entire diff with #110 and #118 ACs. Validate all 26 tool names; real `tools/list` input/output schemas; each legal-argument Client request and output; malformed upstream items; previews and write status; resources/templates; three safe prompts; 16 active OpenAPI route shapes; README and coverage matrix. Pay particular attention to `highlight_delete` preview versus mutation. `collection_update(parent=null)` and `duplicates_delete(confirm=true)` must remain `FEATURE_UNVERIFIED` with zero writes. Report Pass/Fail/Blocked with source lines and tests; do not reuse another Agent's judgment.

## Unresolved gates and prohibitions

- #118 remains **Open** and PR #120 remains **Draft** until two identity-separated reviews of the then-current exact SHA. No merge or Ready transition.
- #119 Cloudflare Free CPU/resource and Portal acceptance, and #128 source-attributed Portal evidence, remain separate and unapproved. Offline CI is not live/Portal evidence.
- No real Raindrop account writes, test/production Worker deployment, Portal switch, root move, duplicate deletion, force push, or expansion of credential/scope boundaries.

## Exact resume action

```bash
git fetch origin
git status --short
git rev-parse HEAD
git merge-base origin/main HEAD
git diff --stat origin/main...HEAD
gh pr view 120 --repo lirtual/mcp-workers --json headRefOid,isDraft,state
```

Read this handoff, verify the **current** remote PR HEAD, and conduct **one** independent Standards or Spec review in a fresh context. A SHA change requires new exact-SHA review evidence; do not inherit an old sign-off.
