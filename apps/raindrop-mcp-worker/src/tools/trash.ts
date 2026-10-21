import { z } from "zod";
import {
  TrashEmptyInputSchema,
  TrashEmptyOutputSchema,
} from "../types/trash.schemas.js";
import { defineTool, textContent, type ToolHandlerContext } from "./common.js";

export const trashEmptyTool = defineTool({
  name: "trash_empty",
  description:
    "Preview the complete Trash (-99) membership and SHA-256 digest. Irreversible confirmation requires confirm:true, collectionId:-99, expectedTotal and the exact preview digest. Fresh full enumeration shares a 60 HTTP attempt budget including retries and the single DELETE. Oversized scopes must use bookmark_delete permanent:true with explicit limited IDs. Digest is not a transaction lock: changes between reread and deletion remain possible. Never blindly retry an unknown write outcome.",
  inputSchema: TrashEmptyInputSchema,
  outputSchema: TrashEmptyOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (
    args: z.infer<typeof TrashEmptyInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const result = await raindropService.emptyTrashPreviewFirst(args);
    return { content: [textContent(result.reason)], structuredContent: result };
  },
});
