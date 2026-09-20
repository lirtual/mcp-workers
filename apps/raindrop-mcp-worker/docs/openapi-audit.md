# v3 OpenAPI source audit (2026-09-20)

Scope: approved [spec #110](https://github.com/lirtual/mcp-workers/issues/110), contract ticket [#118](https://github.com/lirtual/mcp-workers/issues/118). This is an **audit of the existing YAML**, not acceptance of its current generated types.

The historically named `raindrop-complete.yaml` currently declares 43 route keys. The v3 code actually uses the following **16** documented route shapes (some with multiple HTTP methods). The audit found two absent route keys, and two missing methods on a present key. All path/method decisions below are about the restricted v3 MCP scope, not a claim that other official Raindrop endpoints do not exist.

| Scope | Required method and exact path | Existing YAML |
| --- | --- | --- |
| User | GET `/user`; GET `/user/stats` | Both present |
| Collections | GET `/collections`; GET `/collections/childrens`; POST `/collection`; GET/PUT/DELETE `/collection/{id}`; DELETE `/collection/-99` | **Missing** `/collections/childrens` and `/collection/-99` |
| Bookmarks | GET/PUT/DELETE `/raindrops/{collectionId}`; POST `/raindrop`; GET/PUT `/raindrop/{id}` | Present; remove unrelated DELETE `/raindrop/{id}` from generated v3 scope |
| Suggestions | POST `/raindrop/suggest`; GET `/raindrop/{id}/suggest` | Both present |
| Highlights | GET `/highlights`; GET `/highlights/{collectionId}`; write through PUT `/raindrop/{id}` | Present; remove unused POST `/highlights` |
| Tags | GET/PUT/DELETE `/tags` and `/tags/{collectionId}` | **Missing PUT and DELETE** on global `/tags` |

The two missing collection routes and global tag methods are in the official [collection methods](https://developer.raindrop.io/v1/collections/methods) and [tags API](https://developer.raindrop.io/v1/tags). The singleton and scoped bulk bookmark routes are in the official [single](https://developer.raindrop.io/v1/raindrops/single) and [multiple](https://developer.raindrop.io/v1/raindrops/multiple) API documentation.

## Unused YAML routes to remove from the v3 generation source

The following 29 historical keys are *not* called by the 26 v3 tools. The first group also contains known mismatches with the current official endpoint mapping; do not retain it to imply support:

- Known wrong/obsolete for this contract: `/collections/{parentId}/childrens`, `/collection/-99/clear`, `/raindrops/single`, `/raindrops/multiple`, `/raindrops/suggest`, `/raindrops/move`, `/raindrops/tags`, `/raindrops/delete`, `/raindrop/{id}/permanent`, `/raindrop/{id}/highlights`, `/highlights/{id}`, `/tags/0`.
- Unsupported capabilities or historical aliases (not necessarily nonexistent official endpoints): `/collections/sort`, `/collections/collapsed`, `/collections/clean`, `/collection/{id}/stats`, `/collection/{id}/sharing`, `/collection/{id}/merge`, `/raindrops/0`, `/raindrops`, `/raindrop/{id}/reminder`, `/raindrop/file`, `/file/{id}`, `/import`, `/import/url`, `/import/status`, `/export`, `/export/status`, `/filters`.

No inactive key should be counted as v3 implementation or tested coverage merely because it exists in the YAML. Likewise, removing an unused path **does not** mean declaring that official endpoint invalid.

## Safe implementation gate

1. Restrict the YAML to documented v3 paths/methods, keeping used response and model schemas and deleting or marking historical unused schemas only when their generated-type consumers are known.
2. Regenerate `src/types/raindrop.schema.d.ts` with the pinned `openapi-typescript` command; commit the YAML **and** exact generated diff together. Do not bypass `check:schema` to hide a mismatch.
3. Replace service `as any` calls for used routes with generated typed calls where feasible; verify real HTTP request/response contract tests independently from generated declarations.
4. Pass frozen-install CI, all 26 tool tests and Wrangler dry-run, then run separate Standards and Spec review. Only after that request #119 isolated live acceptance. No production credentials or data writes are authorized by this audit.

**Current state:** OpenAPI regeneration not completed; the generated file still reflects the historical 43-key YAML. The source-branch 26-tool registration and prior successful CI do not resolve this open item.
