# Raindrop MCP v3 API coverage and acceptance evidence

Specification: [#110](https://github.com/lirtual/mcp-workers/issues/110), tickets [#111–#119](https://github.com/lirtual/mcp-workers/issues/111), unified [Draft PR #120](https://github.com/lirtual/mcp-workers/pull/120).

Baseline: `93ff4f343c029aabf1a5a3a56056d0342760037e` (`main` at spec authoring).
This matrix is for the **PR source branch**, not the currently deployed Worker or Portal.

Legend: **Implemented** means source exists; **offline** means local fixtures and
application CI were executed; **live** means calls to a real disposable account
and deployed Worker were observed. These are independent claims. A successful
`pnpm check` / Wrangler dry-run is *not* proof of live behavior or of a Free-plan
CPU/memory load test.

| Capability / tool | HTTP method and upstream path | Input or safety boundaries | Source and offline evidence | Real Raindrop / Portal |
| --- | --- | --- | --- | --- |
| Bookmark read/list: `raindrop_list`, `raindrop_get` | GET `/raindrops/{collectionId}`, GET `/raindrop/{id}` | Strict positive single ID; paged 0–50; summary vs. full detail | Implemented; `raindrop_v3_contract`, `v3_bookmark_contract` fixtures in CI | Not run |
| Bookmark create/update: `raindrop_create`, `raindrop_update` | POST `/raindrop`, PUT `/raindrop/{id}` | Explicit allowlisted writable fields; no replay after submitted write | Implemented; `v3_bookmark_contract` fixtures | Not run |
| Scoped mutations: `raindrop_delete`, `raindrop_bulk_update`, `raindrop_bulk_delete` | GET `/raindrop/{id}` + PUT/DELETE `/raindrops/{collectionId}` | Single source; explicit IDs (≤50); preview and permanent/Trash match | Implemented; `v3_mutation_contract` fixtures | Not run; scope-race protection not a transaction |
| Official suggestions: `raindrop_suggest` | GET `/raindrop/{id}/suggest` or POST `/raindrop/suggest` | Exactly one of ID or link; never invoke Worker Sampling | Implemented; existing v3 contract fixtures | Not run |
| Collections: `collection_list`, `collection_tree`, `collection_get` | GET `/collections`, GET `/collections/childrens`, GET `/collection/{id}` | Both metadata endpoints; ≤1000 unique IDs; orphan/cycle warnings | Implemented; `v3_collection_contract` fixtures | Not run |
| Collection writes: `collection_create`, `collection_update`, `collection_delete` | POST `/collection`, PUT/DELETE `/collection/{id}` | Explicit title/parent only; exact fresh descendants, empty leaf checks | Implemented with gate; `v3_collection_contract` fixtures | Not run; `parent=null` disabled as `FEATURE_UNVERIFIED` |
| Tags: `tag_list`, `tag_rename`, `tag_merge`, `tag_delete` | GET/PUT/DELETE `/tags` or `/tags/{collectionId}` | Explicit scope, no global alias 0; confirm before writes | Implemented; `v3_tag_contract` fixtures | Not run |
| Highlights: `highlight_list`, `highlight_create`, `highlight_update`, `highlight_delete` | GET `/highlights`, GET `/highlights/{collectionId}`, GET/PUT `/raindrop/{id}` | One-element writes by string `_id`; note-only update; no invented ID | Implemented; `v3_highlight_contract` fixtures | Not run |
| Page audit: `library_audit` | GET `/user/stats` when gated; GET `/raindrops/{collectionId}`; GET both collection metadata endpoints | Exactly one kind/page; unknown entitlement != empty list | Implemented; `v3_audit_contract` fixtures | Not run; duplicate/broken search operator unverified |
| Protected duplicates: `duplicates_delete` | GET `/user/stats`, GET `/raindrops/{collectionId}`, GET `/raindrop/{id}`, guarded DELETE `/raindrops/{collectionId}` | ≤10 IDs; fresh detail, source/note/highlight protection; compile-time execution gate **off** | Preview and disabled execution covered by `v3_audit_contract` | Not run; destructive execution unavailable |
| Trash: `trash_empty` | GET `/user/stats` preview; DELETE `/collection/-99` on confirmation | Entire current Trash; count is not a snapshot; do not use on real non-test Trash | Implemented; `v3_cleanup_contract` fixtures | Not run (whole-account destructive operation) |
| Diagnostics, resources, prompts | Optional GET `/user/stats`; GET `/user`; exact GET `/collection/{id}` or `/raindrop/{id}` | Default diagnostics local only; resource full-string ID; templates listed separately | Implemented; `diagnostics_contract`, `v3_resource_contract`, `worker.security` fixtures | Not run |

## Migration and known limitations

The public surface is the 26 names enumerated in `tests/tool_contract.test.ts`.
Legacy names are not registered; clients must refresh discovery on cutover.
The retired v2 tool modules, their obsolete tests and deprecated service
methods have been removed from the source branch. The historical OpenAPI YAML has been reduced to 16 active route shapes
and its generated types regenerated. This is **not** a claim of complete
coverage of the Raindrop REST API.

The filename `raindrop-complete.yaml` is historical and **does not promise
coverage of every Raindrop API**. Its active endpoint set has been audited against the 26-tool scope; unused
historical component models remain in the definition for now. Do not count
those retained models as implementation or live coverage.

## Acceptance remaining

- [x] #118: remove registered legacy tools, unused source and stale tests;
      verify exact 26-tool discovery, schemas, prompts and resources offline.
- [x] #118: restrict to 16 route shapes, regenerate historical OpenAPI types,
      remove `(this.client as any)` REST calls, and pass the deterministic check.
- [ ] #118: record final separate Standards/Spec review against the latest SHA.
- [x] #119 (direct test Worker only): live read/write on test-owned bookmarks,
      collections, scoped tags and highlights, and exact-ID cleanup.
- [ ] #119: entitlement-blocked duplicate/broken semantics and disabled
      destructive gates, Cloudflare Free-plan resource evidence. Portal is
      explicitly outside the owner-authorized direct-MCP test path.
- [ ] Keep both dangerous gates disabled until a reviewed commit records
      passing, dated, isolated evidence. Never destroy pre-existing account data.
