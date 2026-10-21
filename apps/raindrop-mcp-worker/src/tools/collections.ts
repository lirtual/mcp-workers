import { z } from "zod";
import { AuthError, NotFoundError, RateLimitError, ValidationError } from "../types/mcpErrors.js";
import {
  CollectionDeleteInputSchema,
  CollectionRemoveEmptyInputSchema,
  CollectionDeletionOutputSchema,
  CollectionManageInputSchema,
} from "../types/raindrop-zod.schemas.js";
import type { ToolHandlerContext } from "./common.js";
import {
  defineTool,
  setIfDefined,
  textContent,
} from "./common.js";

const CollectionListInputSchema = z.object({
  skipCache: z
    .boolean()
    .optional()
    .describe("Force a fresh fetch from the API, bypassing the local cache"),
}).strict();

const CollectionReadSummarySchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  count: z.number().int().nonnegative().optional(),
  description: z.string().optional(),
  color: z.string().optional(),
  parentId: z.number().int().positive().optional(),
});
const CollectionListOutputSchema = z.object({
  count: z.number().int().nonnegative(),
  collections: z.array(CollectionReadSummarySchema),
});
const CollectionGetInputSchema = z.object({
  id: z.number().int().positive().safe(),
  skipCache: z.boolean().optional(),
}).strict();
const CollectionGetOutputSchema = z.object({
  collection: CollectionReadSummarySchema,
});

const CollectionSummarySchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string().optional(),
  color: z.string().optional(),
  parentId: z.number().optional(),
});

const CollectionManageOutputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("delete"), deleted: z.literal(true) }),
  z.object({
    operation: z.enum(["create", "update"]),
    collection: CollectionSummarySchema,
  }),
]);

const collectionSummary = (collection: any) => ({
  id: collection._id,
  title: collection.title || "Untitled Collection",
  description: collection.description || undefined,
  color: collection.color || undefined,
  parentId: collection.parent?.$id,
});

// Count is omitted when upstream does not provide it. Parent IDs describe
// the entire hierarchy without creating a separate public tree operation.
const collectionReadSummary = (collection: any) => ({
  id: collection._id,
  title: collection.title || "Untitled Collection",
  ...(Number.isSafeInteger(collection.count) && collection.count >= 0
    ? { count: collection.count } : {}),
  ...(typeof collection.description === "string"
    ? { description: collection.description } : {}),
  ...(typeof collection.color === "string" ? { color: collection.color } : {}),
  ...(Number.isSafeInteger(collection.parent?.$id) && collection.parent.$id > 0
    ? { parentId: collection.parent.$id } : {}),
});

type CollectionManageArgs = z.infer<typeof CollectionManageInputSchema> & {
  color?: string;
  description?: string;
};

const collectionListTool = defineTool({
  name: "collection_list",
  description: "Lists all Raindrop.io collections as a flat list.",
  inputSchema: CollectionListInputSchema,
  outputSchema: CollectionListOutputSchema,
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (
    args: z.infer<typeof CollectionListInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    // Official endpoints separate root and *all* nested collections.
    const [roots, children] = await Promise.all([
      raindropService.getCollections(args.skipCache),
      raindropService.getAllChildCollections(args.skipCache),
    ]);
    // The live API can repeat a collection in both root and nested results.
    // Collapse cross-endpoint overlap; never silently merge inconsistent IDs.
    if (new Set(roots.map(item => item._id)).size !== roots.length ||
        new Set(children.map(item => item._id)).size !== children.length)
      throw new ValidationError("Duplicate collection IDs within one upstream list");
    const unique = new Map(roots.map(collection => [collection._id, collection]));
    for (const child of children) {
      const root = unique.get(child._id);
      if (root) {
        if (root.title !== child.title ||
            (root.parent?.$id !== undefined && child.parent?.$id !== undefined &&
             root.parent.$id !== child.parent.$id))
          throw new ValidationError("Conflicting collection metadata across upstream lists");
        // Prefer the nested record when it carries a verified parent.
        const nestedParentId = child.parent?.$id;
        if (typeof nestedParentId === "number" &&
            Number.isSafeInteger(nestedParentId) && nestedParentId > 0)
          unique.set(child._id, child);
      } else {
        unique.set(child._id, child);
      }
    }
    const summaries = [...unique.values()].map(collectionReadSummary);
    return {
      content: [
        textContent(
          [
            `Found ${summaries.length} collections`,
            ...summaries.map(
              (collection) =>
                `- ${collection.title} (ID: ${collection.id}, Items: ${collection.count ?? "unknown"}) — mcp://collection/${collection.id}`,
            ),
          ].join("\n"),
        ),
      ],
      structuredContent: {
        count: summaries.length,
        collections: summaries,
      },
    };
  },
});

