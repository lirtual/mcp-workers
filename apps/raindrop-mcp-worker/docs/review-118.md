# #118 two-axis review — 2026-09-20

**Status: manual Standards/Spec re-review completed on pinned source; independent parallel reviewer sign-off and PR merge remain outstanding.** This document is **not** production deployment approval.

- Source-spec baseline: `93ff4f343c029aabf1a5a3a56056d0342760037e`.
- Verified PR merge base against current main: `9434aa25d96244087e6b27fb2302c0e620a8d14c`.
- Previously reviewed source HEAD: `f9421be691d3cefc6bf9a6322a8aa5c8edb2d3fb`; follow-up review and repair were performed against source `e2d161c2c7e408dd4a37d011262838e0bec2611d`. The newest review documentation itself is not a code change.
- Sources: [spec #110](https://github.com/lirtual/mcp-workers/issues/110), [ticket #118](https://github.com/lirtual/mcp-workers/issues/118), `CONTEXT.md`, and `docs/adr/0001-replace-legacy-tool-contract.md`.
- No repository-wide `CODING_STANDARDS.md` / `CONTRIBUTING.md` was found. The review below checks each axis independently but was not performed by two isolated subagents.

## Follow-up review against PR HEAD `e2d161c2`

During this second manual Standards pass, a concrete ingress budget gap was found: authenticated `worker.fetch` read the MCP body using a byte cap without a deadline or caller abort. A stream that never ended could stall **before** the upstream execution budget existed. The matching Spec axis concern was #110 §2.3/§4/AC-15 (bounded ingress and client cancellation), not the pre-existing outbound budget.

**Fixed** in `src/worker.ts:132–156`: an 8-second timeout and propagated caller abort now bound the ingress stream. An aborted ingress returns a redacted 408 and never enters the SDK. New regression tests in `tests/core_reliability.test.ts` cover both a stalled stream and a client disconnect. A first test run advanced fake timers before the async Portal authentication had installed the deadline, so the fixture was corrected to flush the async chain; no production behavior was relaxed.

**Verification:** [CI #35517076473 attempt 2](https://github.com/lirtual/mcp-workers/actions/runs/35517076473) succeeded for source SHA `e2d161c2c7e408dd4a37d011262838e0bec2611d`: affected application checks and database integration both passed. Attempt 1 failed only to initialize an unrelated MySQL container because its fixed host port was already in use; that job was retried successfully.

This is a grounded manual review and repair, **not independent parallel subagent sign-off**. Do not close the separate independent reviewer gate or treat this as production release approval.

## Standards axis — architecture and reliability

**Resolved: typed upstream boundary.** `src/services/raindrop.service.ts:256–706` now invokes `openapi-fetch<paths>` for active routes without `(this.client as any)`. The compiler exposed and forced fixes for incorrect optional create fields, nullable parent, allowed sorts, response counts and tag write body. The source uses a runtime check for the permitted sort values and refuses `parent=null` with `FEATURE_UNVERIFIED`; it does not silently drop a requested root move.

**Resolved: bounded body preflight.** `src/services/execution-budget.ts:114–175` uses the remaining wall deadline, an abort controller and an 8-second maximum while reading the request body, including a pre-aborted-signal check. `tests/core_reliability.test.ts:220–264` checks stalled input and caller abort; both require zero submissions and zero write attempts. All responses are size-bounded and outbound redirects are not automatically followed.

**Resolved: legacy and response handling.** Removed the obsolete 17-tool files/tests/service methods. `src/tools/index.ts` enumerates 26 v3 tools. Acknowledged writes keep known status when result data exceeds 2 MiB; unacknowledged writes are not retried or mislabeled as succeeded. `tests/v3_mutation_contract.test.ts`, `tests/v3_result_limit.test.ts`, and `tests/retry_safety.test.ts` cover these distinctions.

**Residual operational limitation (not a #118 code defect):** a successful Wrangler dry-run or fixed request/byte budgets alone do not establish Cloudflare Free-plan CPU/memory usage under full load. That evidence remains in #119.

## Spec axis — #110 / #118 functional contract

**Resolved: active OpenAPI and generated types.** The YAML has exactly 16 route shapes; it removes historical wrong or unused paths, adds GET `/collections/childrens`, DELETE `/collection/-99`, global PUT/DELETE `/tags`, and scopes GET/PUT/DELETE `/tags/{collectionId}` correctly. It drops unsupported DELETE `/raindrop/{id}` and POST `/highlights`. The declaration was regenerated with the pinned `openapi-typescript` command, and the deterministic `check:schema` passed in [CI #35515414295](https://github.com/lirtual/mcp-workers/actions/runs/35515414295). Historical unused **component models** remain, but are not advertised as supported operations. The temporary one-off schema-sync workflow was removed after committing the generated declaration.

**Resolved: public tools/resources/prompts.** `tests/tool_contract.test.ts` and `tests/v3_resource_contract.test.ts` verify exact 26-tool discovery, input/output schemas through an MCP Client, strict full-string resource IDs and separate templates. Legacy Sampling/elicitation claims were removed, migration is described in README, and `docs/api-coverage.md` separates implementation, offline and live evidence.

**Partial live evidence belongs to #119, not #118.** The isolated test Worker passed direct `/mcp` smoke, scoped bookmark and collection lifecycle, tag and highlight operations, cross-collection isolation, safety gates and exact-ID Trash deletion. The entitlement-gated duplicate/broken filters returned `FEATURE_UNAVAILABLE`, and both unverified destructive/root-move gates remain closed. The user requested **no Portal testing**; none is claimed. Refer to `docs/live-acceptance-119.md`. Production remains on v2.4.5.

## Exit and remaining gates

- [x] Contract source, generated types, request signatures and deterministic schema check align.
- [x] Stalled preflight/abort and no-submit regression tests are present.
- [x] Last code-changing commit `a4486585` passed application checks (typecheck, lint, offline tests, schema, Wrangler dry-run) in [CI #35515414295](https://github.com/lirtual/mcp-workers/actions/runs/35515414295).
- [ ] Obtain an independent Standards and Spec review of the final PR diff. The follow-up manual review identified/fixed ingress cancellation and was verified against `e2d161c2`; it does not constitute two isolated reviewers.
- [ ] Keep PR #120 Draft pending remaining #119 live/resource evidence and explicit production release decision. Never treat this review as permission to clear an existing account Trash.
