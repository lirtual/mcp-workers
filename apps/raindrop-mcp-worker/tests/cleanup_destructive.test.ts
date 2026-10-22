import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTools } from "../src/tools/cleanup.js";
import type { McpContent, ToolHandlerContext } from "../src/tools/common.js";

const message = (content: McpContent[] | undefined): string => {
  const item = content?.[0];
  if (item?.type !== "text") throw new Error("Expected a text MCP response");
  return item.text;
};

describe("preview-first cleanup contracts", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
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

  it("legacy empty_trash only guides migration without any reads or writes", async () => {
    for (const args of [{}, { confirm: false }]) {
      const result = await emptyTrash.handler(args, context());
      expect(message(result.content)).toContain("trash_empty");
    }
    await expect(emptyTrash.handler({ confirm: true }, context())).rejects.toThrow(/disabled/);
    expect(service.getUserStats).not.toHaveBeenCalled();
    expect(service.emptyTrash).not.toHaveBeenCalled();
  });

  it("cleanup_collections only guides migration without scanning roots or children", async () => {
    for (const args of [{}, { confirm: false }]) {
      const preview = await cleanupCollections.handler(
        cleanupCollections.inputSchema.parse(args), context(),
      );
      expect(message(preview.content)).toContain("collection_remove_empty");
      expect(message(preview.content)).toContain("positive rootId");
      expect(message(preview.content)).toContain("no scope scanned");
    }
    expect(service.getCollections).not.toHaveBeenCalled();
    expect(service.getAllChildCollections).not.toHaveBeenCalled();
    expect(service.removeEmptyCollections).not.toHaveBeenCalled();
    expect(cleanupCollections.annotations).toMatchObject({
      readOnlyHint: false, destructiveHint: true,
    });
  });

  it("both legacy destructive handlers fail closed before any upstream access", async () => {
    const fetch = vi.fn(() => { throw new Error("Unexpected HTTP"); });
    vi.stubGlobal("fetch", fetch);
    // A poison context catches any service access, including an accidental read.
    const noUpstream = new Proxy({}, {
      get: () => { throw new Error("Unexpected upstream service access"); },
    });
    for (const [name, args, replacement] of [
      ["empty_trash", { confirm: true }, "trash_empty"],
      ["cleanup_collections", { confirm: true }, "collection_remove_empty"],
    ] as const) {
      const tool = cleanupTools.find(entry => entry.name === name)!;
      await expect(tool.handler(args, { raindropService: noUpstream } as ToolHandlerContext))
        .rejects.toThrow(new RegExp(`disabled.*${replacement}`));
    }
    expect(fetch).not.toHaveBeenCalled();
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
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
