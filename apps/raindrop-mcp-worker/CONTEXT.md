# Raindrop MCP Worker

This bounded context exposes a private, lightweight Raindrop.io MCP Worker. It prioritizes correct official API semantics and bounded Cloudflare Worker execution over exhaustive API coverage.

## Language

The canonical public MCP resource nouns are **Bookmark**, **Collection**, **Tag**, **Highlight**, and **Trash**; see [GLOSSARY.md](./GLOSSARY.md). The upstream Raindrop.io API may call a bookmark a *Raindrop*, but that alias does not create a second public MCP resource family. Resource fields and results still follow the verified official API semantics.

**Official API semantics**:
The upstream operation meanings, parameters, paths, and results that the Worker maps into MCP tools. Source code or a local OpenAPI file is not proof that an upstream behavior is valid.

**MCP tool contract**:
The client-visible tool name, input, output, side effects, and error behavior. Tools are organized by resource and explicit action; read, write, delete, and batch operations remain distinct.

**Capability acceptance state**:
The independently recorded states of implementation complete, contract tests passed, and live invocation accepted. Local tests never substitute for live acceptance.

**Preview**:
A read-only description of the current destructive target and expected impact. It is not a lock, transaction, approval system, or guarantee that upstream state will remain unchanged.

**Unknown write result**:
A write that reached the upstream request boundary but did not return enough evidence to determine whether it took effect. Such writes are never automatically replayed.

## Settled boundaries

1. Scope is the reliable core: bookmarks, collections, tags, highlights, searching, explicit bulk operations, and useful lightweight upstream-backed helpers. Add other capabilities only when justified; exhaustive coverage of the Raindrop REST API is not a release criterion.
2. The Worker remains stateless and uses the existing MCP Portal plus separate `MCP_ACCESS_TOKEN` and `RAINDROP_ACCESS_TOKEN` credentials. It does not add D1, R2, KV, Queues, Workflows, or a new credential system.
3. Public MCP tools use `resource_action` naming with `snake_case`; use `bookmark`, not `raindrop`, in public tool names. Separate different read/create/update/delete actions into atomic tools, retain only justified batch actions, and do not mechanically mirror every REST endpoint. Existing names and invocation shapes are not long-term compatibility constraints.
4. List operations are paginated and bounded. Batch writes require one explicit source collection and a non-empty explicit ID list; they never imply an entire collection or cross-collection server-side scan.
5. Writes are not automatically retried or rolled back. Multi-request operations distinguish succeeded, failed, unknown, and not-executed scopes using available upstream evidence.
6. Cleanup is preview-first and target-explicit. Official duplicate detection is reused; custom fuzzy or URL-normalization deduplication is out of scope. Duplicate copies with notes or highlights are skipped by automated cleanup.
7. The Worker retains official Raindrop suggestions but does not orchestrate MCP Sampling or provide a pure AI tag tool. The conversation model owns inference; the Worker owns upstream query and mutation.
8. Live writes are accepted only against dedicated test collections and disposable test data. Account, sharing, import/export, backup, upload, and permanent-copy APIs remain out of scope until separately requested.

The approved specification is published as a GitHub specification issue rather than committed as a repository spec file. The application ADR records the breaking public-contract decision; implementation tickets own concrete tool schemas, limits, tests, and rollout work.

## Grill With Docs — confirmed first-round decisions (2026-10-20)

- **Q1=A — public vocabulary:** `bookmark`, `collection`, `tag`, `highlight`, `trash` are canonical; upstream `raindrop` remains an API term.
- **Q2=A — naming:** default public tool naming is `resource_action`, in `snake_case`.
- **Q3=A — atomicity:** expose distinct operations for distinct read/write/delete intents, while retaining justified bulk operations; do not wrap every action in one `manage(operation)` tool or mirror each HTTP endpoint blindly.
- **Q4=A — scope:** implement reliable core workflows and necessary lightweight helpers first; additional official API families are opt-in, not required for completeness.

**Still open after round 1:** specific tool inventory, overlap consolidation, naming exceptions, and optional helpers. This design process authorizes documentation only—not implementation, release, deployment, or production-data changes.

## Grill With Docs — confirmed second-round decisions (2026-10-20)

- **Q5=A — bookmark query consolidation:** a single `bookmark_search` handles both list and search. An empty query means normal paginated listing; collection, sorting, and supported official filters are inputs. Remove the redundant standalone list surface from the future public contract.
- **Q6=A — collection query consolidation:** use one `collection_list` that supplies enough parent/child information to build a full hierarchy. Do not maintain a second public tree-list tool.
- **Q7 — partially settled:** `trash_empty` is accepted as a clearer resource-first name. The candidate names `collection_delete_empty` and `bookmark_duplicates_remove` were explicitly questioned as unnatural and are **not approved**; final alternatives remain a pending naming decision. Existing preview-first and deletion protections are preserved.
- **Q8=A — justified lightweight reads:** include label listing, highlight listing, official bookmark/filter statistics, and official URL-existence checks in the first-phase design. Exact tool names, input shapes, and official endpoint constraints remain for later rounds; no independent AI or storage service is implied.

**Still open after round 2:** Q7's two cleanup names; exact full tool inventory, helper schemas and API semantics, batch rules, error outcomes, and rollout acceptance. Do not treat proposed names as confirmed until explicitly accepted.
