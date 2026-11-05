---
name: raindrop
description: Use with the Raindrop MCP plugin to find, inspect, create, edit, organize, or delete Raindrop.io bookmarks, collections, tags, and highlights. Route tasks to its published tools, and reconcile partial or unknown writes without replay.
---

# Raindrop MCP operator

Use the connected **Raindrop** MCP tools. This guide selects a safe route; the live tool descriptions, input schemas, upstream state and the user's authorization remain authoritative. It grants no additional permission.

## Choose the smallest tool

| Goal | Tool route | Completion evidence |
| --- | --- | --- |
| Locate bookmarks | `raindrop_collection_list` as needed -> `raindrop_bookmark_search` -> `raindrop_bookmark_get` | Exact IDs and requested result coverage are known |
| Check for an existing bookmark | `raindrop_bookmark_exists`, then `raindrop_bookmark_get` if needed | Match and scope confirmed before creation |
| Inspect collections, tags or highlights | `raindrop_collection_get`, `raindrop_tag_list`, `raindrop_highlight_list`, `raindrop_bookmark_filters_get` as appropriate | Requested objects and limits observed |
| Create or edit | `raindrop_bookmark_create` / `raindrop_bookmark_update`, `raindrop_collection_create` / `raindrop_collection_update`, or `raindrop_highlight_create` / `raindrop_highlight_update` | Exact target and mutation outcome checked |
| Move or discard bookmarks | `raindrop_bookmark_move` / `raindrop_bookmark_delete`; batch tools only for explicit scoped IDs | Each affected ID verified where evidence permits |
| Rename, merge or delete tags | `raindrop_tag_rename` / `raindrop_tag_merge` / `raindrop_tag_delete` | Exact collection/global scope and resulting state checked |
| Delete highlights or collections | `raindrop_highlight_delete`, `raindrop_collection_delete`, or `raindrop_collection_remove_empty` | Impact reviewed; completed vs unknown effects separated |

## Establish scope before changing data

1. Resolve the exact positive collection ID and bookmark/highlight IDs from the user's identifiers or reads. Search and lists may be paginated or bounded: report incomplete coverage and do not treat missing search results as proof of absence. Use only fields supported by the selected tool's actual schema.
2. Distinguish a single bookmark, collection subtree, tag or highlight. Tag mutations may have global scope (`collectionId: 0`), while positive IDs narrow scope. Do not infer global scope from an omitted parameter.
3. Confirm authorization for the actual write or deletion target. Public sharing, automatic duplicate cleanup, account changes, permanent Trash emptying and arbitrary uploads are not part of the published Agent tools. Do not route to unexposed legacy, suggestion or diagnostic implementations.
4. Bookmark deletion moves items to Trash; collection deletion removes a **subtree** and moves its bookmarks to Trash. Neither is an automatically reversible transaction.

## Destructive and batch operations

- For `raindrop_collection_delete`, preview with `{id}` **without `confirm`**. For `raindrop_collection_remove_empty`, preview with `{rootId}`; it considers only already empty leaves, not parents that become empty later. Review the full collection ID set, count, bookmark impact and scope, then obtain explicit approval. Confirm with the original root field and the exact preview's `expectedTotal`, ascending `collectionIds`, and `digest` plus `confirm: true`. The digest is not authorization or a state lock; refuse changed or incomplete previews.
- `raindrop_bookmark_batch_update` and `raindrop_bookmark_batch_delete` accept **1–50 explicit unique IDs in one positive source collection**, not a whole-collection scan or system collection. Read the selected schema for `tagsToAdd`, `clearTags` and destination ID rules.
- Aggregate acknowledgments cannot identify individual successes. Distinguish `succeeded`, `failed`, `unknown`, and `notExecuted` per ID when evidence allows; do not invent successful IDs or promise multi-request rollback.
- On ordinary updates, send only intended fields. Inspect existing data before conflicting edits when necessary.

## Unknown outcomes and finish

If a write times out, disconnects, or returns ambiguous/partial evidence, **never replay automatically**. Re-read the exact bookmark, collection, tag or highlight and any original receipt. Search indexing may lag: absence is not proof that a write failed. Preserve Unknown for unresolved effects, then obtain further authorization before any potentially duplicate or destructive retry.

Report the selected scope, operation, verified state, partial results, and any Unknown or unperformed real-world check. Stop once evidence supports the requested outcome.
