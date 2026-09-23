# Raindrop MCP v4 — T03 SDK read-only tracer evidence (#130)

Date: 2026-09-23. Parent Spec: #127; prerequisite tickets #128/#129; implementation Draft PR #180 stacked onto primary Draft PR #141.

## Implemented and intentionally not implemented

This ticket registers **only** `diagnostics_read({action:"local"})` and `raindrop_read({action:"list",...})` with the existing request-scoped `@modelcontextprotocol/server`. The v3 list Zod schema, list handler, and domain service are reused directly. Existing Portal authentication, 128 KiB bounded ingress, request cancellation, retry/counter budget, tool envelopes, static resources, dynamic resource templates, and prompts remain on the same Worker/SDK path. All **26 frozen v3 tools remain registered** alongside the two tracer tools (28 total during T03). The eventual grouped-v4 22-tool surface is **not** represented by this temporary tracer.

`diagnostics_read.local` cannot opt into upstream access; its request count is zero. `raindrop_read.list` retains v3 page=0, perpage=25 (1–50), collectionId=0, sort=-created, filter/refinement, summary fields, total/hasMore/nextPage, error envelope, and native request counting. Unknown actions/fields are rejected by strict SDK-exposed action schemas. No Raindrop write, delete, batch, cleanup, credential change, sampling or generalized adapter has been added.

## Locked SDK and test contract

- Installed Raindrop package resolution in `pnpm-lock.yaml`: `@modelcontextprotocol/server=2.0.0-beta.5`, `@modelcontextprotocol/client=2.0.0-beta.5`. `apps/raindrop-mcp-worker/package.json` still reports `3.0.0`, which is **application metadata, not source or deployment provenance**.
- Source baseline: primary Draft PR #141 originally `1ac4c3e9251ffc4eaec661029fbd63050c4a8266` (tree `69f9069aa2bc9f000a7f1b15747c851a918977a9`). For T03 measurements, always use **the final independently reviewed exact source SHA of PR #141**, never this historical base SHA or a moving branch label.
- `tests/v4_read_tracer.test.ts` pins the deterministic, synthetic protocol/input and upstream-response fixtures. Its local SDK `Client + InMemoryTransport` tests cover initialization, 28-tool discovery, annotations and strict schemas; the authenticated `worker.fetch` tests cover initialize, tools/list, both tool calls, resources/list/read, prompts/list/get, unauthorized and oversized ingress, invalid action, and in-flight disconnect. The list fixture uses only a synthetic single bookmark and bounded `perpage=1`. A read-only upstream 401 fixture is compared directly to the unchanged v3 envelope. Existing v3 contract and ingress/cancellation suites are also retained.
- GitHub Actions `CI` on intermediate exact commit `10aaa287fc398d8849cf2a1a2a14bb4668c43bb2`: [#35811019986](https://github.com/lirtual/mcp-workers/actions/runs/35811019986), SUCCESS: TypeScript; lint 0 errors, 26 existing warnings; 20 Vitest files / 222 passed / 3 skipped; 14/14 CPU harness unit tests; schema regeneration and Wrangler dry-run. **This does not validate any later documentation/implementation SHA until its own exact CI completes.**
- This fixture is offline / synthetic. It is **not** a production/Portal protocol negotiation transcript, a native Workers CPU sample, an independent code review, or a live account write acceptance. The real Portal's unexposed protocol version/session/abort details stay `Not observable` under the approved #127 amendment, not falsely `Pass`.

## Live evidence and release gates

Last independently queried production snapshot during T03, before any T03 deployment:

| Production Worker | Active deployment | Active version | Traffic |
| --- | --- | --- | --- |
| `raindrop-mcp-worker` | `367c8e27-eb45-4959-949b-49d883917720` | `52a58648-1f94-4f7c-81da-d58face037f0` | 100% |

The old production version remains frozen v3 and is not evidence of the new tracer. The existing T02 workflow `.github/workflows/raindrop-v4-cpu-evidence.yml` is the **only** permitted evidence deploy path: manual exact-reviewed-SHA dispatch, fresh deployment/version preflight, retained rollback identity, unchanged secrets, explicit post-deploy source annotation, fixed 124 read-only observations, native CPU/event correlation, and fail-closed compare-and-set rollback. It must not be dispatched on an unreviewed or ambiguous SHA. No Portal cutover, general v4 release, production merge, or Raindrop mutation is authorized by this ticket.

**Acceptance status at documentation time:** implementation and offline CI evidence available in stacked Draft #180; independent spec/engineering review, sync of the reviewed exact tree to Draft #141, verified new deployment/version, native CPU samples, and real Portal read-only acceptance remain outstanding. #130 and #119 must stay Open until their respective criteria actually have evidence.
