import { z } from "zod";
import { ValidationError } from "../types/mcpErrors.js";
import { BookmarkInputSchema } from "../types/raindrop-zod.schemas.js";
import type { ToolHandlerContext } from "./common.js";
import {
  defineTool,
  makeBookmarkLink,
  setIfDefined,
  textContent,
} from "./common.js";

const BookmarkSearchInputSchema = z.object({
  search: z.string().max(500).optional().describe("Search text (empty or omitted lists bookmarks)"),
  collection: z.number().int().safe()
    .refine(id => id === 0 || id === -1 || id === -99 || id > 0,
      "Expected a collection ID or a valid read-only system collection")
    .optional().describe("Collection ID; 0=All, -1=Unsorted, -99=Trash"),
  tags: z.array(z.string().trim().min(1).max(100)).max(20).optional().describe("Tags to filter by"),
  important: z.boolean().optional().describe("Filter by favorites (false excludes favorites)"),
  page: z.number().int().min(0).safe().optional().describe("Zero-based page (default 0)"),
  perPage: z.number().int().min(1).max(50).optional().describe("Page size (1–50)"),
  sort: z.enum(["-created", "created", "score", "-sort", "title", "-title", "domain", "-domain"])
    .optional().describe("Official Raindrop sort order"),
  tag: z.string().optional().describe("Single tag to filter by"),
  duplicates: z.boolean().optional().describe("Include duplicate bookmarks"),
  broken: z.boolean().optional().describe("Include broken links"),
  notag: z.boolean().optional().describe("Filter by items without tags"),
  highlight: z.boolean().optional().describe("Only bookmarks with highlights"),
  domain: z.string().optional().describe("Filter by domain"),
  createdStart: z
    .string()
    .optional()
    .describe("Filter by creation date (start, ISO 8601)"),
  createdEnd: z
    .string()
    .optional()
    .describe("Filter by creation date (end, ISO 8601)"),
  media: z
    .enum(["link", "article", "image", "video", "document", "audio"])
    .optional()
    .describe("Filter by media type"),
  skipCache: z
    .boolean()
    .optional()
    .describe("Force a fresh fetch from the API, bypassing the local cache"),
}).strict();

const BookmarkSearchOutputSchema = z.object({
  items: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      url: z.string().url(),
      tags: z.array(z.string()),
    }),
  ),
  count: z.number(),
});

const BookmarkManageInputSchema = BookmarkInputSchema.extend({
  operation: z.enum(["create", "update", "delete"]),
  id: z.number().optional(),
});

const GetRaindropInputSchema = z.object({
  id: z.string().min(1, "Bookmark ID is required"),
  skipCache: z
    .boolean()
    .optional()
    .describe("Force a fresh fetch from the API, bypassing the local cache"),
});

const BookmarkSummarySchema = BookmarkSearchOutputSchema.shape.items.element;

const BookmarkManageOutputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("delete"), deleted: z.literal(true) }),
  z.object({
    operation: z.enum(["create", "update"]),
    bookmark: BookmarkSummarySchema,
  }),
]);

const GetRaindropOutputSchema = z.object({ bookmark: BookmarkSummarySchema });

const ListRaindropsInputSchema = z.object({
  collectionId: z
    .number()
    .describe("Collection ID to list bookmarks from (use 0 for All)"),
  page: z.number().optional().describe("Page number for pagination"),
  perPage: z.number().optional().describe("Items per page (max 50)"),
  sort: z.string().optional().describe("Sort order"),
  skipCache: z
    .boolean()
    .optional()
    .describe("Force a fresh fetch from the API, bypassing the local cache"),
});

const ListRaindropsOutputSchema = z.object({
  items: z.array(BookmarkSummarySchema),
  count: z.number(),
});

const bookmarkSummary = (bookmark: any) => ({
  id: bookmark._id,
  title: bookmark.title || "Untitled",
  url: bookmark.link,
  tags: bookmark.tags || [],
});

const BookmarkGetInputSchema = z.object({
  id: z.number().int().positive()
    .refine(Number.isSafeInteger, "Expected a safe positive integer ID"),
  skipCache: z.boolean().optional(),
}).strict();