const collectionGetTool = defineTool({
  name: "collection_get",
  description: "Read one collection by its exact positive ID and return available parent, count and description.",
  inputSchema: CollectionGetInputSchema,
  outputSchema: CollectionGetOutputSchema,
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (
    args: z.infer<typeof CollectionGetInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const collection = await raindropService.getCollection(args.id, args.skipCache);
    const summary = collectionReadSummary(collection);
    return {
      content: [textContent(`Collection ${summary.id}: ${summary.title}`)],
      structuredContent: { collection: summary },
    };
  },
});

const CollectionCreateInputSchema = z.object({
  title: z.string().trim().min(1).max(255),
  public: z.literal(false).optional(),
  parentId: z.number().int().positive().safe().optional(),
}).strict();

const CollectionUpdateInputSchema = z.object({
  id: z.number().int().positive().safe(),
  title: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(4096).optional(),
  color: z.string().min(1).max(64).optional(),
  public: z.literal(false).optional(),
}).strict().refine(
  args => args.title !== undefined || args.description !== undefined ||
    args.color !== undefined || args.public !== undefined,
  "At least one collection field must be updated",
);

const CollectionMutationOutputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), collection: CollectionReadSummarySchema }),
  z.object({
    status: z.literal("unknown"),
    reason: z.string(),
    id: z.number().int().positive().safe().optional(),
  }),
]);

// A dispatched collection write can apply even if its response is lost.
// Preserve definite validation/auth/not-found failures, but never imply that
// a transport or unverifiable upstream response means the write did not run.
const guardedCollectionWrite = async <T extends { _id: number; title: string }>(
  work: () => Promise<T>,
  id?: number,
) => {
  try {
    const collection = collectionReadSummary(await work());
    return {
      content: [textContent(`Collection ${collection.id} write confirmed`)],
      structuredContent: { status: "succeeded" as const, collection },
    };
  } catch (error) {
    if (error instanceof ValidationError || error instanceof RateLimitError ||
        error instanceof AuthError || error instanceof NotFoundError)
      throw error;
    const reason = "Collection write outcome unknown. Inspect the current collection list before retrying; do not automatically retry.";
    return {
      content: [textContent(reason)],
      structuredContent: {
        status: "unknown" as const, reason,
        ...(id !== undefined ? { id } : {}),
      },
    };
  }
};

const collectionCreateTool = defineTool({
  name: "collection_create",
  description: "Create one private collection with a title and optional parent. Public sharing is not available to Agents.",
  inputSchema: CollectionCreateInputSchema,
  outputSchema: CollectionMutationOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (
    args: z.infer<typeof CollectionCreateInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    return guardedCollectionWrite(() => args.parentId === undefined
      ? raindropService.createCollection(args.title, args.public ?? false)
      : raindropService.createCollection(args.title, args.public ?? false, args.parentId));
  },
});

const collectionUpdateTool = defineTool({
  name: "collection_update",
  description: "Update explicit fields of one collection without clearing unspecified fields.",
  inputSchema: CollectionUpdateInputSchema,
  outputSchema: CollectionMutationOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (
    args: z.infer<typeof CollectionUpdateInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const updates = {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.color !== undefined ? { color: args.color } : {}),
      ...(args.public !== undefined ? { public: args.public } : {}),
    };
    return guardedCollectionWrite(
      () => raindropService.updateCollection(args.id, updates), args.id);
  },
});

