import { z } from "zod";
import { defineTool, textContent, type ToolHandlerContext } from "./common.js";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ids = z
  .array(id)
  .max(50)
  .refine(
    (a) => a.every((n, i) => i === 0 || n > a[i - 1]!),
    "IDs must be sorted and unique",
  );
const confirmation = z
  .object({
    digest: z.string().regex(/^duplicates-v1:sha256:[a-f0-9]{64}$/),
    candidateIds: ids,
    keeperIds: ids,
    total: z.number().int().nonnegative().max(10),
  })
  .strict();
const inputSchema = z
  .object({ collectionId: id, confirm: confirmation.optional() })
  .strict();

// The public MCP result is an actual bounded, typed object. Aggregate batch
// acknowledgements cannot identify which individual bookmark succeeded.
export const DuplicateRemovalOutputSchema = z.strictObject({
  status: z.enum(["preview", "notExecuted", "failed", "unknown"]),
  collectionId: id,
  observedTotal: z.number().int().nonnegative().max(50),
  protectedCount: z.number().int().nonnegative().max(50),
  unknownCount: z.number().int().nonnegative().max(50),
  items: z.array(z.strictObject({
    id,
    url: z.string(),
    protected: z.boolean(),
    unknown: z.boolean(),
    candidate: z.boolean(),
    keeper: z.boolean(),
  })).max(50),
  groups: z.array(z.strictObject({
    url: z.string(),
    ids,
    keeperId: id.optional(),
  })).max(50),
  confirmation,
  warning: z.string().min(1),
  reason: z.string().optional(),
  dispatched: z.boolean().optional(),
  acknowledged: z.boolean().optional(),
  modified: z.number().int().nonnegative().safe().optional(),
  succeeded: ids.optional(),
  failed: ids.optional(),
  unknown: ids.optional(),
  notExecuted: ids.optional(),
});

