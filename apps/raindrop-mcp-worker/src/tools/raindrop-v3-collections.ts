import { z } from "zod";
import type { ToolHandlerContext } from "./common.js";
import { defineTool, toolSuccess } from "./common.js";
import { buildCollectionIndexV3, descendantIdsV3 } from "./collection-index-v3.js";
import { McpError, NotFoundError, ValidationError } from "../types/mcpErrors.js";

const id = z.number().int().positive().refine(Number.isSafeInteger, "Use a safe positive collection ID");
const title = z.string().min(1).max(1000).refine((value) => value.trim().length > 0, "Blank collection title");
const parent = z.object({ $id: id }).strict();
const page = z.number().int().safe().min(0).default(0);
const perpage = z.number().int().min(1).max(50).default(25);
const updateInput = z.object({
  id,
  title: title.optional(),
  parent: parent.nullable().optional(),
}).strict().refine((value) => value.title !== undefined || value.parent !== undefined,
  "At least one field must be changed");
const deleteInput = z.object({
  id,
  confirm: z.boolean().default(false),
  descendantIds: z.array(id).max(1000).optional(),
  onlyIfEmpty: z.boolean().default(false),
}).strict();

type Collection = Awaited<ReturnType<ToolHandlerContext["raindropService"]["listCollectionsV3"]>>[number];
type Index = ReturnType<typeof buildCollectionIndexV3<Collection>>;
const collectionIndex = async (context: ToolHandlerContext) =>
  buildCollectionIndexV3(await context.raindropService.listCollectionsV3());

function currentTarget(index: Index, idValue: number) {
  const node = index.byId.get(idValue);
  if (!node) throw new NotFoundError("Collection not found in the complete index");
  if (index.unattached.some((invalid) => invalid._id === idValue)) {
    throw new ValidationError("Collection has unresolved ancestry; mutation is not safe");
  }
  return node;
}

export const raindropV3CollectionTools = [
  defineTool({
    name: "collection_list",
    description: "Fetch both official root and child collection lists and page the complete bounded metadata.",
    inputSchema: z.object({ page, perpage }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (args: { page: number; perpage: number }, context: ToolHandlerContext) => {
      const index = await collectionIndex(context);
      const all = index.nodes.map(({ children, ...item }) => item);
      const items = all.slice(args.page * args.perpage, (args.page + 1) * args.perpage);
      const hasMore = (args.page + 1) * args.perpage < all.length;
      return toolSuccess({ items }, {
        page: args.page, perpage: args.perpage, returned: items.length,
        total: all.length, nextPage: hasMore ? args.page + 1 : null, hasMore,
        warnings: index.warnings, requestCount: context.raindropService.budget.requestCount,
      }, "Collection metadata page loaded");
    },
  }),
  defineTool({
    name: "collection_tree",
    description: "Read a complete bounded collection tree; unresolved parents and cycles appear as unattached.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (_args: Record<string, never>, context: ToolHandlerContext) => {
      const index = await collectionIndex(context);
      return toolSuccess({ roots: index.roots, unattached: index.unattached }, {
        total: index.nodes.length, warnings: index.warnings,
        requestCount: context.raindropService.budget.requestCount,
      }, "Collection tree loaded");
    },
  }),
  defineTool({
    name: "collection_get",
    description: "Fetch a complete collection directly by its positive ID.",
    inputSchema: z.object({ id }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (args: { id: number }, context: ToolHandlerContext) => {
      const item = await context.raindropService.getCollection(args.id, true);
      return toolSuccess({ item }, { requestCount: context.raindropService.budget.requestCount }, "Collection loaded");
    },
  }),
  defineTool({
    name: "collection_create",
    description: "Create a private collection with a title and optional positive parent ID.",
    inputSchema: z.object({ title, parent: parent.optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (args: { title: string; parent?: { $id: number } }, context: ToolHandlerContext) => {
      const item = await context.raindropService.createCollectionV3(args.title, args.parent);
      return toolSuccess({ item }, {
        status: "succeeded", requestCount: context.raindropService.budget.requestCount,
      }, "Collection created");
    },
  }),
  defineTool({
    name: "collection_update",
    description: "Update only collection title or validated parent; moving to root is gated pending live evidence.",
    inputSchema: updateInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (args: z.infer<typeof updateInput>, context: ToolHandlerContext) => {
      if (args.parent === null) {
        // The API does not document the exact clear-parent serialization.
        // Do not guess a magic ID or issue an unverified write.
        throw new McpError("FEATURE_UNVERIFIED", "Move-to-root must pass isolated live acceptance");
      }
      if (args.parent !== undefined) {
        if (args.parent.$id === args.id) throw new ValidationError("Cannot parent a collection to itself");
        const index = await collectionIndex(context);
        const node = currentTarget(index, args.id);
        const target = currentTarget(index, args.parent.$id);
        if (descendantIdsV3(node).includes(target._id)) {
          throw new ValidationError("Cannot move a collection under its descendant");
        }
      }
      const fields = {
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.parent === undefined ? {} : { parent: args.parent }),
      };
      const item = await context.raindropService.updateCollectionV3(args.id, fields);
      return toolSuccess({ item }, { status: "succeeded",
        requestCount: context.raindropService.budget.requestCount }, "Collection updated");
    },
  }),
  defineTool({
    name: "collection_delete",
    description: "Preview current subtree; confirm only with exact descendant IDs; optionally require an empty leaf.",
    inputSchema: deleteInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async (args: z.infer<typeof deleteInput>, context: ToolHandlerContext) => {
      // Read the full current index on every invocation. The preview is not a
      // cross-request lock; outside concurrent writes are not atomic with us.
      const index = await collectionIndex(context);
      const node = currentTarget(index, args.id);
      const descendants = descendantIdsV3(node);
      const targets = [args.id, ...descendants].map((targetId) => ({
        id: targetId, count: index.byId.get(targetId)?.count ?? null,
      }));
      if (args.onlyIfEmpty && (descendants.length > 0 || node.count !== 0)) {
        throw new ValidationError("Empty cleanup requires a known-zero-count leaf collection");
      }
      if (!args.confirm) {
        return toolSuccess({
          targets, descendantIds: descendants,
          impact: "Deleting this collection removes every descendant and moves its bookmarks to Trash",
        }, { status: "preview", requestedIds: [args.id, ...descendants],
          requestCount: context.raindropService.budget.requestCount }, "Collection deletion preview only");
      }
      const supplied = args.descendantIds ?? [];
      const distinct = [...new Set(supplied)].sort((a, b) => a - b);
      if (distinct.length !== supplied.length || distinct.length !== descendants.length ||
          distinct.some((value, i) => value !== descendants[i])) {
        throw new McpError("SCOPE_CHANGED", "Current descendants differ from the exact confirmed set");
      }
      await context.raindropService.deleteCollectionV3(args.id);
      return toolSuccess({ targets, descendantIds: descendants },
        { status: "succeeded", requestedIds: [args.id, ...descendants],
          requestCount: context.raindropService.budget.requestCount },
        "One collection subtree deletion accepted");
    },
  }),
];