const getCollectionTreeTool = defineTool({
  name: "get_collection_tree",
  description:
    "Returns a hierarchical view of all collections with full breadcrumb paths.",
  inputSchema: z.object({
    skipCache: z
      .boolean()
      .optional()
      .describe("Force a fresh fetch from the API, bypassing the local cache"),
  }),
  handler: async (
    args: { skipCache?: boolean },
    { raindropService }: ToolHandlerContext,
  ) => {
    const tree = await raindropService.getCollectionTree(args.skipCache);

    const formatNode = (node: any, indent = 0): string => {
      let result =
        "  ".repeat(indent) +
        `- ${node.title} (ID: ${node._id}, Path: ${node.path}, Items: ${node.count || 0})\n`;
      if (node.children && node.children.length > 0) {
        node.children.forEach((child: any) => {
          result += formatNode(child, indent + 1);
        });
      }
      return result;
    };

    let resultText = "Collection Hierarchy:\n";
    tree.forEach((node) => {
      resultText += formatNode(node);
    });

    return {
      content: [textContent(resultText)],
    };
  },
});

const collectionManageTool = defineTool({
  name: "collection_manage",
  description:
    "Creates, updates, or deletes a collection. Use the operation parameter to specify the action.",
  inputSchema: CollectionManageInputSchema,
  outputSchema: CollectionManageOutputSchema,
  handler: async (
    args: CollectionManageArgs,
    { raindropService }: ToolHandlerContext,
  ) => {
    switch (args.operation) {
      case "create": {
        if (!args.title)
          throw new ValidationError("title is required for create");
        const collection = await raindropService.createCollection(args.title);
        return {
          content: [textContent(`Created collection: ${collection.title}`)],
          structuredContent: {
            operation: "create" as const,
            collection: collectionSummary(collection),
          },
        };
      }
      case "update": {
        if (!args.id) throw new ValidationError("id is required for update");
        const updatePayload: Record<string, unknown> = {};
        setIfDefined(updatePayload, "title", args.title);
        setIfDefined(updatePayload, "color", args.color);
        setIfDefined(updatePayload, "description", args.description);
        const collection = await raindropService.updateCollection(
          args.id,
          updatePayload as any,
        );
        return {
          content: [textContent(`Updated collection: ${collection.title}`)],
          structuredContent: {
            operation: "update" as const,
            collection: collectionSummary(collection),
          },
        };
      }
      case "delete": {
        // Preserve the legacy tool name, not its unsafe subtree deletion.
        throw new ValidationError(
          "Legacy collection_manage delete disabled. Use collection_delete with an explicit id, preview and matching confirmation digest; nothing deleted.",
        );
      }
      default:
        throw new ValidationError(
          `Unsupported operation: ${String(args.operation)}`,
        );
    }
  },
});

const deletionDescription =
  "Preview-first; confirm requires the exact preview total, ascending collectionIds and digest. Digest is not authorization or a lock; concurrent changes remain possible. Writes are never automatically replayed.";
const collectionDeleteTool = defineTool({
  name: "collection_delete",
  description:
    "Delete one explicit positive collection and its complete descendant subtree, moving bookmarks to Trash. " +
    deletionDescription,
  inputSchema: CollectionDeleteInputSchema,
  outputSchema: CollectionDeletionOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
  handler: async (
    args: z.infer<typeof CollectionDeleteInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const result = await raindropService.deleteCollectionPreviewFirst(args);
    return { content: [textContent(result.reason)], structuredContent: result };
  },
});
const collectionRemoveEmptyTool = defineTool({
  name: "collection_remove_empty",
  description:
    "Remove only verified empty leaves within an explicit positive rootId scope (including the root if it is an empty leaf). Newly emptied parents are excluded. " +
    deletionDescription,
  inputSchema: CollectionRemoveEmptyInputSchema,
  outputSchema: CollectionDeletionOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
  handler: async (
    args: z.infer<typeof CollectionRemoveEmptyInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const result =
      await raindropService.removeEmptyCollectionsPreviewFirst(args);
    return { content: [textContent(result.reason)], structuredContent: result };
  },
});

export const collectionTools = [
  collectionDeleteTool,
  collectionRemoveEmptyTool,
  collectionListTool,
  collectionGetTool,
  collectionCreateTool,
  collectionUpdateTool,
  getCollectionTreeTool,
  collectionManageTool,
];