const BookmarkGetOutputSchema = z.object({
  bookmark: z.object({
    id: z.number().int().positive(),
    title: z.string(),
    url: z.string().url(),
    tags: z.array(z.string()),
    excerpt: z.string().optional(),
    note: z.string().optional(),
    important: z.boolean().optional(),
    collectionId: z.number().int().positive().optional(),
    highlights: z.array(z.object({
      id: z.string(),
      text: z.string(),
      color: z.string().optional(),
      note: z.string().optional(),
    })).optional(),
  }),
});

const bookmarkGetTool = defineTool({
  name: "bookmark_get",
  description: "Fetch a bookmark by its exact positive integer ID, including available notes and highlights.",
  inputSchema: BookmarkGetInputSchema,
  outputSchema: BookmarkGetOutputSchema,
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (
    args: z.infer<typeof BookmarkGetInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const raw = await raindropService.getBookmark(args.id, args.skipCache);
    const bookmark = {
      id: raw._id,
      title: raw.title || "Untitled",
      url: raw.link,
      tags: raw.tags || [],
      ...(typeof raw.excerpt === "string" ? { excerpt: raw.excerpt } : {}),
      ...(typeof raw.note === "string" ? { note: raw.note } : {}),
      ...(typeof raw.important === "boolean" ? { important: raw.important } : {}),
      ...(typeof raw.collection?.$id === "number" && raw.collection.$id > 0
        ? { collectionId: raw.collection.$id } : {}),
      ...(Array.isArray(raw.highlights)
        ? { highlights: raw.highlights.map((h) => ({
            id: h._id,
            text: h.text,
            ...(typeof h.color === "string" ? { color: h.color } : {}),
            ...(typeof h.note === "string" ? { note: h.note } : {}),
          })) }
        : {}),
    };
    return {
      content: [textContent(`Bookmark ${bookmark.id}: ${bookmark.title}`)],
      structuredContent: { bookmark },
    };
  },
});

