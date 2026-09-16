import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTools } from "../src/tools/cleanup.js";
import type { McpContent, ToolHandlerContext } from "../src/tools/common.js";

const textOf = (content: McpContent[] | undefined) => {
  const first = content?.[0];
  if (!first || first.type !== "text") {
    throw new Error("Expected a text MCP response");
  }
  return first.text;
};

describe("Destructive Cleanup Tools Confirmation", () => {
  const emptyTrash = cleanupTools.find((tool) => tool.name === "empty_trash")!;
  const cleanupCollections = cleanupTools.find(
    (tool) => tool.name === "cleanup_collections",
  )!;

  let mockService: {
    getUserStats: ReturnType<typeof vi.fn>;
    emptyTrash: ReturnType<typeof vi.fn>;
    removeEmptyCollections: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockService = {
      getUserStats: vi.fn().mockResolvedValue({ trash: 7, collections: 12 }),
      emptyTrash: vi.fn(),
      removeEmptyCollections: vi.fn(),
    };
  });

  const context = (): ToolHandlerContext =>
    ({ raindropService: mockService }) as unknown as ToolHandlerContext;

  describe("empty_trash", () => {
    it.each([{ confirm: false }, {}])(
      "previews trash without deleting for %o",
      async (args) => {
        const result = await emptyTrash.handler(args, context());
        const text = textOf(result.content);

        expect(text).toContain("Trash contains 7 items");
        expect(text).toContain(
          "To permanently empty it, call this tool again with 'confirm: true'",
        );
        expect(mockService.getUserStats).toHaveBeenCalledTimes(1);
        expect(mockService.emptyTrash).not.toHaveBeenCalled();
      },
    );
  });

  describe("cleanup_collections", () => {
    it.each([{ confirm: false }, {}])(
      "previews collection count without removing collections for %o",
      async (args) => {
        const result = await cleanupCollections.handler(args, context());
        const text = textOf(result.content);

        expect(text).toContain("You currently have 12 total collections");
        expect(text).toContain(
          "Call this tool again with 'confirm: true' to proceed",
        );
        expect(mockService.getUserStats).toHaveBeenCalledTimes(1);
        expect(mockService.removeEmptyCollections).not.toHaveBeenCalled();
      },
    );
  });
});
