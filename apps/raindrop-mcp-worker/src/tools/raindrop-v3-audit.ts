import { z } from "zod";
import { defineTool, toolSuccess } from "./common.js";
import type { ToolHandlerContext } from "./common.js";
import { buildCollectionIndexV3, descendantIdsV3 } from "./collection-index-v3.js";
import { McpError, NotFoundError } from "../types/mcpErrors.js";

const positiveId = z.number().int().positive().refine(Number.isSafeInteger, "Use a safe positive ID");
const sourceId = z.number().int().refine(
  (id) => Number.isSafeInteger(id) && (id === -1 || id > 0),
  "Source must be a collection ID or Unsorted (-1)",
);
const auditCollectionId = z.number().int().refine(
  (id) => Number.isSafeInteger(id) && (id === -1 || id === -99 || id >= 0),
  "Invalid collection ID",
).default(0);
const page = z.number().int().safe().min(0).default(0);
const perpage = z.number().int().min(1).max(50).default(25);
const auditInput = z.object({
  kind: z.enum(["duplicates", "broken", "untagged", "empty_collections"]),
  collectionId: auditCollectionId,
  page,
  perpage,
}).strict();
const duplicatesInput = z.object({
  collectionId: sourceId,
  ids: z.array(positiveId).min(1).max(10).refine(
    (values) => new Set(values).size === values.length,
    "Candidate IDs must be distinct",
  ),
  page,
  confirm: z.boolean().default(false),
}).strict();

// Compile-time gate: ONLY flip in the same reviewed commit that records direct
// live evidence for the duplicate operator and plan-specific entitlement.
const DUPLICATE_DELETION_VERIFIED = false;

async function requirePro(context: ToolHandlerContext) {
  const stats = await context.raindropService.getUserStats();
  if (stats.pro === false) {
    throw new McpError("FEATURE_UNAVAILABLE", "Official duplicates/broken audit requires the Raindrop plan entitlement");
  }
  if (stats.pro !== true) {
    throw new McpError("FEATURE_UNVERIFIED", "Raindrop plan entitlement could not be established");
  }
}

function pagination(pageNumber: number, size: number, count: number, total: number | null) {
  const hasMore = total === null ? (count < size ? false : count === 0 ? false : null) :
    (pageNumber + 1) * size < total;
  return {
    page: pageNumber, perpage: size, returned: count, total, hasMore,
    nextPage: hasMore === false ? null : pageNumber + 1,
  };
}