// Single URL only: the official exists endpoint returns an aggregate ID list,
// not a proven per-URL mapping for bulk input.
const BookmarkExistsInputSchema = z.object({
  url: z.string().max(2048).url()
    .refine((value) => /^https?:\/\//i.test(value), "Expected an HTTP(S) URL"),
}).strict();

const BookmarkExistsOutputSchema = z.object({
  exists: z.boolean(),
  ids: z.array(z.number().int().positive()),
});

const bookmarkExistsTool = defineTool({
  name: "bookmark_exists",
  description: "Check whether exactly one HTTP(S) URL is already bookmarked, without changing data.",
  inputSchema: BookmarkExistsInputSchema,
  outputSchema: BookmarkExistsOutputSchema,
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (
    args: z.infer<typeof BookmarkExistsInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const result = await raindropService.bookmarkExists(args.url);
    return {
      content: [textContent(result.exists ? "URL is bookmarked" : "URL is not bookmarked")],
      structuredContent: result,
    };
  },
});

const BookmarkFiltersInputSchema = z.object({
  collectionId: z.number().int().safe().min(0).optional()
    .describe("Collection scope; 0 means all bookmarks"),
  tagsSort: z.enum(["-count", "_id"]).optional(),
  search: z.string().max(500).optional(),
}).strict();

const FilterCountSchema = z.number().int().nonnegative();
const NamedFilterSchema = z.object({
  name: z.string(), count: FilterCountSchema,
});
const BookmarkFiltersOutputSchema = z.object({
  filters: z.object({
    broken: FilterCountSchema.optional(),
    duplicates: FilterCountSchema.optional(),
    important: FilterCountSchema.optional(),
    notag: FilterCountSchema.optional(),
    tags: z.array(NamedFilterSchema).optional(),
    types: z.array(NamedFilterSchema).optional(),
  }),
});

const bookmarkFiltersTool = defineTool({
  name: "bookmark_filters_get",
  description: "Read Raindrop's official filter statistics for a collection, without inventing missing counts.",
  inputSchema: BookmarkFiltersInputSchema,
  outputSchema: BookmarkFiltersOutputSchema,
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (
    args: z.infer<typeof BookmarkFiltersInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const filters = await raindropService.getBookmarkFilters(
      args.collectionId ?? 0, args.tagsSort, args.search,
    );
    return {
      content: [textContent("Raindrop filter statistics")],
      structuredContent: { filters },
    };
  },
});

const bookmarkSearchTool = defineTool({
  name: "bookmark_search",
  description:
    "Searches bookmarks with advanced filters, tags, and full-text search.",
  inputSchema: BookmarkSearchInputSchema,
  outputSchema: BookmarkSearchOutputSchema,
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (
    args: z.infer<typeof BookmarkSearchInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const query: Record<string, unknown> = {};
    setIfDefined(query, "search", args.search);
    setIfDefined(query, "collection", args.collection);
    setIfDefined(query, "tags", args.tags);
    setIfDefined(query, "important", args.important);
    setIfDefined(query, "page", args.page);
    setIfDefined(query, "perPage", args.perPage);
    setIfDefined(query, "sort", args.sort);
    setIfDefined(query, "tag", args.tag);
    setIfDefined(query, "duplicates", args.duplicates);
    setIfDefined(query, "broken", args.broken);
    setIfDefined(query, "notag", args.notag);
    setIfDefined(query, "highlight", args.highlight);
    setIfDefined(query, "domain", args.domain);
    setIfDefined(query, "createdStart", args.createdStart);
    setIfDefined(query, "createdEnd", args.createdEnd);
    setIfDefined(query, "media", args.media);

    const result = await raindropService.getBookmarks(
      query as any,
      args.skipCache,
    );

    const content = [textContent(`Found ${result.count} bookmarks`)];
    result.items.forEach((bookmark: any) => {
      content.push(makeBookmarkLink(bookmark));
    });

    return {
      content,
      structuredContent: {
        count: result.count,
        items: result.items.map(bookmarkSummary),
      },
    };
  },
});


const AtomicBookmarkIdSchema = z.number().int().positive().safe();
const AtomicBookmarkUrlSchema = z.string().url().max(2048)
  .refine((url) => /^https?:\/\//i.test(url), "Expected an HTTP(S) URL");
const AtomicBookmarkFieldsSchema = z.object({
  title: z.string().trim().min(1).max(1000).optional(),
  url: AtomicBookmarkUrlSchema.optional(),
  excerpt: z.string().max(10000).optional(),
  note: z.string().max(10000).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  important: z.boolean().optional(),
}).strict();
const BookmarkCreateInputSchema = AtomicBookmarkFieldsSchema
  .omit({ url: true }).extend({
    url: AtomicBookmarkUrlSchema,
    collectionId: AtomicBookmarkIdSchema.optional(),
  }).strict();
const BookmarkUpdateInputSchema = AtomicBookmarkFieldsSchema.extend({
  id: AtomicBookmarkIdSchema,
}).strict().refine(({ id: _id, ...changes }) =>
  Object.values(changes).some((value) => value !== undefined),
  "At least one field must change");
const BookmarkMoveInputSchema = z.object({
  id: AtomicBookmarkIdSchema,
  collectionId: AtomicBookmarkIdSchema,
}).strict();
const BookmarkDeleteInputSchema = z.object({
  id: AtomicBookmarkIdSchema,
  permanent: z.boolean().optional().default(false),
}).strict();

const AtomicMutationStatus = z.enum(["succeeded", "unknown"]);
const AtomicBookmarkMutationOutputSchema = z.object({
  status: AtomicMutationStatus,
  bookmark: BookmarkSearchOutputSchema.shape.items.element.optional(),
  reason: z.string().optional(),
});
const AtomicBookmarkDeleteOutputSchema = z.object({
  status: AtomicMutationStatus,
  id: AtomicBookmarkIdSchema,
  outcome: z.enum(["trashed", "permanently_deleted"]).optional(),
  reason: z.string().optional(),
});
const unverifiedMutationReason =
  "Upstream write outcome is not verified. Read the target before considering a retry.";
const atomicBookmarkWriteResult = async (
  work: () => Promise<unknown>,
) => {
  try {
    const bookmark = await work() as {
      _id: number; title?: string; link: string; tags?: string[];
    };
    if (!Number.isSafeInteger(bookmark?._id) || bookmark._id <= 0)
      return { status: "unknown" as const, reason: unverifiedMutationReason };
    return {
      status: "succeeded" as const,
      bookmark: bookmarkSummary(bookmark),
    };
  } catch {
    // An upstream write might have applied before a network acknowledgement
    // was lost. Never automatically retry or claim rollback.
    return { status: "unknown" as const, reason: unverifiedMutationReason };
  }
};

const bookmarkCreateTool = defineTool({
  name: "bookmark_create",
  description: "Create one bookmark. URL is required; metadata and destination are optional.",
  inputSchema: BookmarkCreateInputSchema,
  outputSchema: AtomicBookmarkMutationOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (
    args: z.infer<typeof BookmarkCreateInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    // Preflight runs outside the write uncertainty handler; a missing or
    // inaccessible destination is a definite precondition failure.
    if (args.collectionId !== undefined)
      await raindropService.getCollection(args.collectionId, true);
    const { collectionId, url, ...fields } = args;
    const result = await atomicBookmarkWriteResult(() =>
      raindropService.createBookmark(collectionId, {
        link: url, ...fields,
      }),
    );
    return { content: [textContent(result.status)], structuredContent: result };
  },
});

const bookmarkUpdateTool = defineTool({
  name: "bookmark_update",
  description: "Update selected fields of one existing, non-Trash bookmark.",
  inputSchema: BookmarkUpdateInputSchema,
  outputSchema: AtomicBookmarkMutationOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (
    args: z.infer<typeof BookmarkUpdateInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const current = await raindropService.getBookmark(args.id, true);
    const sourceId = current.collection?.$id;
    if (typeof sourceId !== "number" || !Number.isSafeInteger(sourceId) ||
        sourceId === -99)
      throw new ValidationError("Bookmark location is unverified or in Trash");
    const { id, url, ...fields } = args;
    const updates = {
      ...fields,
      ...(url !== undefined ? { link: url } : {}),
    };
    const result = await atomicBookmarkWriteResult(async () => {
      const updated = await raindropService.updateBookmark(id, updates);
      // If upstream returns a changed field with a conflicting value,
      // never mark the mutation as confirmed.
      for (const [key, expected] of Object.entries(updates)) {
        if (JSON.stringify(updated[key as keyof typeof updated]) !== JSON.stringify(expected))
          throw new Error("Returned bookmark does not match requested update");
      }
      return updated;
    });
    return { content: [textContent(result.status)], structuredContent: result };
  },
});

const bookmarkMoveTool = defineTool({
  name: "bookmark_move",
  description: "Move exactly one bookmark into one explicitly selected collection.",
  inputSchema: BookmarkMoveInputSchema,
  outputSchema: AtomicBookmarkMutationOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (
    args: z.infer<typeof BookmarkMoveInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const current = await raindropService.getBookmark(args.id, true);
    const sourceId = current.collection?.$id;
    if (typeof sourceId !== "number" || !Number.isSafeInteger(sourceId) ||
        sourceId === -99)
      throw new ValidationError("Bookmark location is unverified or in Trash");
    await raindropService.getCollection(args.collectionId, true);
    const result = await atomicBookmarkWriteResult(async () => {
      const updated = await raindropService.updateBookmark(args.id, {
        collection: { $id: args.collectionId },
      });
      if (updated.collection?.$id !== args.collectionId)
        throw new Error("Destination collection not verified in upstream response");
      return updated;
    });
    return { content: [textContent(result.status)], structuredContent: result };
  },
});

const bookmarkDeleteTool = defineTool({
  name: "bookmark_delete",
  description: "Soft-delete a bookmark; permanent deletion only for a freshly verified Trash bookmark with permanent:true.",
  inputSchema: BookmarkDeleteInputSchema,
  outputSchema: AtomicBookmarkDeleteOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  handler: async (
    args: z.infer<typeof BookmarkDeleteInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const current = await raindropService.getBookmark(args.id, true);
    const sourceCollection = current.collection?.$id;
    if (typeof sourceCollection !== "number" || !Number.isSafeInteger(sourceCollection))
      throw new ValidationError("Cannot verify the bookmark's current collection");
    if (sourceCollection === -99 && !args.permanent)
      throw new ValidationError("Bookmark is already in Trash; permanent:true is required");
    if (sourceCollection !== -99 && args.permanent)
      throw new ValidationError("Permanent deletion is only allowed for Trash bookmarks");
    if (sourceCollection !== -99 && sourceCollection !== -1 && sourceCollection <= 0)
      throw new ValidationError("Bookmark is not in a verified writable collection");
    try {
      await raindropService.deleteBookmark(args.id);
      const outcome = args.permanent ? "permanently_deleted" as const : "trashed" as const;
      return {
        content: [textContent(outcome)],
        structuredContent: { status: "succeeded" as const, id: args.id, outcome },
      };
    } catch {
      return {
        content: [textContent(unverifiedMutationReason)],
        structuredContent: {
          status: "unknown" as const, id: args.id, reason: unverifiedMutationReason,
        },
      };
    }
  },
});


const bookmarkManageTool = defineTool({
  name: "bookmark_manage",
  description:
    "Creates, updates, or deletes bookmarks. Use the operation parameter to specify the action.",
  inputSchema: BookmarkManageInputSchema,
  outputSchema: BookmarkManageOutputSchema,
  handler: async (
    args: z.infer<typeof BookmarkManageInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    switch (args.operation) {
      case "create": {
        if (!args.collectionId)
          throw new Error("collectionId is required for create");
        const createPayload: Record<string, unknown> = {
          link: args.url,
          title: args.title,
        };
        setIfDefined(createPayload, "excerpt", args.description);
        setIfDefined(createPayload, "tags", args.tags);
        setIfDefined(createPayload, "important", args.important);
        const bookmark = await raindropService.createBookmark(
          args.collectionId,
          createPayload as any,
        );
        return {
          content: [textContent(`Created bookmark: ${bookmark.title}`)],
          structuredContent: {
            operation: "create" as const,
            bookmark: bookmarkSummary(bookmark),
          },
        };
      }
      case "update": {
        if (!args.id) throw new ValidationError("id is required for update");
        const updatePayload: Record<string, unknown> = {
          link: args.url,
          title: args.title,
        };
        setIfDefined(updatePayload, "excerpt", args.description);
        setIfDefined(updatePayload, "tags", args.tags);
        setIfDefined(updatePayload, "important", args.important);
        const bookmark = await raindropService.updateBookmark(
          args.id,
          updatePayload as any,
        );
        return {
          content: [textContent(`Updated bookmark: ${bookmark.title}`)],
          structuredContent: {
            operation: "update" as const,
            bookmark: bookmarkSummary(bookmark),
          },
        };
      }
      case "delete": {
        if (!args.id) throw new ValidationError("id is required for delete");
        await raindropService.deleteBookmark(args.id);
        return {
          content: [textContent(`Deleted bookmark ${args.id}`)],
          structuredContent: { operation: "delete" as const, deleted: true },
        };
      }
      default:
        throw new ValidationError(
          `Unsupported operation: ${String(args.operation)}`,
        );
    }
  },
});

const getRaindropTool = defineTool({
  name: "get_raindrop",
  description: "Fetch a single Raindrop.io bookmark by ID.",
  inputSchema: GetRaindropInputSchema,
  outputSchema: GetRaindropOutputSchema,
  handler: async (
    args: z.infer<typeof GetRaindropInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const bookmark = await raindropService.getBookmark(
      parseInt(args.id),
      args.skipCache,
    );
    return {
      content: [makeBookmarkLink(bookmark)],
      structuredContent: { bookmark: bookmarkSummary(bookmark) },
    };
  },
});

const listRaindropsTool = defineTool({
  name: "list_raindrops",
  description: "List Raindrop.io bookmarks for a collection with pagination.",
  inputSchema: ListRaindropsInputSchema,
  outputSchema: ListRaindropsOutputSchema,
  handler: async (
    args: z.infer<typeof ListRaindropsInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const result = await raindropService.getBookmarks(
      {
        collection: args.collectionId,
        page: args.page,
        perPage: args.perPage || 50,
        sort: args.sort,
      },
      args.skipCache,
    );

    const content = [
      textContent(
        `Page ${args.page || 0} - Found ${result.items.length} bookmarks (Total: ${result.count})`,
      ),
    ];
    result.items.forEach((bookmark: any) =>
      content.push(makeBookmarkLink(bookmark)),
    );

    return {
      content,
      structuredContent: {
        count: result.count,
        items: result.items.map(bookmarkSummary),
      },
    };
  },
});

export const bookmarkTools = [
  bookmarkCreateTool,
  bookmarkUpdateTool,
  bookmarkMoveTool,
  bookmarkDeleteTool,
  bookmarkFiltersTool,
  bookmarkGetTool,
  bookmarkExistsTool,
  bookmarkSearchTool,
  bookmarkManageTool,
  getRaindropTool,
  listRaindropsTool,
];
