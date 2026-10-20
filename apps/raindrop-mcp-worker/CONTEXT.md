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
- **Q7 — final choice confirmed in round 3:** `trash_empty`, `collection_remove_empty`, and `bookmark_remove_duplicates` are the accepted names for the existing cleanup intents. This naming change does not change their preview-first defaults or deletion protections.
- **Q8=A — justified lightweight reads:** include label listing, highlight listing, official bookmark/filter statistics, and official URL-existence checks in the first-phase design. Exact tool names, input shapes, and official endpoint constraints remain for later rounds; no independent AI or storage service is implied.

**Still open after round 2:** exact full tool inventory, helper schemas and API semantics, batch rules, error outcomes, and rollout acceptance. Subsequent rounds may settle individual tool names before finalizing the inventory.

## Grill With Docs — confirmed third-round decisions (2026-10-20)

- **Q7=A — cleanup tool names:** use `trash_empty`, `collection_remove_empty`, and `bookmark_remove_duplicates` in the replacement MCP contract. These replace the previous awkward candidates; this is a naming decision, not approval to alter the established cleanup safety behavior.
- **Q9=A — bookmark movement:** expose `bookmark_move` for a single explicit move. Use `bookmark_batch_update` for multi-bookmark movement only insofar as its documented, verified official update semantics support it; do not add a redundant `bookmark_batch_move` public tool.
- **Q10=A — tags:** expose four distinct intents: `tag_list`, `tag_rename`, `tag_merge`, and `tag_delete`. Their request shapes and mapping to official API behavior are pending separate technical review.
- **Q11=A — highlights:** expose `highlight_list`, `highlight_create`, `highlight_update`, and `highlight_delete` separately; the implementation must conform to verified official Raindrop API semantics. Specific input and output schemas remain unresolved.

**Still open after round 3:** precise remaining tool inventory, official API-specific mutation behavior and input validation, destructive-operation targeting and safeguards beyond the already settled defaults, output/error schema, and acceptance/release decisions. Later confirmed rounds narrow these points; none authorizes implementation, deployment, merge, or development Tickets.

## Grill With Docs — confirmed fourth-round decisions (2026-10-20)

- **Q12=A — bookmark deletion safety:** `bookmark_delete` means moving an ordinary bookmark to Trash. If the target is already in Trash, refuse by default; permanently remove it only if `permanent: true` is explicitly provided. Do not disguise permanent removal as an ordinary soft delete.
- **Q13=A — collection deletion impact:** `collection_delete` is preview-first. Before execution, preview the affected collection subtree and bookmark counts, including descendants, and require `confirm: true` to execute. Preview is read-only and not a transaction, lock, or guarantee against intervening upstream changes; unverifiable counts must not be presented as verified totals.
- **Q14=A — bulk tag semantics:** public `bookmark_batch_update` must distinguish `tagsToAdd` (append tags) from `clearTags` (remove all tags); conflicting inputs are rejected. It must not claim that the official bulk API supports arbitrary replacement of tags or introduce hidden read/modify/write emulation.
- **Q15=A — tool result shape:** prefer structured results. Return concise, paginated list records; complete detail where requested; and explicit success, failure, unknown-result and not-executed scopes for multi-request writes, based on actual upstream evidence. Do not duplicate full JSON in a long natural-language response.

**Still open after round 4:** exact input validation rules and bounds, names and request shapes for approved helpers, nuanced upstream operation/error cases, final inventory and acceptance/release gates. This round approves documentation only—not code changes, merge, deployment, live writes, or development Tickets.

## Grill With Docs — confirmed fifth-round decisions (2026-10-20)

- **Q16=A — strict input validation and bounded calls:** validate bookmark/collection IDs as integers with explicit recognition of valid reserved collection IDs; do not permissively parse malformed strings. Require non-negative zero-based pages and per-page size no greater than the upstream maximum of 50. Every batch mutation requires an explicit, nonempty ID list, deduplicated before use, plus a bounded per-invocation limit. The exact allowed reserved IDs and batch limit remain technical contract details, not yet chosen numbers.
- **Q17=A — operation-specific schemas:** bookmark creation requires only creation-relevant required fields; updating requires a target ID and at least one explicitly supplied mutable field; deletion accepts only deletion-relevant parameters. Reject unknown fields and fields irrelevant to the chosen action, rather than sharing a permissive universal manage schema.
- **Q18=A — helper names:** name the approved lightweight URL-existence, official filter-statistics, and upstream suggestion operations `bookmark_exists`, `bookmark_filters_get`, and `bookmark_suggest`. Their exact parameter and response shapes still require verification against the Raindrop API; `bookmark_suggest` does not invoke MCP Sampling.
- **Q19=A — current-state preflight for destructive confirmations:** before confirmed deletion, freshly read the target and affected scope. Refuse when material changes or unverifiable scope prevent a safe decision and require another preview. This is a best-effort preflight, not a lock, transaction, or guarantee against changes between check and mutation. Do not add persisted snapshots, approval tokens, or a new server-side confirmation service.

**Still open after round 5:** verification of exact Raindrop endpoints/payloads and special collection IDs, concrete safe limits, error/partial-write reporting contract, and the final public tool inventory and acceptance boundary. These decisions authorize docs only: no implementation, merge, deployment, production data action, or development Tickets.