// Stable object keys preserve all observed metadata, including unknown/missing fields.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function flags(item: Record<string, unknown>) {
  const unknown =
    typeof item.title !== "string" ||
    typeof item.excerpt !== "string" ||
    typeof item.note !== "string" ||
    !Array.isArray(item.highlights) ||
    !Array.isArray(item.tags) ||
    typeof item.important !== "boolean";
  const protectedItem =
    (typeof item.note === "string" && item.note !== "") ||
    (Array.isArray(item.highlights) && item.highlights.length > 0) ||
    (Array.isArray(item.tags) && item.tags.length > 0) ||
    item.important === true ||
    item.reminder != null;
  return {
    protected: protectedItem,
    unknown,
    eligible: !unknown && !protectedItem,
  };
}
export const bookmarkRemoveDuplicatesTool = defineTool({
  name: "bookmark_remove_duplicates",
  description:
    "Preview official duplicate:true candidates in one required positive collectionId (max 50 results, max 10 deletions). Exact URL only; preserve a fresh verified keeper, prefer protected copies. Confirm with the exact returned confirmation object (versioned SHA-256 digest, sorted candidateIds, keeperIds, total). Recomputes all metadata fresh. Aggregate deletion acknowledgement leaves individual outcomes unknown; never automatically retry. Digest is neither permission nor a transaction lock; concurrent changes remain possible.",
  inputSchema,
  outputSchema: DuplicateRemovalOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (
    raw: z.infer<typeof inputSchema>,
    { raindropService: api }: ToolHandlerContext,
  ) => {
    const args = inputSchema.parse(raw);
    const observedIds = await api.getDuplicateScope(args.collectionId);
    const observed = [];
    for (const itemId of observedIds) {
      const item = await api.getDuplicateMetadata(itemId, args.collectionId);
      observed.push({
        id: itemId,
        url: item.link,
        flags: flags(item),
        metadata: item,
      });
    }
    const groups = new Map<string, typeof observed>();
    for (const item of observed)
      groups.set(item.url, [...(groups.get(item.url) ?? []), item]);
    const candidateIds: number[] = [],
      keeperIds: number[] = [];
    for (const group of groups.values()) {
      const keeper = group.find((item) => item.flags.protected) ?? group[0]!;
      keeperIds.push(keeper.id);
      for (const item of group) {
        // Same URL is not evidence of identical user-authored content.
        // Preserve an item whose title or excerpt differs from the keeper.
        // Missing values are already classified unknown in flags().
        if (item.metadata.title !== keeper.metadata.title ||
            item.metadata.excerpt !== keeper.metadata.excerpt) {
          item.flags.protected = true;
          item.flags.eligible = false;
        }
        if (item.id !== keeper.id && item.flags.eligible)
          candidateIds.push(item.id);
      }
    }
    candidateIds.sort((a, b) => a - b);
    keeperIds.sort((a, b) => a - b);
    if (candidateIds.length > 10)
      throw new Error(
        "Scope requires more than 10 deletions; bounded batch refused in full, nothing deleted.",
      );
    const snapshot = {
      version: 1,
      collectionId: args.collectionId,
      observedTotal: observedIds.length,
      observed,
      candidateIds,
      keeperIds,
    };
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical(snapshot)),
    );
    const digest = `duplicates-v1:sha256:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("")}`;
    const confirm = {
      digest,
      candidateIds,
      keeperIds,
      total: candidateIds.length,
    };
    const preview = {
      collectionId: args.collectionId,
      observedTotal: observedIds.length,
      protectedCount: observed.filter((i) => i.flags.protected).length,
      unknownCount: observed.filter((i) => i.flags.unknown).length,
      items: observed.map((i) => ({
        id: i.id,
        url: i.url,
        protected: i.flags.protected,
        unknown: i.flags.unknown,
        candidate: candidateIds.includes(i.id),
        keeper: keeperIds.includes(i.id),
      })),
      groups: [...groups].map(([url, items]) => ({
        url,
        ids: items.map((i) => i.id),
        keeperId: keeperIds.find((id) => items.some((i) => i.id === id)),
      })),
      confirmation: confirm,
      warning:
        "Only the complete observed official filter snapshot is covered; canonical originals may be omitted. Different title/excerpt and missing metadata are protected. Snapshot digest is neither permission nor a transaction lock; concurrent upstream changes remain possible.",
    };
    if (!args.confirm)
      return {
        content: [
          textContent(
            `Preview only: ${preview.observedTotal} official candidates, ${candidateIds.length} eligible deletions, ${preview.protectedCount} protected, ${preview.unknownCount} unknown. Nothing deleted. Supply the exact structured confirmation object as confirm to execute.`,
          ),
        ],
        structuredContent: DuplicateRemovalOutputSchema.parse({ ...preview, status: "preview" }),
      };
    if (canonical(args.confirm) !== canonical(confirm))
      throw new Error(
        "Duplicate snapshot confirmation mismatch; nothing deleted. Preview again.",
      );
    if (candidateIds.length === 0)
      return {
        content: [textContent("No eligible duplicates; nothing deleted.")],
        structuredContent: DuplicateRemovalOutputSchema.parse({
          ...preview,
          status: "notExecuted",
          notExecuted: [],
        }),
      };
    // Check every deletion candidate and every retained keeper again immediately
    // before T06's independent membership preflight and single batch DELETE.
    const recheck = new Set([...candidateIds, ...keeperIds]);
    for (const itemId of recheck) {
      const fresh = await api.getDuplicateMetadata(itemId, args.collectionId);
      if (
        canonical(fresh) !==
        canonical(observed.find((i) => i.id === itemId)!.metadata)
      )
        throw new Error(
          "Duplicate candidate or keeper changed before write; nothing deleted.",
        );
    }
    const outcome = await api.deleteBookmarkBatch({
      collectionId: args.collectionId,
      ids: candidateIds,
    });
    return {
      content: [textContent(outcome.reason)],
      structuredContent: DuplicateRemovalOutputSchema.parse({ ...preview, ...outcome }),
      ...(outcome.status === "failed" ? { isError: true } : {}),
    };
  },
});
