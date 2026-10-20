import { z } from "zod";
import { UnknownWriteError, UpstreamError } from "../types/mcpErrors.js";
import {
  TagInputSchema,
  TagListInputSchema,
  TagRenameInputSchema,
  TagMergeInputSchema,
  TagDeleteInputSchema,
} from "../types/raindrop-zod.schemas.js";
import type { ToolHandlerContext } from "./common.js";
import { defineTool, textContent } from "./common.js";

const TagMutationOutputSchema = z.object({
  operation: z.enum(["rename", "merge", "delete"]),
  collectionId: z.number(),
  tags: z.array(z.string()),
  replacement: z.string().optional(),
  status: z.enum(["succeeded", "unknown"]),
  success: z.boolean(),
  reason: z.string().optional(),
});

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

async function manageTags(
  args: z.infer<typeof TagInputSchema>,
  { raindropService }: ToolHandlerContext,
) {
  // Also enforce cardinality/unknown-field safety for direct handler callers.
  args = TagInputSchema.parse(args);
  const details = {
    operation: args.operation,
    collectionId: args.collectionId,
    tags: args.tagNames,
    ...(args.operation !== "delete" ? { replacement: args.newName } : {}),
  };
  try {
    const success =
      args.operation === "rename"
        ? await raindropService.renameTag(
            args.collectionId,
            args.tagNames[0]!,
            args.newName,
          )
        : args.operation === "merge"
          ? await raindropService.mergeTags(
              args.collectionId,
              args.tagNames,
              args.newName,
            )
          : await raindropService.deleteTags(args.collectionId, args.tagNames);
    if (success !== true)
      throw new UpstreamError(
        "Raindrop rejected tag mutation; no success confirmed",
      );
    return {
      content: [
        textContent(
          `Tag ${args.operation} succeeded in scope ${details.collectionId}`,
        ),
      ],
      structuredContent: {
        ...details,
        status: "succeeded" as const,
        success: true,
      },
    };
  } catch (error) {
    if (!(error instanceof UnknownWriteError)) throw error;
    return {
      content: [textContent(error.message)],
      structuredContent: {
        ...details,
        status: "unknown" as const,
        success: false,
        reason: error.message,
      },
    };
  }
}

const tagListTool = defineTool({
  name: "tag_list",
  description:
    "List current tags and counts. Omitted collectionId or 0 means all collections; a positive ID limits scope.",
  inputSchema: TagListInputSchema,
  outputSchema: z.object({
    collectionId: z.number(),
    tags: z.array(z.object({ _id: z.string(), count: z.number() })),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (
    args: z.infer<typeof TagListInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const tags = await raindropService.getTags(args.collectionId);
    return {
      content: [textContent(JSON.stringify(tags))],
      structuredContent: { collectionId: args.collectionId ?? 0, tags },
    };
  },
});

const tagRenameTool = defineTool({
  name: "tag_rename",
  description:
    "Rename exactly one existing oldName to a fresh newName; if the target exists use tag_merge. Explicit collectionId:0 is global; positive IDs scope the write. Omitted scope is rejected. Preflight is not a lock; unknown writes are never replayed.",
  inputSchema: TagRenameInputSchema,
  outputSchema: TagMutationOutputSchema,
  annotations: writeAnnotations,
  handler: async (
    args: z.infer<typeof TagRenameInputSchema>,
    context: ToolHandlerContext,
  ) =>
    manageTags(
      {
        operation: "rename",
        collectionId: args.collectionId,
        tagNames: [args.oldName],
        newName: args.newName,
      },
      context,
    ),
});

const tagMergeTool = defineTool({
  name: "tag_merge",
  description:
    "Merge two or more distinct existing tagNames into newName, which may already exist but must differ from all sources. Explicit collectionId:0 is global; positive IDs scope the write. Omitted scope is rejected. Preflight is not a lock; unknown writes are never replayed.",
  inputSchema: TagMergeInputSchema,
  outputSchema: TagMutationOutputSchema,
  annotations: writeAnnotations,
  handler: async (
    args: z.infer<typeof TagMergeInputSchema>,
    context: ToolHandlerContext,
  ) => manageTags({ ...args, operation: "merge" }, context),
});

const tagDeleteTool = defineTool({
  name: "tag_delete",
  description:
    "Delete only explicit nonempty distinct existing tagNames. Explicit collectionId:0 is global; positive IDs scope the write. Omitted scope is rejected. Preflight is not a lock; unknown writes are never replayed.",
  inputSchema: TagDeleteInputSchema,
  outputSchema: TagMutationOutputSchema,
  annotations: writeAnnotations,
  handler: async (
    args: z.infer<typeof TagDeleteInputSchema>,
    context: ToolHandlerContext,
  ) => manageTags({ ...args, operation: "delete" }, context),
});

const tagManageTool = defineTool({
  name: "tag_manage",
  description:
    "Legacy alias for tag_rename, tag_merge, tag_delete with the same validation. Prefer the independent tools. Explicit collectionId:0 means global scope; positive IDs limit scope. Omitted scope is rejected.",
  inputSchema: TagInputSchema,
  outputSchema: TagMutationOutputSchema,
  annotations: writeAnnotations,
  handler: manageTags,
});

export const tagTools = [
  tagListTool,
  tagRenameTool,
  tagMergeTool,
  tagDeleteTool,
  tagManageTool,
];
