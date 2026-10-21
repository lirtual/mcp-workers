import { z } from "zod";
import {
  BookmarkBatchDeleteInputSchema,
  BookmarkBatchUpdateInputSchema,
  BookmarkBatchOutcomeSchema,
} from "../types/raindrop-zod.schemas.js";
import type { BookmarkBatchOutcome } from "../services/raindrop.service.js";
import { defineTool, textContent, type ToolHandlerContext } from "./common.js";

const annotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
const response = (outcome: BookmarkBatchOutcome) => ({
  content: [textContent(outcome.reason)],
  structuredContent: outcome,
  ...(outcome.status === "failed" ? { isError: true } : {}),
});

export const bookmarkBatchTools = [
  defineTool({
    name: "bookmark_batch_update",
    description:
      "Update 1–50 explicit unique bookmark IDs in one positive source collection after fresh membership checks. tagsToAdd appends nonempty distinct tags; clearTags:true clears all tags (mutually exclusive). destinationCollectionId moves to an existing positive collection. Aggregate results cannot confirm individual IDs; inspect unknown outcomes before any retry. Never automatically replay.",
    inputSchema: BookmarkBatchUpdateInputSchema,
    outputSchema: BookmarkBatchOutcomeSchema,
    annotations,
    handler: async (
      args: z.infer<typeof BookmarkBatchUpdateInputSchema>,
      { raindropService }: ToolHandlerContext,
    ) =>
      response(
        await raindropService.updateBookmarkBatch(
          BookmarkBatchUpdateInputSchema.parse(args),
        ),
      ),
  }),
  defineTool({
    name: "bookmark_batch_delete",
    description:
      "Move 1–50 explicit unique bookmark IDs from one positive source collection to Trash after fresh membership checks. System collections (0, -1, -99) are forbidden. Aggregate results cannot confirm individual IDs; inspect unknown outcomes before any retry. Never automatically replay.",
    inputSchema: BookmarkBatchDeleteInputSchema,
    outputSchema: BookmarkBatchOutcomeSchema,
    annotations,
    handler: async (
      args: z.infer<typeof BookmarkBatchDeleteInputSchema>,
      { raindropService }: ToolHandlerContext,
    ) =>
      response(
        await raindropService.deleteBookmarkBatch(
          BookmarkBatchDeleteInputSchema.parse(args),
        ),
      ),
  }),
];
