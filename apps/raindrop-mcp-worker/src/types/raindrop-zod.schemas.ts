import { z } from "zod";

/**
 * Input schema for managing Raindrop collections (CRUD).
 * @see {@link https://developer.raindrop.io/}
 */
export const CollectionManageInputSchema = z.object({
  operation: z.enum(["create", "update", "delete"]),
  id: z.number().optional(),
  title: z.string().optional(),
  parentId: z.number().optional(),
});

/**
 * Input schema for Raindrop bookmark tools.
 * @see {@link https://developer.raindrop.io/} for API details.
 */
export const BookmarkInputSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  tags: z.array(z.string()).optional(),
  important: z.boolean().optional(),
  collectionId: z.number().optional(),
  description: z.string().optional(),
});

/**
 * Output schema for Raindrop bookmark tools.
 * @see {@link https://developer.raindrop.io/}
 */
export const BookmarkOutputSchema = z.object({
  id: z.number(),
  url: z.string().url(),
  title: z.string(),
  tags: z.array(z.string()).optional(),
  important: z.boolean().optional(),
  collectionId: z.number().optional(),
  description: z.string().optional(),
  media: z.array(z.object({ link: z.string().url() })).optional(),
  cache: z
    .object({
      status: z.enum(["ready", "retry", "failed"]),
      size: z.number(),
      created: z.string(),
    })
    .optional(),
});

/**
 * Input schema for Raindrop collection tools.
 * @see {@link https://developer.raindrop.io/}
 */
export const CollectionInputSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  parentId: z.number().optional(),
});

/**
 * Output schema for Raindrop collection tools.
 * @see {@link https://developer.raindrop.io/}
 */
export const CollectionOutputSchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string().optional(),
  color: z.string().optional(),
  parentId: z.number().optional(),
});

// Official highlight IDs are opaque strings, scoped to a positive bookmark ID.
export const HighlightBookmarkIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const HighlightIdSchema = z.string().min(1).refine(value => value.trim() === value);
export const HighlightColorSchema = z.enum([
  "blue", "brown", "cyan", "gray", "green", "indigo", "orange", "pink",
  "purple", "red", "teal", "yellow",
]);
const HighlightFields = {
  text: z.string().refine(value => value.trim().length > 0, "text must not be empty"),
  color: HighlightColorSchema.optional(),
};
export const HighlightCreateFieldsSchema = z.strictObject(HighlightFields);
export const HighlightUpdateFieldsSchema = z.strictObject({
  ...HighlightFields,
  text: HighlightFields.text.optional(),
}).refine(value => Object.values(value).some(field => field !== undefined), "Provide at least one update field");
export const HighlightInputSchema = z.strictObject({
  bookmarkId: HighlightBookmarkIdSchema, ...HighlightFields,
});
export const HighlightRecordSchema = z.object({
  _id: HighlightIdSchema,
  text: z.string(),
  note: z.string().optional(),
  color: HighlightColorSchema.optional(),
}).passthrough();
export const HighlightOutputSchema = z.object({
  id: HighlightIdSchema,
  bookmarkId: HighlightBookmarkIdSchema,
  text: z.string(),
  note: z.string().optional(),
  color: HighlightColorSchema.optional(),
});
export const HighlightWriteOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"), bookmarkId: HighlightBookmarkIdSchema,
    highlightId: HighlightIdSchema, highlight: HighlightRecordSchema.nullable(),
    deleted: z.boolean(),
  }),
  z.object({
    status: z.literal("unknown"), bookmarkId: HighlightBookmarkIdSchema,
    highlightId: HighlightIdSchema.optional(), reason: z.string(),
  }),
]);

/**
 * Input schema for Raindrop tag tools.
 * @see {@link https://developer.raindrop.io/}
 */
export const TagScopeSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const TagNameSchema = z
  .string()
  .min(1)
  .refine(
    (name) => name.trim() === name && name.trim().length > 0,
    "Tag names must be nonempty and have no surrounding whitespace",
  );
export const TagNamesSchema = z
  .array(TagNameSchema)
  .min(1)
  .refine(
    (names) => new Set(names).size === names.length,
    "Tag names must be distinct",
  );
export const TagListInputSchema = z.strictObject({
  collectionId: TagScopeSchema.optional(),
});
export const TagRenameInputSchema = z.strictObject({
  collectionId: TagScopeSchema,
  oldName: TagNameSchema,
  newName: TagNameSchema,
});
export const TagMergeInputSchema = z.strictObject({
  collectionId: TagScopeSchema,
  tagNames: TagNamesSchema.refine(
    (names) => names.length >= 2,
    "Merge requires at least two sources",
  ),
  newName: TagNameSchema,
});
export const TagDeleteInputSchema = z.strictObject({
  collectionId: TagScopeSchema,
  tagNames: TagNamesSchema,
});
export const TagInputSchema = z.discriminatedUnion("operation", [
  TagDeleteInputSchema.extend({ operation: z.literal("delete") }),
  TagMergeInputSchema.extend({ operation: z.literal("merge") }),
  z.strictObject({
    operation: z.literal("rename"),
    collectionId: TagScopeSchema,
    tagNames: z.array(TagNameSchema).length(1),
    newName: TagNameSchema,
  }),
]);

