import { z } from "zod";
import { defineTool, textContent, toolSuccess } from "./common.js";
import type { ToolHandlerContext } from "./common.js";

const positiveId = z.number().int().positive().refine(Number.isSafeInteger, "ID must be a safe integer");
const collectionId = z.number().int().refine(
  (v) => Number.isSafeInteger(v) && (v === 0 || v === -1 || v === -99 || v > 0),
  "Invalid collection ID",
);
const writableCollectionId = z.number().int().refine(
  (v) => Number.isSafeInteger(v) && (v === -1 || v > 0),
  "Destination must be a collection or Unsorted",
);
const link = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Only HTTP(S) links are supported");
const tags = z.array(z.string().min(1)).max(50);
const writable = {
  link,
  title: z.string().max(1000),
  excerpt: z.string().max(10000),
  note: z.string().max(10000),
  tags,
  important: z.boolean(),
  collection: z.object({ $id: writableCollectionId }).strict(),
};
const sortValues = [
  "+created", "-created", "+title", "-title",
  "+domain", "-domain", "+score", "-score",
] as const;
const listInput = z.object({
  collectionId: collectionId.default(0),
  search: z.string().optional(),
  sort: z.enum(sortValues).default("-created"),
  page: z.number().int().min(0).refine(Number.isSafeInteger).default(0),
  perpage: z.number().int().min(1).max(50).default(25),
  nested: z.boolean().default(false),
}).strict().refine(
  (v) => !v.sort.endsWith("score") || Boolean(v.search?.trim()),
  { message: "Score sorting requires a non-empty search", path: ["sort"] },
);
const createInput = z.object({
  link,
  title: writable.title.optional(),
  excerpt: writable.excerpt.optional(),
  note: writable.note.optional(),
  tags: writable.tags.optional(),
  important: writable.important.optional(),
  collection: writable.collection.optional(),
}).strict();
const updateInput = z.object({
  id: positiveId,
  ...Object.fromEntries(Object.entries(writable).map(([key, value]) => [key, value.optional()])),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== "id"),
  { message: "At least one writable field must be provided" },
);
const getInput = z.object({ id: positiveId }).strict();
const suggestInput = z.object({
  id: positiveId.optional(),
  link: link.optional(),
}).strict().refine((v) => (v.id === undefined) !== (v.link === undefined), {
  message: "Provide exactly one of id or link",
});

const summary = (item: Record<string, unknown>) => {
  const result: Record<string, unknown> = {};
  for (const field of ["_id", "link", "title", "collection", "tags", "important", "type", "created", "lastUpdate"]) {
    if (item[field] !== undefined) result[field] = item[field];
  }
  return result;
};

export const raindropV3Tools = [
  defineTool({
    name: "raindrop_list",
    description: "Read one official page of bookmark summaries. Use the official search expression.",
    inputSchema: listInput,
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (args: z.infer<typeof listInput>, { raindropService }: ToolHandlerContext) => {
      const { items, count } = await raindropService.listRaindropsV3(args);
      const hasMore = count === null
        ? items.length < args.perpage ? false : items.length === 0 ? false : null
        : (args.page + 1) * args.perpage < count;
      return toolSuccess(
        { items: items.map((item) => summary(item as unknown as Record<string, unknown>)) },
        {
          page: args.page, perpage: args.perpage, returned: items.length,
          total: count, hasMore,
          nextPage: hasMore === false ? null : args.page + 1,
          requestCount: raindropService.budget.requestCount,
        },
        `Retrieved ${items.length} bookmarks`,
      );
    },
  }),
  defineTool({
    name: "raindrop_get",
    description: "Read a complete bookmark, including note, highlights and reminder.",
    inputSchema: getInput,
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (args: z.infer<typeof getInput>, { raindropService }: ToolHandlerContext) =>
      toolSuccess(
        { item: await raindropService.getBookmark(args.id) },
        { requestCount: raindropService.budget.requestCount },
        "Bookmark retrieved",
      ),
  }),
  defineTool({
    name: "raindrop_create",
    description: "Create one bookmark with a required HTTP(S) link; defaults to Unsorted.",
    inputSchema: createInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (args: z.infer<typeof createInput>, { raindropService }: ToolHandlerContext) =>
      toolSuccess(
        { item: await raindropService.createRaindropV3(args) },
        { status: "succeeded", requestCount: raindropService.budget.requestCount },
        "Bookmark created",
      ),
  }),
  defineTool({
    name: "raindrop_update",
    description: "Partially update a bookmark using only supplied writable fields.",
    inputSchema: updateInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (args: z.infer<typeof updateInput>, { raindropService }: ToolHandlerContext) => {
      const { id, ...fields } = args;
      return toolSuccess(
        { item: await raindropService.updateRaindropV3(id, fields) },
        { status: "succeeded", requestedIds: [id], requestCount: raindropService.budget.requestCount },
        "Bookmark updated",
      );
    },
  }),
  defineTool({
    name: "raindrop_suggest",
    description: "Return official Raindrop tags and collection suggestions, without MCP AI sampling.",
    inputSchema: suggestInput,
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (args: z.infer<typeof suggestInput>, { raindropService }: ToolHandlerContext) => {
      const data = await raindropService.getSuggestions(args.id ?? args.link!);
      return toolSuccess(
        { item: data.item ?? null },
        { requestCount: raindropService.budget.requestCount },
        "Official suggestions retrieved",
      );
    },
  }),
];
