import { z } from "zod";
import type { ToolHandlerContext } from "./common.js";
import { defineTool, textContent, makeBookmarkLink } from "./common.js";

const LibraryAuditInputSchema = z.object({
  details: z
    .boolean()
    .optional()
    .describe("Include links to the identified bookmarks"),
});

/**
 * Tool to scan the entire library for broken links and duplicates.
 */
const libraryAuditTool = defineTool({
  name: "library_audit",
  description:
    "Scans the entire library for broken links and duplicate bookmarks.",
  inputSchema: LibraryAuditInputSchema,
  handler: async (
    args: z.infer<typeof LibraryAuditInputSchema>,
    { raindropService, reportProgress }: ToolHandlerContext,
  ) => {
    const progress =
      typeof reportProgress === "function" ? reportProgress : () => {};

    progress({ progress: 0, total: 100 });

    // Step 1: Scan for broken links
    progress({ progress: 10, total: 100 });
    const broken = await raindropService.getBookmarks({
      broken: true,
      perPage: 50,
    });

    // Step 2: Scan for duplicates
    progress({ progress: 40, total: 100 });
    const duplicates = await raindropService.getBookmarks({
      duplicates: true,
      perPage: 50,
    });

    // Step 3: Scan for untagged items
    progress({ progress: 70, total: 100 });
    const untagged = await raindropService.getBookmarks({
      notag: true,
      perPage: 50,
    });

    progress({ progress: 100, total: 100 });

    const summary = `Audit Results:\n- Broken links: ${broken.count}\n- Potential duplicates: ${duplicates.count}\n- Untagged items: ${untagged.count}`;
    const content = [textContent(summary)];

    if (args.details) {
      if (broken.items.length > 0) {
        content.push(textContent("\nBroken Links (First 50):"));
        broken.items.forEach((item) => content.push(makeBookmarkLink(item)));
      }
      if (duplicates.items.length > 0) {
        content.push(textContent("\nPotential Duplicates (First 50):"));
        duplicates.items.forEach((item) =>
          content.push(makeBookmarkLink(item)),
        );
      }
      if (untagged.items.length > 0) {
        content.push(textContent("\nUntagged Items (First 50):"));
        untagged.items.forEach((item) => content.push(makeBookmarkLink(item)));
      }
    }

    return { content };
  },
});

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

/** Legacy compatibility entry point: never dispatch a destructive operation. */
const removeDuplicatesTool = defineTool({
  name: "remove_duplicates",
  description: "Legacy read-only guidance. Use bookmark_remove_duplicates with a positive collectionId for preview and exact snapshot confirmation. dryRun:false is forbidden.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: z.object({ dryRun: z.boolean().optional(), skipCache: z.boolean().optional() }).strict(),
  handler: async (args: { dryRun?: boolean }) => {
    if (args.dryRun === false) throw new Error("Legacy deletion disabled. Use bookmark_remove_duplicates preview/confirm with an explicit positive collectionId; nothing deleted.");
    return { content: [textContent("Preview only: no scope scanned and nothing deleted. Use bookmark_remove_duplicates with an explicit positive collectionId, then its exact preview/confirm contract.")] };
  },
});

export const cleanupTools = [
  libraryAuditTool,
  emptyTrashTool,
  cleanupCollectionsTool,
  removeDuplicatesTool,
];