/**
 * Output schema for Raindrop tag tools.
 * @see {@link https://developer.raindrop.io/}
 */
export const TagOutputSchema = z.object({
  tagNames: z.array(z.string()),
  success: z.boolean(),
});

/**
 * Output schema for diagnostics tool.
 * @see {@link https://github.com/modelcontextprotocol/typescript-sdk}
 */
export const DiagnosticsOutputSchema = z.object({
  status: z.string(),
  environment: z.record(z.string(), z.any()).optional(),
});

/**
 * Schema for Raindrop tag objects.
 * @see {@link https://developer.raindrop.io/}
 */
// ...existing code...

export const tagSchema = z.object({
  _id: z.string(),
  count: z.number().optional(),
  name: z.string().optional(),
});

// Explicit, collection-scoped bulk writes only. Never accept search or nesting.
const BatchPositiveIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const BatchIdsSchema = z.array(BatchPositiveIdSchema).min(1).max(50).refine(
  ids => new Set(ids).size === ids.length, "IDs must be unique",
);
export const BookmarkBatchDeleteInputSchema = z.strictObject({
  collectionId: BatchPositiveIdSchema,
  ids: BatchIdsSchema,
});
export const BookmarkBatchUpdateInputSchema = z.strictObject({
  ...BookmarkBatchDeleteInputSchema.shape,
  tagsToAdd: TagNamesSchema.optional(),
  clearTags: z.literal(true).optional(),
  destinationCollectionId: BatchPositiveIdSchema.optional(),
  important: z.boolean().optional(),
}).refine(
  args => !(args.tagsToAdd !== undefined && args.clearTags !== undefined),
  "tagsToAdd and clearTags are mutually exclusive",
).refine(
  args => [args.tagsToAdd, args.clearTags, args.destinationCollectionId, args.important]
    .some(value => value !== undefined),
  "Provide at least one change",
);
export const BookmarkBatchOutcomeSchema = z.object({
  status: z.enum(["failed", "unknown"]),
  reason: z.string(),
  dispatched: z.boolean(),
  acknowledged: z.boolean(),
  modified: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  succeeded: z.array(BatchPositiveIdSchema),
  failed: z.array(BatchPositiveIdSchema),
  unknown: z.array(BatchPositiveIdSchema),
  notExecuted: z.array(BatchPositiveIdSchema),
});

// T07: confirmation binds a fresh snapshot, not an authorization token or lock.
const CollectionDeleteIdSchema = z.number().int().positive().safe();
const CollectionDeleteIdsSchema = z.array(CollectionDeleteIdSchema).max(60).refine(
  ids => ids.every((id, index) => index === 0 || ids[index - 1]! < id),
  "IDs must be unique and sorted ascending",
);
const CollectionDigestSchema = z.string().regex(/^collection-deletion:sha256:[a-f0-9]{64}$/);
const CollectionConfirmationShape = {
  confirm: z.literal(true),
  expectedTotal: z.number().int().nonnegative().safe(),
  collectionIds: CollectionDeleteIdsSchema,
  digest: CollectionDigestSchema,
};
export const CollectionDeleteInputSchema = z.union([
  z.strictObject({ id: CollectionDeleteIdSchema, confirm: z.literal(false).optional() }),
  z.strictObject({ id: CollectionDeleteIdSchema, ...CollectionConfirmationShape }),
]);
export const CollectionRemoveEmptyInputSchema = z.union([
  z.strictObject({ rootId: CollectionDeleteIdSchema, confirm: z.literal(false).optional() }),
  z.strictObject({ rootId: CollectionDeleteIdSchema, ...CollectionConfirmationShape }),
]);
export const CollectionDeletionMemberSchema = z.strictObject({
  id: CollectionDeleteIdSchema,
  parentId: CollectionDeleteIdSchema.nullable(),
  title: z.string(),
  count: z.number().int().nonnegative().safe(),
});
export const CollectionDeletionOutputSchema = z.strictObject({
  preview: z.boolean(),
  rootId: CollectionDeleteIdSchema,
  target: CollectionDeletionMemberSchema,
  total: z.number().int().nonnegative().safe().describe("Number of approved collection IDs"),
  collectionIds: CollectionDeleteIdsSchema,
  // Complete verified scoped subtree, including root, in ascending ID order.
  collections: z.array(CollectionDeletionMemberSchema),
  bookmarkCount: z.number().int().nonnegative().safe().describe("Verified direct bookmark total across the complete scoped subtree; empty-leaf deletion affects zero bookmarks"),
  digest: CollectionDigestSchema,
  succeeded: z.array(CollectionDeleteIdSchema),
  failed: z.array(CollectionDeleteIdSchema),
  unknown: z.array(CollectionDeleteIdSchema),
  notExecuted: z.array(CollectionDeleteIdSchema),
  reason: z.string(),
});
