import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTools } from "../src/tools/cleanup.js";

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

  describe("empty_trash", () => {
    it.each([{ confirm: false }, {}])(
      "previews trash without deleting for %o",
      async (args) => {
        const result = await emptyTrash.handler(args, {
          raindropService: mockService,
        } as any);

        expect(result.content[0].text).toContain("Trash contains 7 items");
        expect(result.content[0].text).toContain(
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
        const result = await cleanupCollections.handler(args, {
          raindropService: mockService,
        } as any);

        expect(result.content[0].text).toContain(
          "You currently have 12 total collections",
        );
        expect(result.content[0].text).toContain(
          "Call this tool again with 'confirm: true' to proceed",
        );
        expect(mockService.getUserStats).toHaveBeenCalledTimes(1);
        expect(mockService.removeEmptyCollections).not.toHaveBeenCalled();
      },
    );
  });
});
