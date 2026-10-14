import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTools } from "../src/tools/cleanup.js";
import type { McpContent, ToolHandlerContext } from "../src/tools/common.js";

const message = (content: McpContent[] | undefined): string => {
  const item = content?.[0];
  if (item?.type !== "text") throw new Error("Expected a text MCP response");
  return item.text;
};

describe("directly destructive cleanup contracts", () => {
  const emptyTrash = cleanupTools.find((tool) => tool.name === "empty_trash")!;
  const cleanupCollections = cleanupTools.find((tool) => tool.name === "cleanup_collections")!;
  let service: {
    getUserStats: ReturnType<typeof vi.fn>;
    emptyTrash: ReturnType<typeof vi.fn>;
    removeEmptyCollections: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    service = {
      getUserStats: vi.fn().mockResolvedValue({ trash: 7, collections: 12 }),
      emptyTrash: vi.fn().mockResolvedValue(true),
      removeEmptyCollections: vi.fn().mockResolvedValue(true),
    };
  });
  const context = () =>
    ({ raindropService: service }) as unknown as ToolHandlerContext;

  it("empty_trash {} deletes once without preview or repeat confirmation", async () => {
    expect(emptyTrash.inputSchema.parse({})).toEqual({});
    const result = await emptyTrash.handler({}, context());
    expect(message(result.content)).toContain("7 items removed");
    expect(service.emptyTrash).toHaveBeenCalledTimes(1);
    expect(emptyTrash.annotations).toMatchObject({
      readOnlyHint: false, destructiveHint: true,
    });
  });

  it("empty_trash skips deletion if the trash is verified empty", async () => {
    service.getUserStats.mockResolvedValueOnce({ trash: 0 });
    expect(message((await emptyTrash.handler({}, context())).content))
      .toContain("already empty");
    expect(service.emptyTrash).not.toHaveBeenCalled();
  });

  it("empty_trash fails closed when the trash count is unknown", async () => {
    service.getUserStats.mockResolvedValueOnce({});
    await expect(emptyTrash.handler({}, context())).rejects.toThrow(/verify trash count/);
    expect(service.emptyTrash).not.toHaveBeenCalled();
  });

  it("cleanup_collections {} executes without confirmation", async () => {
    const result = await cleanupCollections.handler(
      cleanupCollections.inputSchema.parse({}), context(),
    );
    expect(message(result.content)).toContain("successfully");
    expect(service.removeEmptyCollections).toHaveBeenCalledTimes(1);
    expect(cleanupCollections.annotations).toMatchObject({
      readOnlyHint: false, destructiveHint: true,
    });
  });

  it("rejects obsolete preview flags regardless of value at schema boundary", () => {
    for (const tool of [emptyTrash, cleanupCollections]) {
      for (const confirm of [false, true]) {
        expect(tool.inputSchema.safeParse({ confirm }).success).toBe(false);
      }
      expect(tool.inputSchema.safeParse({ obsolete: false }).success).toBe(false);
    }
    expect(service.emptyTrash).not.toHaveBeenCalled();
    expect(service.removeEmptyCollections).not.toHaveBeenCalled();
  });
});
