import { z } from "zod";
import { ToolEnvelopeSchema, defineTool, toolSuccess } from "./common.js";
import type { ToolHandlerContext } from "./common.js";

const positiveId = z.number().int().safe().positive();
const collectionId = z.number().int().safe().refine(
  (id) => id === -99 || id === -1 || id >= 0,
  "Collection must be a nonnegative ID, Unsorted (-1), or Trash (-99)",
);
const writableCollection = z.number().int().safe().refine(
  (id) => id === -1 || id > 0,
  "Destination must be a positive collection ID or Unsorted (-1)",
);
const link = z.url().max(8192);
const fields = {
  link: link.optional(),
  title: z.string().max(1000).optional(),
  excerpt: z.string().max(10000).optional(),
  note: z.string().max(10000).optional(),
  tags: z.array(z.string().max(1000)).max(50).optional(),
  important: z.boolean().optional(),
  collection: writableCollection.optional(),
};
const makeFields = (args: Record<string, unknown>) => {
  const data: Record<string, unknown> = {};
  for (const name of Object.keys(fields)) {
    if (name === "collection") {
      if (args.collection !== undefined) data.collection = { $id: args.collection };
    } else if (args[name] !== undefined) {
      data[name] = args[name];
    }
  }
  return data;
};
const summary = (item: any) => ({
  _id: item._id,
  title: item.title,
  link: item.link,
  excerpt: item.excerpt,
  tags: item.tags,
  important: item.important,
  collection: item.collection,
});
const meta = (context: ToolHandlerContext) => ({
  requestCount: context.raindropService.budget.requestCount,
});

const listSchema = z.object({
  collectionId: collectionId.default(0),
  search: z.string().max(8192).optional(),
  sort: z.enum(["-created", "created", "score", "-sort", "title", "-title", "domain", "-domain"]).default("-created"),
  page: z.number().int().safe().min(0).default(0),
  perpage: z.number().int().safe().min(1).max(50).default(25),
  nested: z.boolean().default(false),
}).strict().refine((args) => args.sort !== "score" || Boolean(args.search?.trim()), {
  path: ["sort"],
  message: "score sorting requires a nonempty search",
});

const list = defineTool({
  name: "raindrop_list",
  description: "List a page of Raindrop bookmarks. The search string accepts official Raindrop filters; page is zero-based.",
  inputSchema: listSchema,
  outputSchema: ToolEnvelopeSchema,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args: z.infer<typeof listSchema>, context: ToolHandlerContext) => {
    const { items, count } = await context.raindropService.listRaindropsV3(args);
    const hasMore = count === null
      ? items.length < args.perpage ? false : null
      : (args.page + 1) * args.perpage < count;
    return toolSuccess(
      { items: items.map(summary) },
      {
        ...meta(context), page: args.page, perpage: args.perpage,
        returned: items.length, total: count, hasMore,
        nextPage: hasMore === false ? null : args.page + 1,
      },
      `Found ${items.length} bookmarks`,
    );
  },
});

const getSchema = z.object({ id: positiveId }).strict();
const get = defineTool({
  name: "raindrop_get",
  description: "Fetch complete documented business fields for one Raindrop, including note, highlights and reminder.",
  inputSchema: getSchema,
  outputSchema: ToolEnvelopeSchema,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args: z.infer<typeof getSchema>, context: ToolHandlerContext) => {
    const item = await context.raindropService.getBookmark(args.id);
    return toolSuccess({ item }, meta(context), "Bookmark fetched");
  },
});

const createSchema = z.object({
  ...fields,
  link,
}).strict();
const create = defineTool({
  name: "raindrop_create",
  description: "Create a bookmark; only documented writable fields are allowed. Defaults to Unsorted.",
  inputSchema: createSchema,
  outputSchema: ToolEnvelopeSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: async (args: z.infer<typeof createSchema>, context: ToolHandlerContext) => {
    const item = await context.raindropService.createRaindropV3(makeFields(args) as Parameters<typeof context.raindropService.createRaindropV3>[0]);
    return toolSuccess({ item }, { ...meta(context), status: "succeeded", requested: 1, succeeded: 1 }, "Bookmark created");
  },
});

const updateSchema = z.object({
  id: positiveId,
  ...fields,
}).strict().refine((args) => Object.keys(fields).some((name) => args[name as keyof typeof fields] !== undefined), {
  message: "At least one writable field must be explicitly supplied",
});
const update = defineTool({
  name: "raindrop_update",
  description: "Update only explicitly supplied writable bookmark fields; never replays a submitted write.",
  inputSchema: updateSchema,
  outputSchema: ToolEnvelopeSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: async (args: z.infer<typeof updateSchema>, context: ToolHandlerContext) => {
    const item = await context.raindropService.updateRaindropV3(args.id, makeFields(args) as Parameters<typeof context.raindropService.updateRaindropV3>[1]);
    return toolSuccess({ item }, { ...meta(context), status: "succeeded", requested: 1, succeeded: 1 }, "Bookmark updated");
  },
});

const suggestSchema = z.object({
  id: positiveId.optional(),
  link: link.optional(),
}).strict().refine((args) => (args.id !== undefined) !== (args.link !== undefined), {
  message: "Supply exactly one of id or link",
});
const suggest = defineTool({
  name: "raindrop_suggest",
  description: "Get official Raindrop suggestions for exactly one bookmark ID or URL; never requests model sampling.",
  inputSchema: suggestSchema,
  outputSchema: ToolEnvelopeSchema,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args: z.infer<typeof suggestSchema>, context: ToolHandlerContext) => {
    const result = await context.raindropService.getSuggestions(args.id ?? args.link!);
    return toolSuccess(result, meta(context), "Raindrop suggestions fetched");
  },
});

export const v3BookmarkTools = [list, get, create, update, suggest];
