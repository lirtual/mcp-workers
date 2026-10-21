import { z } from "zod";
import { defineTool, textContent } from "./common.js";

/**
 * The cleanup tool names are deliberately retained. Empty input must never
 * mutate data: show a preview first, then require explicit execution intent.
 */
const emptyTrashTool = defineTool({
  name: "empty_trash",
  description:
    "Legacy preview guidance only. Use trash_empty preview/confirm for irreversible emptying; confirm:true is disabled.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: z.object({ confirm: z.boolean().optional() }).strict(),
  handler: async (args: { confirm?: boolean }) => {
    if (args.confirm === true) throw new Error("Legacy empty_trash deletion disabled. Use trash_empty preview/confirm with collectionId:-99, expectedTotal and digest; nothing deleted.");
    return { content: [textContent("Preview only: Nothing deleted and no scope scanned. Use trash_empty({}) then confirm with collectionId:-99, expectedTotal and the exact digest.")] };
  },
});

const cleanupCollectionsTool = defineTool({
  name: "cleanup_collections",
  description:
    "Legacy preview guidance only; no scope scanned. Use collection_remove_empty with an explicit positive rootId and its preview/confirm contract. confirm:true is disabled.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    confirm: z.boolean().optional().describe("Legacy confirmation is disabled; use collection_remove_empty."),
  }).strict(),
  handler: async (args: { confirm?: boolean }) => {
    if (args.confirm === true) {
      throw new Error("Legacy cleanup_collections deletion disabled. Use collection_remove_empty with an explicit positive rootId and its exact preview/confirm digest; nothing deleted and no scope scanned.");
    }
    return { content: [textContent("Preview guidance only: no scope scanned and nothing deleted. Use collection_remove_empty with an explicit positive rootId, then its exact preview/confirm contract and digest.")] };
  },
});

export const cleanupTools = [
  emptyTrashTool,
  cleanupCollectionsTool,
];
