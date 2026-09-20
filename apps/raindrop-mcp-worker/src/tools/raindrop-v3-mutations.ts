import { z } from "zod";
import { defineTool, toolSuccess } from "./common.js";
import type { ToolHandlerContext } from "./common.js";
import { ValidationError } from "../types/mcpErrors.js";

const id = z.number().int().positive().refine(Number.isSafeInteger, "ID must be a safe integer");
const sourceId = z.number().int().refine(
  (value) => Number.isSafeInteger(value) && (value === -1 || value === -99 || value > 0),
  "Use an explicit source collection or Unsorted/Trash",
);
const writableSource = sourceId.refine((value) => value !== -99, "Trash cannot be a bulk-update source");
const destinationId = z.number().int().refine(
  (value) => Number.isSafeInteger(value) && (value === -1 || value > 0),
  "Invalid destination collection",
);
const ids = z.array(id).min(1).max(50).transform((values) => [...new Set(values)]);
const ordinaryDelete = z.object({
  collectionId: sourceId,
  ids,
  confirm: z.boolean().default(false),
  permanent: z.boolean().default(false),
}).strict().refine(
  (value) => value.permanent === (value.collectionId === -99),
  { message: "Trash deletion requires permanent=true; normal deletion requires permanent=false", path: ["permanent"] },
);
const bulkUpdate = z.object({
  collectionId: writableSource,
  ids,
  important: z.boolean().optional(),
  tags: z.array(z.string().min(1)).max(50).optional(),
  collection: z.object({ $id: destinationId }).strict().optional(),
}).strict().refine(
  (value) => value.important !== undefined || value.tags !== undefined || value.collection !== undefined,
  { message: "At least one update field is required" },
).refine(
  (value) => value.collection?.$id !== value.collectionId ||
    value.important !== undefined || value.tags !== undefined,
  { message: "Moving to the source collection without other changes is a no-op" },
);
const singleDelete = z.object({
  id,
  confirm: z.boolean().default(false),
  permanent: z.boolean().default(false),
}).strict();

function mutationMeta(
  requestedIds: number[],
  modified: number | null,
  requestCount: number,
) {
  return {
    status: modified !== null && modified < requestedIds.length ? "partial" : "succeeded",
    requestedIds,
    modified,
    requestCount,
    // One upstream request: only batch-wide status is known; no per-ID claims.
  };
}

export const raindropV3MutationTools = [
  defineTool({
    name: "raindrop_bulk_update",
    description: "Update or move up to 50 explicit bookmarks in one source collection; no automatic retry.",
    inputSchema: bulkUpdate,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (args: z.infer<typeof bulkUpdate>, { raindropService }: ToolHandlerContext) => {
      const { collectionId, ids: selected, ...fields } = args;
      const { modified } = await raindropService.mutateRaindropsV3("update", collectionId, selected, fields);
      return toolSuccess(
        { modified, requestedIds: selected },
        { ...mutationMeta(selected, modified, raindropService.budget.requestCount), scope: { collectionId } },
        "Source-scoped batch update submitted",
      );
    },
  }),
  defineTool({
    name: "raindrop_bulk_delete",
    description: "Preview or delete up to 50 explicit IDs from a single source. Trash requires permanent=true.",
    inputSchema: ordinaryDelete,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async (args: z.infer<typeof ordinaryDelete>, { raindropService }: ToolHandlerContext) => {
      const { collectionId, ids: selected, confirm, permanent } = args;
      const scope = { collectionId, permanent };
      if (!confirm) {
        return toolSuccess(
          { targets: selected.map((itemId) => ({ id: itemId, collectionId })), permanent },
          { status: "preview", requestedIds: selected, modified: null, scope, requestCount: raindropService.budget.requestCount },
          "Preview only: nothing deleted",
        );
      }
      const { modified } = await raindropService.mutateRaindropsV3("delete", collectionId, selected);
      return toolSuccess(
        { modified, requestedIds: selected },
        { ...mutationMeta(selected, modified, raindropService.budget.requestCount), scope },
        "Source-scoped batch delete submitted",
      );
    },
  }),
  defineTool({
    name: "raindrop_delete",
    description: "Read the current bookmark source before previewing or executing one source-scoped delete.",
    inputSchema: singleDelete,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async (args: z.infer<typeof singleDelete>, { raindropService }: ToolHandlerContext) => {
      // Fresh detail is required for every invocation, including confirm=true;
      // a prior preview is not a lock or a source-of-truth at execution time.
      const current = await raindropService.getBookmark(args.id, true);
      const collectionId = (current.collection as { $id?: unknown } | undefined)?.$id;
      if (typeof collectionId !== "number" ||
          !Number.isSafeInteger(collectionId) ||
          !(collectionId === -1 || collectionId === -99 || collectionId > 0)) {
        throw new ValidationError("Current bookmark source is unavailable; no deletion was submitted");
      }
      if (args.permanent !== (collectionId === -99)) {
        throw new ValidationError(
          collectionId === -99
            ? "Trash source requires permanent=true"
            : "Permanent delete is forbidden outside Trash",
        );
      }
      const selected = [args.id];
      if (!args.confirm) {
        return toolSuccess(
          { targets: [{ id: args.id, collectionId }], permanent: args.permanent },
          { status: "preview", requestedIds: selected, modified: null, scope: { collectionId }, requestCount: raindropService.budget.requestCount },
          "Preview only: nothing deleted",
        );
      }
      // Deliberately use source-scoped batch DELETE, never DELETE /raindrop/{id}.
      const { modified } = await raindropService.mutateRaindropsV3("delete", collectionId, selected);
      return toolSuccess(
        { modified, requestedIds: selected },
        { ...mutationMeta(selected, modified, raindropService.budget.requestCount), scope: { collectionId, permanent: args.permanent } },
        "Source-scoped bookmark deletion submitted",
      );
    },
  }),
];
