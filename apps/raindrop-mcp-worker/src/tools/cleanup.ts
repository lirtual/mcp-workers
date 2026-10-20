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
    "Preview the trash count by default; permanently empty the trash only with confirm: true. Deletion is irreversible.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    confirm: z.boolean().optional().describe("Default false: preview only. Set true to permanently empty trash."),
  }).strict(),
  handler: async (
    args: { confirm?: boolean },
    { raindropService }: ToolHandlerContext,
  ) => {
    const stats = await raindropService.getUserStats();
    const trashCount = stats?.trash;
    if (typeof trashCount !== "number" || !Number.isSafeInteger(trashCount) || trashCount < 0) {
      throw new Error("Cannot verify trash count; deletion was not attempted.");
    }
    if (trashCount === 0) {
      return { content: [textContent("Trash is already empty.")] };
    }
    if (args.confirm !== true) {
      return { content: [textContent(
        `Preview only: trash contains ${trashCount} items. Nothing deleted. To permanently empty it, call again with confirm: true.`,
      )] };
    }
    const success = await raindropService.emptyTrash();
    return {
      content: [
        textContent(
          success
            ? `Successfully emptied trash (${trashCount} items removed).`
            : "Trash deletion was not confirmed by Raindrop; outcome may be uncertain. Do not retry blindly.",
        ),
      ],
    };
  },
});

const cleanupCollectionsTool = defineTool({
  name: "cleanup_collections",
  description:
    "Preview collections reporting zero bookmarks by default; remove empty collections only with confirm: true. Actual upstream cleanup may also consider nested collections.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    confirm: z.boolean().optional().describe("Default false: preview only. Set true to remove empty collections."),
  }).strict(),
  handler: async (
    args: { confirm?: boolean },
    { raindropService }: ToolHandlerContext,
  ) => {
    if (args.confirm !== true) {
      // Read both endpoints: /collections excludes nested child collections.
      const [roots, children] = await Promise.all([
        raindropService.getCollections(true),
        raindropService.getAllChildCollections(true),
      ]);
      if (!Array.isArray(roots) || !Array.isArray(children)) {
        throw new Error("Cannot enumerate collections for preview; nothing deleted.");
      }
      const empty = new Map<number, string>();
      let unknown = 0;
      for (const collection of [...roots, ...children]) {
        if (!Number.isSafeInteger(collection._id) || collection._id <= 0) {
          throw new Error("Invalid collection in preview; nothing deleted.");
        }
        if (collection.count === 0) {
          empty.set(collection._id, collection.title);
        } else if (typeof collection.count !== "number" || !Number.isSafeInteger(collection.count) || collection.count < 0) {
          unknown++;
        }
      }
      const lines = [...empty].slice(0, 20).map(([id, title]) => `- ${title} (ID: ${id})`);
      const suffix = empty.size > 20 ? `\n... and ${empty.size - 20} more.` : "";
      return { content: [textContent(
        `Preview only: ${empty.size} collections report zero direct bookmarks; ${unknown} have unverified counts. Nothing deleted.\n${lines.join("\n")}${suffix}\nUpstream cleanup determines the final deletion set, which may differ. To remove empty collections, call again with confirm: true.`,
      )] };
    }
    const success = await raindropService.removeEmptyCollections();
    return {
      content: [
        textContent(
          success
            ? "Empty collections removed successfully."
            : "Empty-collection cleanup was not confirmed by Raindrop; outcome may be uncertain. Do not retry blindly.",
        ),
      ],
    };
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
