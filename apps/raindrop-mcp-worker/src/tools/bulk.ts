import { z } from "zod";
import { defineTool } from "./common.js";

const BulkEditRaindropsInputSchema = z.object({
  collectionId: z
    .number()
    .describe("Source collection ID where raindrops are currently located"),
  operation: z
    .enum(["update", "remove", "move"])
    .default("update")
    .describe("Action to perform"),
  toCollectionId: z
    .number()
    .optional()
    .describe("Target collection ID for 'move' operation"),
  ids: z
    .array(z.number())
    .optional()
    .describe(
      "Array of raindrop IDs. If omitted for update, all in collection may be affected. Required for remove and move.",
    ),
  important: z.boolean().optional().describe("Mark as favorite (true/false)"),
  tags: z
    .array(z.string())
    .optional()
    .describe("Tags to set. Empty array removes all tags."),
});

const bulkEditRaindropsTool = defineTool({
  name: "bulk_edit_raindrops",
  description:
    "Legacy bulk mutation disabled pending approved contract cutover. Use bookmark_batch_update or bookmark_batch_delete with an explicit positive source collection and 1–50 verified IDs.",
  inputSchema: BulkEditRaindropsInputSchema,
  handler: async (_args: z.infer<typeof BulkEditRaindropsInputSchema>) => {
    // All legacy update/move/remove paths could bypass membership checks or
    // mutate an entire collection without an explicit ID list.
    throw new Error(
      "Legacy bulk_edit_raindrops mutation disabled. Use bookmark_batch_update or bookmark_batch_delete with explicit source collectionId and IDs; nothing modified.",
    );
  },
});

export const bulkTools = [bulkEditRaindropsTool];
