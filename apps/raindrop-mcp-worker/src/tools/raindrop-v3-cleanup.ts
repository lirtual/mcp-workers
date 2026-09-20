import { z } from "zod";
import { defineTool, toolSuccess } from "./common.js";
import type { ToolHandlerContext } from "./common.js";

export const raindropV3CleanupTools = [
  defineTool({
    name: "trash_empty",
    description: "Preview the current Trash count, or explicitly empty the entire Trash via the official endpoint.",
    inputSchema: z.object({ confirm: z.boolean().default(false) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async (args: { confirm: boolean }, { raindropService }: ToolHandlerContext) => {
      if (!args.confirm) {
        const stats = await raindropService.getUserStats();
        return toolSuccess({
          count: stats.trash,
          impact: "Confirmation permanently removes every item in Trash at execution time; preview count is not a snapshot",
        }, { status: "preview", requestCount: raindropService.budget.requestCount },
        "Trash preview only; no deletion submitted");
      }
      // No read-before-write count guard: the preview is not a lock and even a
      // previous zero may be stale. Never replay a submitted destructive write.
      await raindropService.emptyTrashV3();
      return toolSuccess({ modified: null }, {
        status: "succeeded", modified: null,
        requestCount: raindropService.budget.requestCount,
      }, "Official Trash empty request accepted");
    },
  }),
];
