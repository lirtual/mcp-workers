import { z } from "zod";
import { defineTool, toolSuccess } from "./common.js";
import type { ToolHandlerContext } from "./common.js";

const collectionId = z.number().int().refine(
  (value) => Number.isSafeInteger(value) && (value === -1 || value === -99 || value > 0),
  "Invalid collection ID (0 is not a global alias)",
);
const page = z.number().int().safe().min(0).default(0);
const perpage = z.number().int().min(1).max(50).default(25);
const tag = z.string().min(1).refine((value) => value.trim().length > 0, "Blank tags are not allowed");
const listInput = z.object({ collectionId: collectionId.optional(), page, perpage }).strict();

const scopeFields = {
  scope: z.enum(["all", "collection"]),
  collectionId: collectionId.optional(),
  confirm: z.boolean().default(false),
};
const validScope = (value: { scope: "all" | "collection"; collectionId?: number }) =>
  (value.scope === "all") === (value.collectionId === undefined);

const renameInput = z.object({
  ...scopeFields,
  tags: z.tuple([tag]),
  replace: tag,
}).strict().refine(validScope, { message: "scope=all forbids collectionId; scope=collection requires it" })
  .refine((value) => value.tags[0] !== value.replace, { message: "No-op rename is not allowed" });
const mergeInput = z.object({
  ...scopeFields,
  tags: z.array(tag).min(2).max(50),
  replace: tag,
}).strict().refine(validScope, { message: "scope=all forbids collectionId; scope=collection requires it" })
  .refine((value) => new Set(value.tags).size === value.tags.length, { message: "Merge requires distinct tag names" });
const deleteInput = z.object({
  ...scopeFields,
  tags: z.array(tag).min(1).max(50),
}).strict().refine(validScope, { message: "scope=all forbids collectionId; scope=collection requires it" })
  .refine((value) => new Set(value.tags).size === value.tags.length, { message: "Duplicate tag names are not allowed" });

const scopeMeta = (args: { scope: string; collectionId?: number }) => ({
  scope: args.scope === "all" ? { type: "all" } : { type: "collection", collectionId: args.collectionId },
});

function defineMutationTool(
  name: "tag_rename" | "tag_merge" | "tag_delete",
  inputSchema: z.ZodTypeAny,
  action: "rename" | "merge" | "delete",
) {
  return defineTool({
    name,
    description: "Preview or confirm an official tag mutation within an explicit global or collection scope.",
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async (raw: unknown, { raindropService }: ToolHandlerContext) => {
      // The registered schema already validates and provides defaults. This
      // shape is used only after validation; unknown fields never reach HTTP.
      const args = raw as {
        scope: "all" | "collection"; collectionId?: number;
        tags: string[]; replace?: string; confirm: boolean;
      };
      const scope = scopeMeta(args).scope;
      const targets = args.tags.map((name) => ({ name }));
      if (!args.confirm) {
        return toolSuccess(
          { targets, ...(args.replace === undefined ? {} : { replace: args.replace }),
            impact: "Affected bookmark count is not known; no mutation was submitted" },
          { status: "preview", scope, requestCount: raindropService.budget.requestCount },
          "Tag mutation preview only",
        );
      }
      await raindropService.mutateTagsV3(action, args.tags, args.collectionId, args.replace);
      return toolSuccess(
        { targets, ...(args.replace === undefined ? {} : { replace: args.replace }) },
        { status: "succeeded", modified: null, scope, requestCount: raindropService.budget.requestCount },
        "Official tag mutation accepted",
      );
    },
  });
}

export const raindropV3TagTools = [
  defineTool({
    name: "tag_list",
    description: "Read and locally page official global or single-collection tag metadata.",
    inputSchema: listInput,
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (args: z.infer<typeof listInput>, { raindropService }: ToolHandlerContext) => {
      const all = await raindropService.listTagsV3(args.collectionId);
      const sorted = all.slice().sort((a, b) => a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
      const items = sorted.slice(args.page * args.perpage, (args.page + 1) * args.perpage);
      const hasMore = (args.page + 1) * args.perpage < sorted.length;
      return toolSuccess(
        { items },
        { page: args.page, perpage: args.perpage, returned: items.length,
          total: sorted.length, nextPage: hasMore ? args.page + 1 : null, hasMore,
          scope: args.collectionId === undefined ? { type: "all" } : { type: "collection", collectionId: args.collectionId },
          requestCount: raindropService.budget.requestCount },
        `Retrieved ${items.length} tag records`,
      );
    },
  }),
  defineMutationTool("tag_rename", renameInput, "rename"),
  defineMutationTool("tag_merge", mergeInput, "merge"),
  defineMutationTool("tag_delete", deleteInput, "delete"),
];
