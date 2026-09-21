# v4 T01 — immutable v3 source and contract baseline

Parent: [Spec #127](https://github.com/lirtual/mcp-workers/issues/127), ticket [#128](https://github.com/lirtual/mcp-workers/issues/128). Frozen source ref: **cc05fc9ecbdac38a57d66856f771583746b0e6df** (v3 Draft PR #120). On 2026-09-21 the owner explicitly approved using the then-unused production Worker for the v3 Portal baseline instead of an isolated test script. That production baseline was deployed and functionally verified; no v4 deployment is claimed here.

This is a factual v3→candidate-v4 **planning and regression fixture**, not a newly registered v4 tool surface, proof of v4 CPU acceptance, or approval to release. The executable manifest is `tests/v4_baseline_contract.test.ts`. Its `V3_TOOL_CONTRACT_MATRIX` has exactly one row per source tool and binds every row to its v4 target/action, live `buildToolConfigs(...).inputSchema`, `ToolEnvelopeSchema`, upstream route and exact request-count semantics, scope, error codes, annotations, feature gate, and focused contract tests. Further per-action discriminated schemas and full migrated tests belong to #133/#134; existing v3 tests remain the behavior authority at T01.

## 26 source tools mapped to 6 pure-read groups + 16 independently exposed mutations

| Candidate group/action | Exact v3 source tool | Existing upstream path and request/scope contract | Important guards / envelope |
| --- | --- | --- | --- |
| `raindrop_read.list` | `raindrop_list` | GET `/raindrops/{collectionId}`; one page, default page=0/perpage=25, cap=50 | Summary only, total nullable, nextPage and requestCount; `score` sort requires search |
| `raindrop_read.get` | `raindrop_get` | GET `/raindrop/{id}` | Exact positive safe ID; full note/highlights and errors |
| `raindrop_read.suggest` | `raindrop_suggest` | GET `/raindrop/{id}/suggest` or POST `/raindrop/suggest` | Exactly one id/link; **read-only business effect even if upstream HTTP POST**; no automatic replay |
| `collection_read.list` | `collection_list` | GET `/collections`, GET `/collections/childrens` | Root/child merge; orphan/cycle warnings and bounded IDs |
| `collection_read.tree` | `collection_tree` | GET `/collections`, GET `/collections/childrens` | Same root/child and warning constraints |
| `collection_read.get` | `collection_get` | GET `/collection/{id}` | Exact ID and original not-found semantics |
| `tag_read.list` | `tag_list` | GET `/tags` or `/tags/{collectionId}` | Omitted collection means global; scope not aliased to 0 |
| `highlight_read.list` | `highlight_list` | GET `/highlights` or `/highlights/{collectionId}` | Scope, exact raindrop filter, pagination and IDs |
| `audit_read.check` | `library_audit` | GET `/user/stats` when gated, GET one `/raindrops/{collectionId}` page and collection metadata as applicable | `kind` = duplicates/broken/untagged/empty_collections; unknown entitlement never interpreted as empty or success; unsupported search gate preserved |
| `diagnostics_read.local` | `diagnostics` | No upstream request by default | Redacted local diagnostics; zero upstream by default |
| `diagnostics_read.upstream` | `diagnostics` | Optional GET `/user/stats` | Explicit opt-in; redact credentials, distinguish unavailable/unknown |
 
Although there are **11 read action selectors**, they map to **10 distinct source tools** because diagnostics has two selectors. Do not count the extra selector as a separate v3 tool. The six group names are candidates under the accepted v4 decision; no current v3 tool has been renamed or removed by T01.

| Independently exposed tool (16) | Existing upstream path / budget and guard |
| --- | --- |
| `raindrop_create` | POST `/raindrop`; allowlisted fields; no uncertain-write replay |
| `raindrop_update` | PUT `/raindrop/{id}`; partial fields only; explicit target |
| `raindrop_delete` | Fresh GET `/raindrop/{id}` then scoped DELETE `/raindrops/{collectionId}`; preview/confirm and source bound |
| `raindrop_bulk_update` | Scoped PUT `/raindrops/{collectionId}`; ≤50 explicit IDs and source |
| `raindrop_bulk_delete` | Scoped DELETE `/raindrops/{collectionId}`; ≤50 IDs, preview/confirm |
| `collection_create` | POST `/collection`; explicit title/parent |
| `collection_update` | PUT `/collection/{id}`; **parent=null feature gate remains disabled** without isolated evidence |
| `collection_delete` | DELETE `/collection/{id}`; full descendant/empty-leaf checks |
| `tag_rename` | PUT `/tags` or `/tags/{collectionId}`; scope and confirmation |
| `tag_merge` | PUT `/tags` or `/tags/{collectionId}`; scope and confirmation |
| `tag_delete` | DELETE `/tags` or `/tags/{collectionId}`; scope and confirmation |
| `highlight_create` | GET/PUT `/raindrop/{id}`; one highlight at a time |
| `highlight_update` | GET/PUT `/raindrop/{id}`; exact string `_id`, preserve others |
| `highlight_delete` | GET/PUT `/raindrop/{id}`; confirm exact target, preserve others |
| `duplicates_delete` | Protected GET/read-before-delete and scoped DELETE; **execution gate off** pending separate live evidence |
| `trash_empty` | GET `/user/stats` preview, DELETE `/collection/-99` only with explicit whole-Trash confirmation; never against existing-account data |

## Executable per-tool contract matrix

The prose tables above explain grouping; the executable authority is `V3_TOOL_CONTRACT_MATRIX` in `tests/v4_baseline_contract.test.ts`. It contains all 26 rows rather than one row per capability family. For every row the test resolves `buildToolConfigs:<tool>.inputSchema` to the actual registered Zod schema, resolves output to `ToolEnvelopeSchema`, checks the exact registered annotations, and cross-checks the six read groups and sixteen independent mutations. The same test requires nonempty route, request-count, scope, error, feature-gate and focused-test fields, so adding or removing a v3 tool fails T01 until the row is updated.

Request counts mean **submitted upstream fetch attempts**. They include each read retry, exclude validation/gated failures before submission, and are capped at 20 per request. A logical GET may be attempted at most four times (initial plus three retries); a submitted POST/PUT/DELETE is never replayed. The complete row summary is:

| v3 tool | v4 target/action | Nominal upstream count | Scope / gate |
| --- | --- | --- | --- |
| `diagnostics` | `diagnostics_read.local\|upstream` | local 0; upstream 1 | Request-local; no gate |
| `raindrop_list` | `raindrop_read.list` | 1 GET | One collection/page; no gate |
| `raindrop_get` | `raindrop_read.get` | 1 GET | One bookmark; no gate |
| `raindrop_create` | `raindrop_create.execute` | 1 POST | One bookmark; no gate |
| `raindrop_update` | `raindrop_update.execute` | 1 PUT | One bookmark; no gate |
| `raindrop_suggest` | `raindrop_read.suggest` | 1 GET or read-like POST | Exactly one ID/link; no gate |
| `raindrop_bulk_update` | `raindrop_bulk_update.execute` | 1 PUT | One source, ≤50 IDs; no gate |
| `raindrop_bulk_delete` | `raindrop_bulk_delete.execute` | preview 0; confirmed 1 DELETE | One source, ≤50 IDs; no gate |
| `raindrop_delete` | `raindrop_delete.execute` | preview 1 GET; confirmed GET+DELETE | Fresh source of one ID; no gate |
| `collection_list` | `collection_read.list` | 2 GET | Complete bounded index; no gate |
| `collection_tree` | `collection_read.tree` | 2 GET | Complete bounded tree; no gate |
| `collection_get` | `collection_read.get` | 1 GET | One collection; no gate |
| `collection_create` | `collection_create.execute` | 1 POST | One collection; no gate |
| `collection_update` | `collection_update.execute` | title 1 PUT; parent 2 GET+PUT; root 0 | One collection; `parent=null` disabled |
| `collection_delete` | `collection_delete.execute` | preview 2 GET; confirmed 2 GET+DELETE | Fresh exact subtree; no gate |
| `tag_list` | `tag_read.list` | 1 GET | Global or one collection; no gate |
| `tag_rename` | `tag_rename.execute` | preview 0; confirmed 1 PUT | Explicit tag scope; no gate |
| `tag_merge` | `tag_merge.execute` | preview 0; confirmed 1 PUT | Explicit tag scope; no gate |
| `tag_delete` | `tag_delete.execute` | preview 0; confirmed 1 DELETE | Explicit tag scope; no gate |
| `highlight_list` | `highlight_read.list` | 1 GET | Global/collection/bookmark page; no gate |
| `highlight_create` | `highlight_create.execute` | 1 PUT | One bookmark/highlight; no gate |
| `highlight_update` | `highlight_update.execute` | 1 PUT | Exact highlight ID; no gate |
| `highlight_delete` | `highlight_delete.execute` | preview 1 GET; confirmed GET+PUT | Exact highlight ID; no gate |
| `library_audit` | `audit_read.check` | untagged 1; Pro/empty 2 GET | One kind/page; entitlement runtime gate |
| `duplicates_delete` | `duplicates_delete.execute` | gated confirm 0; preview 2+N GET, N≤10 | One source/page; execution disabled |
| `trash_empty` | `trash_empty.execute` | preview 1 GET; confirmed 1 DELETE | Entire current Trash; no code gate |

Each executable row additionally lists its concrete upstream paths, maximum retry-aware count, error-code set, exact annotations, and focused `*_contract.test.ts` references. Keeping those values in TypeScript avoids a second, non-resolvable prose schema registry.

**Output and failure contract:** Existing v3 `toolSuccess/toolFailure` return `structuredContent = { ok, data?, error?, meta }`. Preserve upstream error identity, `status` (`succeeded|partial|failed|unknown|not_executed|preview`), requestCount, requested IDs and scope on writes. Unknown submitted writes are never blindly retried; a definite upstream rejection is not reported as an unsubmitted write. Errors and counters are not fabricated. Required schema, scope, pagination, and feature-gate tests remain linked in v3 `tests/*_contract.test.ts` and `docs/api-coverage.md`.

## Runtime and protocol facts vs unverified evidence

- v3 source creates the request-scoped `RaindropMCPService` and `McpServer`, while `toolConfigs`/prepared schemas are module-scoped. Requests must not share credential-bearing mutable server, transport, upstream client, execution budget, cancellation or cache.
- SDK dependency declared by v3 source: `@modelcontextprotocol/server ^2.0.0-beta.5` and `@modelcontextprotocol/client ^2.0.0-beta.5`. Pin the **installed lockfile resolution** in future comparative evidence, not the semver range alone.
- Static resources: `diagnostics://server` and `mcp://user/profile`. Dynamic resource templates: `mcp://collection/{id}` and `mcp://raindrop/{id}`. Prompts: `organize_by_topic`, `find_duplicates`, `export_markdown`.
- **Observed production Portal compatibility (owner-approved):** after the owner refreshed/synchronized the ChatGPT plugin, the real production Portal discovered all 26 v3 tools from frozen source `cc05fc9ecbdac38a57d66856f771583746b0e6df`. `diagnostics` returned v3.0.0, 26 enabled tools and `requestCount=0`; `collection_list` returned four collections; `raindrop_list(perpage=1)` returned one of 503 bookmarks with correct pagination. These were bounded read-only calls. No bookmark, collection, tag, highlight or Trash mutation was submitted. Deployment/version provenance and dated call evidence are retained in #128.
- **Non-blocking Portal observability limitations (owner amendment, 2026-09-21):** the ChatGPT plugin surface does not expose the client-offered/server-returned wire protocol version, MCP session headers, raw initialize capabilities, or abort propagation. `diagnostics.data.protocolVersion=null` correctly means unknown. Those unavailable wire fields are recorded as limitations, not fabricated and not treated as T01/#129 blockers. They may be captured later if platform telemetry exposes them.
- **No v4 Free-plan acceptance claim:** T01 still supplies no native v4 CPU measurement or v4 deployment. Those remain #129 and later acceptance work. The owner authorized production v3 read-only baseline calls because the Worker was not yet in use; that authorization does not authorize destructive acceptance against existing account data.

## T01 actual production Portal evidence

**Evidence source:** one real ChatGPT MCP Portal connection to the owner-approved production v3 Worker running frozen source `cc05fc9ecbdac38a57d66856f771583746b0e6df`. The production deployment replaced the earlier isolated-test plan by explicit owner decision. Direct HTTP and in-memory SDK fixtures remain separate evidence and cannot establish Portal behavior.

The retained evidence is sanitized: it excludes Authorization, cookies, access tokens, session IDs, user IDs, bookmark/tag/note bodies, and full personal URLs. The observable classifications are:

| Evidence | T01 result |
| --- | --- |
| Provenance | **Observed:** production v3 deployment/version identity and frozen source SHA were recorded in #128 before/with the calls. |
| Discovery | **Observed:** refreshed Portal exposed all 26 v3 tools. Offline SDK separately verifies two static resources, two templates and three prompts; Portal UI did not expose a raw discovery transcript for those non-tool capabilities. |
| Safe calls | **Observed:** local `diagnostics` (`requestCount=0`), `collection_list` (four collections), and `raindrop_list(perpage=1)` (one of 503, correct pagination). No write call occurred. |
| Negotiated protocol/capabilities | **Unavailable, non-blocking:** Portal did not expose raw initialize request/response. Never substitute an SDK fixture value. |
| Transport/session headers | **Unavailable, non-blocking:** Portal did not expose raw headers, response framing or session identifier presence. |
| Cancellation propagation | **Unavailable, non-blocking:** the plugin surface did not expose an abort trace. Offline/direct cancellation tests are not relabelled as Portal evidence. |
| Sanitization | **Observed:** only version, counts, tool names, safe operation labels, pagination and status were retained. |

The new `Client + InMemoryTransport` regression verifies offline SDK discovery and local diagnostics without any upstream access. Its `protocolVersion: null` diagnostic value is an explicit **unknown**, not the negotiated version. Existing `tests/worker.security.test.ts` separately checks direct `worker.fetch` authentication/Origin/initialize. Both fixtures remain distinct from the required real Portal session.

## Verification and dependencies

T01 executable regression: `pnpm --filter raindrop-mcp-worker exec vitest run tests/v4_baseline_contract.test.ts`. It is included in the existing `test:local` app check. The test validates all 26 per-tool contract rows, actual schema resolution, grouping, exact annotations, request-budget descriptions, tool discovery/count, resource/prompt metadata and local diagnostics; it does **not** assert a v4 implementation is live. Under the owner amendment, unavailable Portal wire fields do not block #129. If a CI check fails, correct and rerun before marking T01 code ready.

References: [#110](https://github.com/lirtual/mcp-workers/issues/110), [#119](https://github.com/lirtual/mcp-workers/issues/119), [#127](https://github.com/lirtual/mcp-workers/issues/127), [#128](https://github.com/lirtual/mcp-workers/issues/128), [v3 API coverage](./api-coverage.md), [v4 ADR-0002](https://github.com/lirtual/mcp-workers/blob/docs/raindrop-v4-worker-native-decisions/apps/raindrop-mcp-worker/docs/adr/0002-worker-native-free-first.md).
