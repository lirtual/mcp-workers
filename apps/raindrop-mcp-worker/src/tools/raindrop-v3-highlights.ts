import { z } from "zod";
import { defineTool, toolSuccess } from "./common.js";
import type { ToolHandlerContext } from "./common.js";
import { NotFoundError, UpstreamError } from "../types/mcpErrors.js";

const id = z.number().int().positive().refine(Number.isSafeInteger, "ID must be a safe positive integer");
const collectionId = z.number().int().refine(
  (value) => Number.isSafeInteger(value) && (value === -1 || value === -99 || value > 0),
  "Collection 0 is not a highlight endpoint",
);
const highlightId = z.string().min(1).refine((v) => v.trim().length > 0, "Highlight _id is required");
const text = z.string().min(1).refine((v) => v.trim().length > 0, "Highlight text must be non-empty");
const color = z.enum([
  "blue", "brown", "cyan", "gray", "green", "indigo",
  "orange", "pink", "purple", "red", "teal", "yellow",
]);
const pageFields = {
  page: z.number().int().safe().min(0).default(0),
  perpage: z.number().int().min(1).max(50).default(25),
};
const listInput = z.object({
  collectionId: collectionId.optional(),
  raindropId: id.optional(),
  ...pageFields,
}).strict().refine(
  (value) => value.collectionId === undefined || value.raindropId === undefined,
  "Choose either collectionId or raindropId",
);
const createInput = z.object({
  raindropId: id,
  text,
  note: z.string().optional(),
  color: color.optional(),
}).strict();
const updateInput = z.object({
  raindropId: id,
  _id: highlightId,
  text: text.optional(),
  note: z.string().optional(),
  color: color.optional(),
}).strict().refine(
  (value) => value.text !== undefined || value.note !== undefined || value.color !== undefined,
  "At least one highlight field must change",
);
const deleteInput = z.object({
  raindropId: id,
  _id: highlightId,
  confirm: z.boolean().default(false),
}).strict();

const pageMeta = (page: number, perpage: number, returned: number, total: number | null) => {
  const hasMore = total === null
    ? returned === 0 || returned < perpage ? false : null
    : (page + 1) * perpage < total;
  return { page, perpage, returned, total, hasMore, nextPage: hasMore === false ? null : page + 1 };
};

export const raindropV3HighlightTools = [
  defineTool({
    name: "highlight_list",
    description: "Page official highlights globally/by collection or page one bookmark's highlights from its complete detail.",
    inputSchema: listInput,
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (args: z.infer<typeof listInput>, { raindropService }: ToolHandlerContext) => {
      let items: unknown[];
      let total: number | null;
      if (args.raindropId !== undefined) {
        const bookmark = await raindropService.getBookmark(args.raindropId, true);
        if (bookmark.highlights !== undefined && !Array.isArray(bookmark.highlights)) {
          throw new UpstreamError("Bookmark highlights are not an array");
        }
        const all = bookmark.highlights ?? [];
        total = all.length;
        items = all.slice(args.page * args.perpage, (args.page + 1) * args.perpage);
      } else {
        const result = await raindropService.listHighlightsV3(args.collectionId, args.page, args.perpage);
        items = result.items;
        total = result.count;
      }
      return toolSuccess(
        { items },
        { ...pageMeta(args.page, args.perpage, items.length, total),
          scope: args.raindropId !== undefined ? { raindropId: args.raindropId } :
            args.collectionId !== undefined ? { collectionId: args.collectionId } : { type: "all" },
          requestCount: raindropService.budget.requestCount },
        `Retrieved ${items.length} highlights`,
      );
    },
  }),
  defineTool({
    name: "highlight_create",
    description: "Add one highlight with PUT /raindrop/{id}, never inventing a generated highlight _id.",
    inputSchema: createInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (args: z.infer<typeof createInput>, { raindropService }: ToolHandlerContext) => {
      const { raindropId, ...highlight } = args;
      const result = await raindropService.mutateHighlightV3(raindropId, "create", highlight);
      return toolSuccess(
        { item: result.item, highlights: result.item?.highlights ?? null },
        { status: "succeeded", requestedIds: [raindropId],
          targetEffectVerified: false, warnings: ["Generated highlight ID not independently identified"],
          requestCount: raindropService.budget.requestCount },
        "Highlight update accepted; inspect returned highlights to identify the new ID",
      );
    },
  }),
  defineTool({
    name: "highlight_update",
    description: "Update only explicit fields on one string-identified highlight, including note-only changes.",
    inputSchema: updateInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (args: z.infer<typeof updateInput>, { raindropService }: ToolHandlerContext) => {
      const { raindropId, ...highlight } = args;
      const result = await raindropService.mutateHighlightV3(raindropId, "update", highlight);
      return toolSuccess(
        { item: result.item, targetId: args._id },
        { status: "succeeded", requestedIds: [raindropId],
          targetEffectVerified: result.targetVerified,
          ...(result.targetVerified ? {} : { warnings: ["Upstream accepted the write but target effect is unverified"] }),
          requestCount: raindropService.budget.requestCount },
        "Single-highlight update submitted",
      );
    },
  }),
  defineTool({
    name: "highlight_delete",
    description: "Preview a target highlight before a confirmed one-element deletion.",
    inputSchema: deleteInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async (args: z.infer<typeof deleteInput>, { raindropService }: ToolHandlerContext) => {
      const current = await raindropService.getBookmark(args.raindropId, true);
      if (!Array.isArray(current.highlights)) {
        throw new UpstreamError("Cannot establish current highlight state");
      }
      const target = current.highlights.find((candidate) => candidate._id === args._id);
      if (!target) throw new NotFoundError("Highlight not found on this bookmark");
      if (!args.confirm) {
        return toolSuccess(
          { targets: [{ raindropId: args.raindropId, _id: args._id, text: target.text }] },
          { status: "preview", requestedIds: [args.raindropId],
            requestCount: raindropService.budget.requestCount },
          "Highlight deletion preview only",
        );
      }
      const result = await raindropService.mutateHighlightV3(
        args.raindropId, "delete", { _id: args._id, text: "" },
      );
      return toolSuccess(
        { item: result.item, targetId: args._id },
        { status: "succeeded", requestedIds: [args.raindropId],
          targetEffectVerified: result.targetVerified,
          ...(result.targetVerified ? {} : { warnings: ["Upstream accepted the write but target effect is unverified"] }),
          requestCount: raindropService.budget.requestCount },
        "Single-highlight deletion submitted",
      );
    },
  }),
];
