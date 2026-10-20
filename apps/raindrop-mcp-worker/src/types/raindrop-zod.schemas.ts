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
  color: z.string().optional(),
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

/**
 * Input schema for Raindrop highlight tools.
 * @see {@link https://developer.raindrop.io/}
 */
export const HighlightInputSchema = z.object({
  bookmarkId: z.number(),
  text: z.string(),
  note: z.string().optional(),
  color: z.string().optional(),
});

/**
 * Output schema for Raindrop highlight tools.
 * @see {@link https://developer.raindrop.io/}
 */
export const HighlightOutputSchema = z.object({
  id: z.number(),
  bookmarkId: z.number(),
  text: z.string(),
  note: z.string().optional(),
  color: z.string().optional(),
});

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
  collectionId: TagScopeSchema.optional(),
  oldName: TagNameSchema,
  newName: TagNameSchema,
});
export const TagMergeInputSchema = z.strictObject({
  collectionId: TagScopeSchema.optional(),
  tagNames: TagNamesSchema.refine(
    (names) => names.length >= 2,
    "Merge requires at least two sources",
  ),
  newName: TagNameSchema,
});
export const TagDeleteInputSchema = z.strictObject({
  collectionId: TagScopeSchema.optional(),
  tagNames: TagNamesSchema,
});
export const TagInputSchema = z.discriminatedUnion("operation", [
  TagDeleteInputSchema.extend({ operation: z.literal("delete") }),
  TagMergeInputSchema.extend({ operation: z.literal("merge") }),
  z.strictObject({
    operation: z.literal("rename"),
    collectionId: TagScopeSchema.optional(),
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
