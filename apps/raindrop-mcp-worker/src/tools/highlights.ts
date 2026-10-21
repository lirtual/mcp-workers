import { z } from "zod";
import { ValidationError } from "../types/mcpErrors.js";
import {
  HighlightBookmarkIdSchema,
  HighlightIdSchema,
  HighlightInputSchema,
  HighlightRecordSchema,
  HighlightUpdateFieldsSchema,
  HighlightWriteOutcomeSchema,
} from "../types/raindrop-zod.schemas.js";
import type { HighlightWriteOutcome } from "../services/raindrop.service.js";
import type { ToolHandlerContext } from "./common.js";
import { defineTool, textContent } from "./common.js";

const scope = { bookmarkId: HighlightBookmarkIdSchema };
const target = { ...scope, highlightId: HighlightIdSchema };
const updateInput = z
  .strictObject({
    ...target,
    ...HighlightUpdateFieldsSchema.shape,
  })
  .refine(
    ({ text, color }) => [text, color].some((v) => v !== undefined),
    "Provide at least one update field",
  );
const writeResponse = (outcome: HighlightWriteOutcome) => ({
  content: [
    textContent(
      outcome.status === "succeeded"
        ? `Highlight ${outcome.highlightId}: ${outcome.deleted ? "deleted" : "saved"}`
        : outcome.reason,
    ),
  ],
  structuredContent: outcome,
});
const writes = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const listInput = z.strictObject(scope);
const deleteToolInput = z.strictObject(target);

const listTool = defineTool({
  name: "highlight_list",
  description:
    "List highlights for one bookmark using its positive safe integer ID.",
  inputSchema: listInput,
  outputSchema: z.object({
    bookmarkId: HighlightBookmarkIdSchema,
    highlights: z.array(HighlightRecordSchema),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (
    args: z.infer<typeof listInput>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const { bookmarkId } = listInput.parse(args);
    const highlights = await raindropService.getHighlights(bookmarkId);
    return {
      content: [textContent(JSON.stringify(highlights))],
      structuredContent: { bookmarkId, highlights },
    };
  },
});
const createTool = defineTool({
  name: "highlight_create",
  description:
    "Add one nonempty highlight to a bookmark. Unknown results must be inspected before any retry.",
  inputSchema: HighlightInputSchema,
  outputSchema: HighlightWriteOutcomeSchema,
  annotations: { ...writes, destructiveHint: false },
  handler: async (
    args: z.infer<typeof HighlightInputSchema>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const { bookmarkId, ...fields } = HighlightInputSchema.parse(args);
    return writeResponse(
      await raindropService.createHighlight(bookmarkId, fields),
    );
  },
});
const updateTool = defineTool({
  name: "highlight_update",
  description:
    "Patch text, note or color of one string highlight ID after verifying bookmark membership. Empty text is forbidden; use highlight_delete. Unknown results must be inspected before any retry.",
  inputSchema: updateInput,
  outputSchema: HighlightWriteOutcomeSchema,
  annotations: writes,
  handler: async (
    args: z.infer<typeof updateInput>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const { bookmarkId, highlightId, ...fields } = updateInput.parse(args);
    return writeResponse(
      await raindropService.updateHighlight(bookmarkId, highlightId, fields),
    );
  },
});
const deleteTool = defineTool({
  name: "highlight_delete",
  description:
    "Delete exactly one string highlight ID from its verified bookmark, preserving all others. Unknown results must be inspected before any retry.",
  inputSchema: deleteToolInput,
  outputSchema: HighlightWriteOutcomeSchema,
  annotations: writes,
  handler: async (
    args: z.infer<typeof deleteToolInput>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const { bookmarkId, highlightId } = deleteToolInput.parse(args);
    return writeResponse(
      await raindropService.deleteHighlight(bookmarkId, highlightId),
    );
  },
});

// Draft compatibility: keep the public name, reject numeric `id` and missing scope.
const legacyInput = z.strictObject({
  ...scope,
  operation: z.enum(["create", "update", "delete"]),
  highlightId: HighlightIdSchema.optional(),
  ...HighlightUpdateFieldsSchema.shape,
});
const manageTool = defineTool({
  name: "highlight_manage",
  description:
    "Legacy adapter. Requires bookmarkId for all operations and string highlightId for update/delete. Prefer highlight_create/update/delete; numeric id is unsupported.",
  inputSchema: legacyInput,
  outputSchema: HighlightWriteOutcomeSchema,
  annotations: writes,
  handler: async (
    args: z.infer<typeof legacyInput>,
    { raindropService }: ToolHandlerContext,
  ) => {
    const { operation, bookmarkId, highlightId, ...fields } =
      legacyInput.parse(args);
    if (operation === "create") {
      if (highlightId !== undefined || fields.text === undefined)
        throw new ValidationError(
          "Create requires text and does not accept highlightId",
        );
      return writeResponse(
        await raindropService.createHighlight(bookmarkId, {
          ...fields,
          text: fields.text,
        }),
      );
    }
    if (highlightId === undefined)
      throw new ValidationError("String highlightId required");
    if (operation === "update")
      return writeResponse(
        await raindropService.updateHighlight(bookmarkId, highlightId, fields),
      );
    if (Object.values(fields).some((v) => v !== undefined))
      throw new ValidationError(
        "Delete accepts only bookmarkId and highlightId",
      );
    return writeResponse(
      await raindropService.deleteHighlight(bookmarkId, highlightId),
    );
  },
});

export const highlightTools = [
  manageTool,
  listTool,
  createTool,
  updateTool,
  deleteTool,
];
