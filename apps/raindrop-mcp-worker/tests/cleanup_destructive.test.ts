import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTools } from "../src/tools/cleanup.js";
import type { McpContent, ToolHandlerContext } from "../src/tools/common.js";

const message = (content: McpContent[] | undefined): string => {
  const item = content?.[0];
  if (item?.type !== "text") throw new Error("Expected a text MCP response");
  return item.text;
};

describe("preview-first cleanup contracts", () => {
  const emptyTrash = cleanupTools.find((tool) => tool.name === "empty_trash")! as any;
  const cleanupCollections = cleanupTools.find((tool) => tool.name === "cleanup_collections")! as any;
  let service: {
    getUserStats: ReturnType<typeof vi.fn>;
    emptyTrash: ReturnType<typeof vi.fn>;
    removeEmptyCollections: ReturnType<typeof vi.fn>;
    getCollections: ReturnType<typeof vi.fn>;
    getAllChildCollections: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    service = {
      getUserStats: vi.fn().mockResolvedValue({ trash: 7, collections: 12 }),
      emptyTrash: vi.fn().mockResolvedValue(true),
      removeEmptyCollections: vi.fn().mockResolvedValue(true),
      getCollections: vi.fn().mockResolvedValue([
        { _id: 11, title: "Empty Root", count: 0 },
        { _id: 12, title: "Busy", count: 4 },
      ]),
      getAllChildCollections: vi.fn().mockResolvedValue([
        { _id: 13, title: "Nested Empty", count: 0 },
        { _id: 14, title: "Unknown" },
      ]),
    };
  });
  const context = () =>
    ({ raindropService: service }) as unknown as ToolHandlerContext;

  it("empty_trash {} is a read-only preview", async () => {
    expect(emptyTrash.inputSchema.parse({})).toEqual({});
    const result = await emptyTrash.handler({}, context());
    expect(message(result.content)).toContain("Preview only");
    expect(message(result.content)).toContain("7 items");
    expect(message(result.content)).toContain("confirm: true");
    expect(service.emptyTrash).not.toHaveBeenCalled();
    expect(emptyTrash.annotations).toMatchObject({
      readOnlyHint: false, destructiveHint: true,
    });
  });

  it("empty_trash confirm:false previews, confirm:true deletes", async () => {
    const preview = await emptyTrash.handler({ confirm: false }, context());
    expect(message(preview.content)).toContain("Nothing deleted");
    expect(service.emptyTrash).not.toHaveBeenCalled();
    const confirmed = await emptyTrash.handler({ confirm: true }, context());
    expect(message(confirmed.content)).toContain("7 items removed");
    expect(service.emptyTrash).toHaveBeenCalledTimes(1);
  });

  it("empty_trash verifies count before deletion and skips known empty trash", async () => {
    service.getUserStats.mockResolvedValueOnce({ trash: 0 });
    expect(message((await emptyTrash.handler({ confirm: true }, context())).content))
      .toContain("already empty");
    expect(service.emptyTrash).not.toHaveBeenCalled();
    service.getUserStats.mockResolvedValueOnce({});
    await expect(emptyTrash.handler({ confirm: true }, context()))
      .rejects.toThrow(/verify trash count/);
    expect(service.emptyTrash).not.toHaveBeenCalled();
  });

  it("cleanup_collections {} previews nested and root empties without deleting", async () => {
    const preview = await cleanupCollections.handler(
      cleanupCollections.inputSchema.parse({}), context(),
    );
    expect(message(preview.content)).toContain("Preview only");
    expect(message(preview.content)).toContain("Empty Root (ID: 11)");
    expect(message(preview.content)).toContain("Nested Empty (ID: 13)");
    expect(message(preview.content)).toContain("unverified counts");
    expect(message(preview.content)).toContain("final deletion set");
    expect(service.getCollections).toHaveBeenCalledExactlyOnceWith(true);
    expect(service.getAllChildCollections).toHaveBeenCalledExactlyOnceWith(true);
    expect(service.removeEmptyCollections).not.toHaveBeenCalled();
    expect(cleanupCollections.annotations).toMatchObject({
      readOnlyHint: false, destructiveHint: true,
    });
  });

  it("cleanup_collections confirm:true alone allows explicit cleanup", async () => {
    const result = await cleanupCollections.handler({ confirm: true }, context());
    expect(message(result.content)).toContain("successfully");
    expect(service.removeEmptyCollections).toHaveBeenCalledTimes(1);
  });

  it("fails closed when nested preview collection scan is unavailable", async () => {
    service.getAllChildCollections.mockRejectedValueOnce(new Error("upstream unavailable"));
    await expect(cleanupCollections.handler({}, context())).rejects.toThrow(
      /upstream unavailable/,
    );
    expect(service.removeEmptyCollections).not.toHaveBeenCalled();
  });

  it("strictly rejects unknown and mismatched parameters", () => {
    for (const tool of [emptyTrash, cleanupCollections]) {
      for (const confirm of [false, true]) {
        expect(tool.inputSchema.safeParse({ confirm }).success).toBe(true);
      }
      for (const input of [{ obsolete: false }, { confirm: "true" }, { dryRun: false }]) {
        expect(tool.inputSchema.safeParse(input).success).toBe(false);
      }
    }
    expect(service.emptyTrash).not.toHaveBeenCalled();
    expect(service.removeEmptyCollections).not.toHaveBeenCalled();
  });
});
