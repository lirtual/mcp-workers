import { z } from "zod";
import { ValidationError } from "../types/mcpErrors.js";
import { CollectionManageInputSchema } from "../types/raindrop-zod.schemas.js";
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
});

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
    const collections = [...roots, ...children];
    if (new Set(collections.map(collection => collection._id)).size !== collections.length) {
      throw new ValidationError("Duplicate collection IDs in upstream hierarchy");
    }
    const summaries = collections.map(collectionReadSummary);
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
  public: z.boolean().optional(),
  parentId: z.number().int().positive().safe().optional(),
}).strict();

const CollectionUpdateInputSchema = z.object({
  id: z.number().int().positive().safe(),
  title: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(4096).optional(),
  color: z.string().min(1).max(64).optional(),
  public: z.boolean().optional(),
}).strict().refine(
  args => args.title !== undefined || args.description !== undefined ||
    args.color !== undefined || args.public !== undefined,
  "At least one collection field must be updated",
);

const CollectionMutationOutputSchema = z.object({
  collection: CollectionReadSummarySchema,
});

const collectionCreateTool = defineTool({
  name: "collection_create",
  description: "Create exactly one collection with a title and optional parent/public flag.",
  inputSchema: CollectionCreateInputSchema,
  outputSchema: CollectionMutationOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  handler: async (
    args: z.infer<typeof CollectionCreateInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const created = args.parentId === undefined
      ? await raindropService.createCollection(args.title, args.public ?? false)
      : await raindropService.createCollection(args.title, args.public ?? false, args.parentId);
    const collection = collectionReadSummary(created);
    return {
      content: [textContent(`Created collection ${collection.id}`)],
      structuredContent: { collection },
    };
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
    const updated = await raindropService.updateCollection(args.id, updates);
    const collection = collectionReadSummary(updated);
    return {
      content: [textContent(`Updated collection ${collection.id}`)],
      structuredContent: { collection },
    };
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
        if (!args.id) throw new ValidationError("id is required for delete");
        await raindropService.deleteCollection(args.id);
        return {
          content: [textContent(`Deleted collection ${args.id}`)],
          structuredContent: { operation: "delete" as const, deleted: true },
        };
      }
      default:
        throw new ValidationError(
          `Unsupported operation: ${String(args.operation)}`,
        );
    }
  },
});

export const collectionTools = [
  collectionListTool,
  collectionGetTool,
  collectionCreateTool,
  collectionUpdateTool,
  getCollectionTreeTool,
  collectionManageTool,
];