export const raindropV3AuditTools = [
  defineTool({
    name: "library_audit",
    description: "Inspect exactly one page and one issue kind; this never scans the whole bookmark library.",
    inputSchema: auditInput,
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (args: z.infer<typeof auditInput>, context: ToolHandlerContext) => {
      const { raindropService } = context;
      if (args.kind === "empty_collections") {
        if (args.collectionId === -1 || args.collectionId === -99) {
          throw new McpError("VALIDATION_ERROR", "Empty collection audit does not support system collections");
        }
        const index = buildCollectionIndexV3(await raindropService.listCollectionsV3());
        let scoped = index.nodes;
        if (args.collectionId > 0) {
          const root = index.byId.get(args.collectionId);
          if (!root) throw new NotFoundError("Requested collection does not exist");
          const ids = new Set([args.collectionId, ...descendantIdsV3(root)]);
          scoped = index.nodes.filter((item) => ids.has(item._id));
        }
        const emptyLeaves = scoped.filter((node) =>
          node.count === 0 && node.children.length === 0 &&
          !index.unattached.some((invalid) => invalid._id === node._id),
        );
        const items = emptyLeaves.slice(args.page * args.perpage, (args.page + 1) * args.perpage)
          .map(({ children, ...node }) => node);
        return toolSuccess({ items }, {
          kind: args.kind, scope: { collectionId: args.collectionId },
          ...pagination(args.page, args.perpage, items.length, emptyLeaves.length),
          warnings: index.warnings, requestCount: raindropService.budget.requestCount,
        }, "One page of eligible empty leaves inspected");
      }

      if (args.kind === "duplicates" || args.kind === "broken") {
        await requirePro(context);
      }
      const search = {
        duplicates: "duplicate:true",
        broken: "broken:true",
        untagged: "notag:true",
      }[args.kind];
      const result = await raindropService.listRaindropsV3({
        collectionId: args.collectionId,
        search,
        sort: "-created",
        page: args.page,
        perpage: args.perpage,
        nested: false,
      });
      return toolSuccess({ items: result.items }, {
        kind: args.kind, scope: { collectionId: args.collectionId },
        ...pagination(args.page, args.perpage, result.items.length, result.count),
        warnings: args.kind === "duplicates" || args.kind === "broken"
          ? ["Filter operator and subscription behavior require isolated read-only live verification"]
          : [],
        requestCount: raindropService.budget.requestCount,
      }, "One bookmark audit page inspected; not a full library scan");
    },
  }),
  defineTool({
    name: "duplicates_delete",
    description: "Inspect up to 10 explicit official duplicate candidates; execution is disabled until isolated verification.",
    inputSchema: duplicatesInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async (args: z.infer<typeof duplicatesInput>, context: ToolHandlerContext) => {
      // Never reach an upstream write while the documented filter's actual
      // semantics and entitlement have not been independently verified.
      if (args.confirm && !DUPLICATE_DELETION_VERIFIED) {
        throw new McpError("FEATURE_UNVERIFIED", "Duplicate deletion requires read-only live verification before activation");
      }
      await requirePro(context);
      const service = context.raindropService;
      const candidates = await service.listRaindropsV3({
        collectionId: args.collectionId,
        search: "duplicate:true",
        sort: "-created",
        page: args.page,
        perpage: 50,
        nested: false,
      });
      const onPage = new Set(candidates.items.map((item) => item._id));
      const eligible: number[] = [];
      const skipped: Array<{ id: number; reason: string }> = [];
      for (const id of args.ids) {
        if (!onPage.has(id)) {
          skipped.push({ id, reason: "STALE_CANDIDATE" });
          continue;
        }
        // Every candidate is re-read, never rely on list summaries to
        // establish the current source or absence of unique content.
        const item = await service.getBookmark(id, true);
        if (item.collection?.$id !== args.collectionId) {
          skipped.push({ id, reason: "SOURCE_CHANGED" });
        } else if (typeof item.note !== "string" || !Array.isArray(item.highlights)) {
          skipped.push({ id, reason: "CONTENT_UNKNOWN" });
        } else if (item.note.length > 0 || item.highlights.length > 0) {
          skipped.push({ id, reason: "PROTECTED_CONTENT" });
        } else {
          eligible.push(id);
        }
      }
      if (!args.confirm) {
        return toolSuccess({ eligibleIds: eligible, skipped }, {
          status: "preview", requestedIds: args.ids, scope: { collectionId: args.collectionId },
          warnings: ["Preview is not a snapshot; the duplicate-deletion execution gate remains disabled"],
          requestCount: service.budget.requestCount,
        }, "Protected duplicate deletion preview only");
      }
      if (eligible.length === 0) {
        return toolSuccess({ eligibleIds: [], skipped }, {
          status: "not_executed", requestedIds: args.ids, modified: null,
          requestCount: service.budget.requestCount,
        }, "No eligible candidates remain");
      }
      const { modified } = await service.mutateRaindropsV3("delete", args.collectionId, eligible);
      return toolSuccess({ eligibleIds: eligible, skipped, modified }, {
        status: modified !== null && modified < eligible.length ? "partial" : "succeeded",
        requestedIds: args.ids, modified, requestCount: service.budget.requestCount,
      }, "One source-scoped duplicate deletion submitted");
    },
  }),
];
