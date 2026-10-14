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
        } else if (!Number.isSafeInteger(collection.count) || collection.count < 0) {
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

/**
 * Candidate eligibility is intentionally fail-closed. The duplicate search
 * returns candidates, not evidence that annotations are safe to discard.
 * Re-fetch every candidate and require explicit empty note/highlight fields.
 */
function safeDuplicateCandidate(
  bookmark: {
    _id?: number;
    link?: unknown;
    note?: unknown;
    highlights?: unknown;
    tags?: unknown;
    important?: unknown;
    reminder?: unknown;
    collection?: { $id?: number };
  },
  id: number,
  collectionId: number,
): boolean {
  return (
    bookmark._id === id &&
    bookmark.collection?.$id === collectionId &&
    typeof bookmark.link === "string" &&
    bookmark.link.length > 0 &&
    bookmark.note === "" &&
    Array.isArray(bookmark.highlights) &&
    bookmark.highlights.length === 0 &&
    Array.isArray(bookmark.tags) &&
    bookmark.tags.length === 0 &&
    bookmark.important === false &&
    bookmark.reminder == null
  );
}

const removeDuplicatesTool = defineTool({
  name: "remove_duplicates",
  description:
    "Preview verified unannotated duplicates by default (dryRun: true). Set dryRun: false to delete. Within EACH collection, retain at least one copy of each exact URL; never deduplicate across collections. Only candidates with explicitly empty notes, highlights and tags, important=false, no reminder and confirmed collection membership may be removed. Recheck before deletion, batches of at most 50, and no automatic retries.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z
    .object({
      dryRun: z.boolean().optional().describe("Default true: preview only. Set false to delete verified duplicates."),
      skipCache: z.boolean().optional().describe("Bypass the read cache when discovering duplicate candidates."),
    })
    .strict(),
  handler: async (
    args: { dryRun?: boolean; skipCache?: boolean },
    { raindropService, reportProgress }: ToolHandlerContext,
  ) => {
    const progress =
      typeof reportProgress === "function" ? reportProgress : () => {};
    progress({ progress: 0, total: 100 });

    // Query the official duplicate filter; use fresh details below regardless
    // of the caller's skipCache choice.
    const globalDuplicates = await raindropService.getBookmarks(
      { duplicates: true, perPage: 1 },
      args.skipCache,
    );
    if (globalDuplicates.count === 0) {
      return { content: [textContent("No duplicates found in the library.")] };
    }

    // Raindrop's 0 means ALL bookmarks, not Unsorted, and cannot be used
    // for bulk deletion. -1 is Unsorted; positive IDs are real collections.
    const roots = await raindropService.getCollections(args.skipCache);
    const children = await raindropService.getAllChildCollections(args.skipCache);
    if (!Array.isArray(roots) || !Array.isArray(children)) {
      throw new Error("Cannot enumerate all collections; nothing deleted.");
    }
    const knownIds = new Set<number>([-1]);
    for (const collection of [...roots, ...children]) {
      const id = collection._id;
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error("Invalid collection id in duplicate scan; nothing deleted.");
      }
      if (knownIds.size >= 10_000) {
        throw new Error("Too many collections for a safe duplicate scan; nothing deleted.");
      }
      knownIds.add(id);
    }
    const uniqueCollectionIds = [...knownIds];
    const candidates = new Map<number, number[]>();

    // Discover and validate the full candidate set BEFORE deleting anything.
    for (const [index, collectionId] of uniqueCollectionIds.entries()) {
      progress({
        progress: 10 + (index / uniqueCollectionIds.length) * 35,
        total: 100,
      });
      const first = await raindropService.getBookmarks(
        { collection: collectionId, duplicates: true, perPage: 50, page: 0 },
        args.skipCache,
      );
      if (!Number.isSafeInteger(first.count) || first.count < 0) {
        throw new Error("Duplicate scan returned an invalid count; nothing deleted.");
      }
      if (first.count === 0) continue;
      const ids: number[] = [];
      const pages = Math.ceil(first.count / 50);
      for (let page = 0; page < pages; page++) {
        const batch =
          page === 0
            ? first
            : await raindropService.getBookmarks(
                { collection: collectionId, duplicates: true, perPage: 50, page },
                args.skipCache,
              );
        // Changing pagination counts or missing IDs make deletion unsafe.
        if (batch.count !== first.count || !Array.isArray(batch.items)) {
          throw new Error("Duplicate scan changed during pagination; nothing deleted.");
        }
        const pageIds = batch.items.map((item) => item._id);
        if (pageIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
          throw new Error("Duplicate scan returned unknown IDs; nothing deleted.");
        }
        ids.push(...(pageIds as number[]));
      }
      if (ids.length !== first.count || new Set(ids).size !== ids.length) {
        throw new Error("Duplicate scan was incomplete or overlapping; nothing deleted.");
      }
      candidates.set(collectionId, ids);
    }

    let protectedCount = 0;
    let unverifiedCount = 0;
    // Keep at least one verified copy of every exact URL. The official
    // duplicate search does not specify which hit (if any) is canonical.
    const safe = new Map<number, number[]>();
    const verifiedLinks = new Map<number, string>();
    let preservedCopies = 0;
    for (const [collectionId, ids] of candidates) {
      // Cross-collection bookmarks are intentional organization, not disposable duplicates.
      const keptLinks = new Set<string>();
      for (const id of ids) {
        // Always bypass cached responses for deletion eligibility checks.
        const item = await raindropService.getBookmark(id, true);
        if (
          item._id !== id ||
          typeof item.note !== "string" ||
          !Array.isArray(item.highlights) ||
          !Array.isArray(item.tags) ||
          typeof item.important !== "boolean" ||
          typeof item.link !== "string" ||
          item.link.length === 0 ||
          item.collection?.$id !== collectionId
        ) {
          unverifiedCount++;
        } else if (!safeDuplicateCandidate(item, id, collectionId)) {
          protectedCount++;
        } else if (!keptLinks.has(item.link)) {
          keptLinks.add(item.link);
          preservedCopies++;
        } else {
          const entry = safe.get(collectionId) ?? [];
          entry.push(id);
          safe.set(collectionId, entry);
          verifiedLinks.set(id, item.link);
        }
      }
    }

    const safeCount = [...safe.values()].reduce((sum, ids) => sum + ids.length, 0);
    if (safeCount === 0) {
      return {
        content: [textContent(
          `No safely deletable duplicates. Retained collection-local copies: ${preservedCopies}, protected: ${protectedCount}, unverifiable: ${unverifiedCount}; nothing deleted.`,
        )],
      };
    }

    if (args.dryRun !== false) {
      return { content: [textContent(
        `Preview only (dryRun): ${safeCount} verified duplicates would be deleted across ${safe.size} collections. Retained collection-local copies: ${preservedCopies}, protected: ${protectedCount}, unverifiable: ${unverifiedCount}. Nothing deleted. To execute, call again with dryRun: false.`,
      )] };
    }

    let deleted = 0;
    const entries = [...safe.entries()];
    for (const [index, [collectionId, ids]] of entries.entries()) {
      progress({
        progress: 50 + (index / entries.length) * 50,
        total: 100,
      });
      for (let offset = 0; offset < ids.length; offset += 50) {
        const batch = ids.slice(offset, offset + 50);
        // The library may change while a large scan is running. Recheck each
        // target immediately before the batch, and stop if any detail changed.
        try {
          for (const id of batch) {
            const latest = await raindropService.getBookmark(id, true);
            if (
              !safeDuplicateCandidate(latest, id, collectionId) ||
              latest.link !== verifiedLinks.get(id)
            ) {
              return {
                content: [textContent(
                  `Stopped before a deletion batch in collection ${collectionId}: candidate metadata changed; ${deleted} items previously acknowledged, current batch not sent.`,
                )],
              };
            }
          }
        } catch {
          return {
            content: [textContent(
              `Stopped before a deletion batch in collection ${collectionId}: recheck failed; ${deleted} items previously acknowledged, current batch not sent.`,
            )],
          };
        }
        try {
          const acknowledged = await raindropService.batchDeleteBookmarksInCollection(
            collectionId,
            batch,
          );
          if (!acknowledged) {
            return {
              content: [textContent(
                `Stopped after an unconfirmed deletion batch in collection ${collectionId}; ${deleted} items previously acknowledged. The latest batch outcome is uncertain; do not retry blindly.`,
              )],
            };
          }
          deleted += batch.length;
        } catch {
          return {
            content: [textContent(
              `Stopped after a deletion error in collection ${collectionId}; ${deleted} items previously acknowledged. The latest batch outcome is unknown; do not retry blindly.`,
            )],
          };
        }
      }
    }
    return {
      content: [textContent(
        `Deleted ${deleted} verified duplicates across ${safe.size} collections. Retained collection-local copies: ${preservedCopies}, protected: ${protectedCount}, unverifiable: ${unverifiedCount}.`,
      )],
    };
  },
});

export const cleanupTools = [
  libraryAuditTool,
  emptyTrashTool,
  cleanupCollectionsTool,
  removeDuplicatesTool,
];
