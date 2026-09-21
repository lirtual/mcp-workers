# v4 T01 — immutable v3 source and contract baseline

Parent: [Spec #127](https://github.com/lirtual/mcp-workers/issues/127), ticket [#128](https://github.com/lirtual/mcp-workers/issues/128). Source ref: **cc05fc9ecbdac38a57d66856f771583746b0e6df** (v3 Draft PR #120). Target only: separate v4 feature branch, no deployed version verified. Date: 2026-09-21.

This is a factual v3→candidate-v4 **planning and regression fixture**, not a newly registered v4 tool surface, proof of CPU/Portal acceptance, or approval to release. The executable manifest is `tests/v4_baseline_contract.test.ts`. Every row below must preserve existing v3 Zod input constraints, `ToolEnvelopeSchema` output semantics, official upstream request budget, errors and guarded feature flags. Further per-action discriminated schemas and full migrated tests belong to #133/#134; existing v3 tests are the input/output/schema authority at T01.

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

**Output and failure contract:** Existing v3 `toolSuccess/toolFailure` return `structuredContent = { ok, data?, error?, meta }`. Preserve upstream error identity, `status` (`succeeded|partial|failed|unknown|not_executed|preview`), requestCount, requested IDs and scope on writes. Unknown submitted writes are never blindly retried; a definite upstream rejection is not reported as an unsubmitted write. Errors and counters are not fabricated. Required schema, scope, pagination, and feature-gate tests remain linked in v3 `tests/*_contract.test.ts` and `docs/api-coverage.md`.

## Runtime and protocol facts vs unverified evidence

- v3 source creates the request-scoped `RaindropMCPService` and `McpServer`, while `toolConfigs`/prepared schemas are module-scoped. Requests must not share credential-bearing mutable server, transport, upstream client, execution budget, cancellation or cache.
- SDK dependency declared by v3 source: `@modelcontextprotocol/server ^2.0.0-beta.5` and `@modelcontextprotocol/client ^2.0.0-beta.5`. Pin the **installed lockfile resolution** in future comparative evidence, not the semver range alone.
- Static resources: `diagnostics://server` and `mcp://user/profile`. Dynamic resource templates: `mcp://collection/{id}` and `mcp://raindrop/{id}`. Prompts: `organize_by_topic`, `find_duplicates`, `export_markdown`.
- **Blocked / no assumed protocol version:** the actual version/capabilities negotiated with the *real* v3 ChatGPT MCP Portal session have not been independently observed in this ticket. Neither source-declared target version nor an in-memory SDK test constitutes real Portal evidence. Record a redacted, dated actual negotiation transcript before claiming compatibility.
- **Blocked / no Free acceptance:** no native CPU measurements, verified v4 deploy ID, or real v4 Portal call exist in this ticket. Isolated deployment/measurement is #129 and later gates. No production Worker, credential, pre-existing bookmark or Trash change is authorized.

## T01 actual Portal protocol evidence capture (BLOCKED until observed)

**Evidence source:** one *real* ChatGPT MCP Portal connection to an explicitly approved, isolated v3 deployment of frozen source `cc05fc9ecbdac38a57d66856f771583746b0e6df`. The v4 implementation branch's package version, a direct HTTP test, SDK client fixture, Portal client configuration, or a `/health` response is **not** evidence of the real Portal's negotiated protocol. Before connecting, independently match the isolated Cloudflare script, deployment/version ID, and source SHA; if exact linkage or a safe isolated connection is unavailable, stop and record **Blocked**. Do not repoint an existing production client or change credentials merely to gather evidence.

Capture only protocol metadata, not secrets or personal account content. In an access-controlled evidence location, retain sanitized request/response metadata and attach a stable reference to #128 with these fields:

| Evidence | Required observation / classification |
| --- | --- |
| Provenance | UTC timestamp; v3 source SHA; isolated script name + deployment/version ID; observer; whether the request traversed *real Portal* or only direct/SDK (separate rows) |
| `initialize` | Actual **client-offered** `params.protocolVersion`, actual **server-returned** `result.protocolVersion` (negotiated value), sanitized client/server info and `result.capabilities`; never substitute the test fixture's `2025-11-25` |
| Transport | Request method/path, HTTP status, Accept/Content-Type, sanitized MCP-Protocol-Version header if present, response JSON versus SSE, MCP-Session-Id presence/absence (never its value), behavior across requests; do not infer statelessness from one response |
| Discovery | HTTP and JSON-RPC status, counts and exact tool names for `tools/list`, resource URIs for `resources/list`, template URIs for `resources/templates/list`, prompt names for `prompts/list`; verify 26 v3 names and known static/templated discovery |
| Read and errors | One bounded, safe `diagnostics` local `tools/call` with requestCount=0; negative no-credential probe and invalid method or invalid input; note whether Portal surfaced/redacted errors as expected |
| Cancellation | Portal-observable cancelled read, if supported; actual abort propagation and no further upstream work must be evidenced, not inferred from offline code |
| Sanitization | Exclude Authorization, cookies, access tokens, session IDs, profile/bookmark/tag bodies, user IDs, complete personal URLs and notes. Preserve only status, error codes, names/counts, protocol metadata and safe operation labels |

Record each row as **Observed / Not observed / Blocked**, with evidence URL and source/deployment identity; do not replace a missing trace with a hypothesized result. Portal UI-only discovery may establish visible tool names but **cannot establish wire-level negotiated protocol, HTTP headers or abort behavior**. If wire-level Portal telemetry is unavailable, mark those fields Blocked even if UI discovery succeeds. If the approved isolated v3 deployment is not the frozen source, collect diagnostic evidence but do not attribute it to T01's frozen baseline.

The new `Client + InMemoryTransport` regression verifies offline SDK discovery and local diagnostics without any upstream access. Its `protocolVersion: null` diagnostic value is an explicit **unknown**, not the negotiated version. Existing `tests/worker.security.test.ts` separately checks direct `worker.fetch` authentication/Origin/initialize. Both fixtures remain distinct from the required real Portal session.

## Verification and dependencies

T01 executable regression: `pnpm --filter raindrop-mcp-worker exec vitest run tests/v4_baseline_contract.test.ts`. Include it in the existing `test:local` app check. Test validates tool discovery/count, read-only annotations, strict schemas, resource/prompt metadata; it does **not** assert a v4 implementation is live. Follow-up #129 remains blocked on explicit v3 actual protocol evidence and isolated Cloudflare/Portal availability when those claims are needed. If a CI check fails, correct and rerun before marking T01 code ready.

References: [#110](https://github.com/lirtual/mcp-workers/issues/110), [#119](https://github.com/lirtual/mcp-workers/issues/119), [#127](https://github.com/lirtual/mcp-workers/issues/127), [#128](https://github.com/lirtual/mcp-workers/issues/128), [v3 API coverage](./api-coverage.md), [v4 ADR-0002](https://github.com/lirtual/mcp-workers/blob/docs/raindrop-v4-worker-native-decisions/apps/raindrop-mcp-worker/docs/adr/0002-worker-native-free-first.md).
