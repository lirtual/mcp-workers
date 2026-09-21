import { z } from "zod";
import {
  BookmarkBusinessSchema, BusinessId, CollectionBusinessSchema,
  HighlightBusinessSchema, TagBusinessSchema,
} from "../services/business-contracts.js";

// Per-tool data shapes are intentionally open to documented/unknown upstream
// extensions, but the required business containers and identity types are not.
const meta = z.record(z.string(), z.unknown());
const error = z.object({
  code: z.string(), message: z.string(),
  upstreamStatus: z.number().optional(),
  upstreamCode: z.string().optional(),
  retryAfterMs: z.number().optional(),
});
const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();
const item = (record: z.ZodTypeAny) => object({ item: record });
const items = (record: z.ZodTypeAny) => object({ items: z.array(record) });
const target = object({ id: BusinessId, collectionId: z.number().int().optional() });
const targetList = object({ targets: z.array(target), permanent: z.boolean().optional() });
const result = object({ modified: z.number().int().nonnegative().nullable(), requestedIds: z.array(BusinessId) });
const bookmark = BookmarkBusinessSchema;
const collection = CollectionBusinessSchema;
const highlight = HighlightBusinessSchema;
const tag = TagBusinessSchema;
const suggestion = object({
  tags: z.array(z.string()).optional(),
  collections: z.array(object({ $id: z.number().int().refine(Number.isSafeInteger) })).optional(),
});
const collectionTarget = object({ id: BusinessId, count: z.number().nullable() });
const collectionNodes = z.array(object({ _id: BusinessId, title: z.string(), path: z.array(z.string()) }));

const outputData: Record<string, z.ZodTypeAny> = {
  raindrop_list: items(bookmark),
  raindrop_get: item(bookmark),
  raindrop_create: item(bookmark),
  raindrop_update: item(bookmark),
  raindrop_delete: z.union([targetList, result]),
  raindrop_bulk_update: result,
  raindrop_bulk_delete: z.union([targetList, result]),
  raindrop_suggest: item(suggestion.nullable()),
  collection_list: items(object({ _id: BusinessId, title: z.string(), path: z.array(z.string()) })),
  collection_tree: object({ roots: collectionNodes, unattached: collectionNodes }),
  collection_get: item(collection),
  collection_create: item(collection),
  collection_update: item(collection),
  collection_delete: object({ targets: z.array(collectionTarget), descendantIds: z.array(BusinessId), impact: z.string().optional() }),
  tag_list: items(tag),
  tag_rename: object({ targets: z.array(object({ name: z.string() })), replace: z.string().optional(), impact: z.string().optional() }),
  tag_merge: object({ targets: z.array(object({ name: z.string() })), replace: z.string().optional(), impact: z.string().optional() }),
  tag_delete: object({ targets: z.array(object({ name: z.string() })), replace: z.string().optional(), impact: z.string().optional() }),
  highlight_list: items(highlight),
  highlight_create: object({ item: bookmark.nullable(), highlights: z.array(highlight).nullable() }),
  highlight_update: object({ item: bookmark.nullable(), targetId: z.string().min(1) }),
  highlight_delete: z.union([
    // Preview exposes the exact selected string highlight ID, not a bookmark item.
    object({ targets: z.array(object({
      raindropId: BusinessId, _id: z.string().min(1), text: z.string(),
    })) }),
    // Confirmed writes return the acknowledged bookmark (or null if omitted).
    object({ item: bookmark.nullable(), targetId: z.string().min(1) }),
  ]),
  library_audit: items(z.union([bookmark, collection])),
  duplicates_delete: object({
    eligibleIds: z.array(BusinessId),
    skipped: z.array(object({ id: BusinessId, reason: z.string() })),
    modified: z.number().int().nonnegative().nullable().optional(),
  }),
  trash_empty: z.union([
    object({ count: z.number().int().nonnegative().nullable(), impact: z.string() }),
    object({ modified: z.null() }),
  ]),
  diagnostics: object({
    version: z.string(), protocolVersion: z.string().nullable(), runtime: z.string(),
    httpMode: z.string(), enabledTools: z.array(z.string()),
    libraryHealth: z.record(z.string(), z.unknown()).nullable(),
  }),
};

const writeTools = new Set([
  "raindrop_create", "raindrop_update", "raindrop_delete",
  "raindrop_bulk_update", "raindrop_bulk_delete",
  "collection_create", "collection_update", "collection_delete",
  "tag_rename", "tag_merge", "tag_delete",
  "highlight_create", "highlight_update", "highlight_delete",
  "duplicates_delete", "trash_empty",
]);

export function outputSchemaForTool(name: string): z.ZodTypeAny {
  const data = outputData[name];
  if (!data) throw new Error(`Missing business output schema for ${name}`);
  return z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      data: writeTools.has(name) ? z.union([data, z.null()]) : data,
      meta,
    }).strict(),
    z.object({ ok: z.literal(false), error, meta }).strict(),
  ]);
}
