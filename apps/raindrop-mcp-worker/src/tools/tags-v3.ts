import { z } from "zod";
import { defineTool, toolSuccess } from "./common.js";
import type { ToolHandlerContext } from "./common.js";

const collectionId = z.number().int().refine(
  (n) => Number.isSafeInteger(n) && (n === -1 || n === -99 || n > 0),
  "Invalid collection ID",
);
const page = z.number().int().safe().min(0).default(0);
const perpage = z.number().int().min(1).max(50).default(25);
const tag = z.string().min(1);
const names = z.array(tag).min(1).max(50).refine(
  (value) => new Set(value).size === value.length, "Names must be distinct",
);
const scope = z.object({
  scope: z.enum(["all", "collection"]),
  collectionId: collectionId.optional(),
}).strict().refine(
  (value) => value.scope === "all" ? value.collectionId === undefined : value.collectionId !== undefined,
  { message: "scope=all forbids collectionId; scope=collection requires it", path: ["collectionId"] },
);
const listSchema = z.object({
  collectionId: collectionId.optional(), page, perpage,
}).strict();
const mutationsBase = z.object({
  scope: z.enum(["all", "collection"]),
  collectionId: collectionId.optional(),
  confirm: z.boolean().default(false),
});
const validScope = (value: { scope: "all" | "collection"; collectionId?: number }) =>
  value.scope === "all" ? value.collectionId === undefined : value.collectionId !== undefined;
const renameSchema = mutationsBase.extend({
  tags: z.tuple([tag]),
  replace: tag,
}).strict().refine(validScope, "Explicit scope does not match collectionId").refine(
  (value) => value.tags[0] !== value.replace, "No-op tag rename",
);
const mergeSchema = mutationsBase.extend({
  tags: names.refine((value) => value.length >= 2, "Merge requires two or more names"),
  replace: tag,
}).strict().refine(validScope, "Explicit scope does not match collectionId").refine(
  (value) => !value.tags.includes(value.replace), "Target must be distinct from source names",
);
const deleteSchema = mutationsBase.extend({
  tags: names,
}).strict().refine(validScope, "Explicit scope does not match collectionId");

async function changeTags(
  action: "put" | "delete",
  args: { scope: "all" | "collection"; collectionId?: number; tags: string[]; replace?: string; confirm: boolean },
  raindropService: ToolHandlerContext["raindropService"],
) {
  const range = args.scope === "all" ? { scope: "all" } : { scope: "collection", collectionId: args.collectionId };
  const targets = args.tags.map((name) => ({ name, ...range }));
  if (!args.confirm) {
    return toolSuccess(
      { targets, ...(args.replace === undefined ? {} : { replace: args.replace }) },
      { status: "preview", scope: range, modified: null, requestCount: raindropService.budget.requestCount },
      "Preview only: tags were not modified",
    );
  }
  const { modified } = await raindropService.mutateTagsV3(
    action, args.tags, args.collectionId, args.replace,
  );
  return toolSuccess(
    { targets, modified },
    { status: "succeeded", modified, scope: range, requestCount: raindropService.budget.requestCount },
    "Tag mutation submitted",
  );
}

export const raindropV3TagTools = [
  defineTool({
    name: "tag_list",
    description: "List official global tags or tags in one collection, with bounded local pagination.",
    inputSchema: listSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (args: z.infer<typeof listSchema>, { raindropService }: ToolHandlerContext) => {
      const items = await raindropService.listTagsV3(args.collectionId);
      items.sort((a, b) => a._id.localeCompare(b._id));
      const start = args.page * args.perpage;
      const current = items.slice(start, start + args.perpage);
      const hasMore = start + current.length < items.length;
      return toolSuccess(
        { items: current },
        { page: args.page, perpage: args.perpage, total: items.length, returned: current.length,
          hasMore, nextPage: hasMore ? args.page + 1 : null,
          scope: args.collectionId === undefined ? { scope: "all" } : { scope: "collection", collectionId: args.collectionId },
          requestCount: raindropService.budget.requestCount },
        `Retrieved ${current.length} tags`,
      );
    },
  }),
  defineTool({
    name: "tag_rename",
    description: "Preview or rename one tag in an explicitly chosen scope.",
    inputSchema: renameSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (args: z.infer<typeof renameSchema>, { raindropService }: ToolHandlerContext) =>
      changeTags("put", args, raindropService),
  }),
  defineTool({
    name: "tag_merge",
    description: "Preview or merge 2–50 distinct tag names into one target in an explicit scope.",
    inputSchema: mergeSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (args: z.infer<typeof mergeSchema>, { raindropService }: ToolHandlerContext) =>
      changeTags("put", args, raindropService),
  }),
  defineTool({
    name: "tag_delete",
    description: "Preview or delete up to 50 explicit tag names in an explicitly chosen scope.",
    inputSchema: deleteSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async (args: z.infer<typeof deleteSchema>, { raindropService }: ToolHandlerContext) =>
      changeTags("delete", args, raindropService),
  }),
];
