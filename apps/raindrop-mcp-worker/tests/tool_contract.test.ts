import { describe, expect, it, vi } from "vitest";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

const EXPECTED_TOOL_NAMES = [
  "bookmark_manage",
  "bookmark_search",
  "bulk_edit_raindrops",
  "cleanup_collections",
  "collection_list",
  "collection_manage",
  "diagnostics",
  "empty_trash",
  "get_collection_tree",
  "get_raindrop",
  "get_suggestions",
  "highlight_manage",
  "library_audit",
  "list_raindrops",
  "remove_duplicates",
  "suggest_tags",
  "tag_manage",
].sort();

describe("Raindrop MCP capability contract", () => {
  it("preserves the exact 17-tool public tool-name set", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });

    try {
      const tools = await service.listTools();
      const actual = tools.map((tool) => tool.id).sort();

      expect(actual).toEqual(EXPECTED_TOOL_NAMES);
      expect(actual).toHaveLength(17);
      expect(actual).toContain("diagnostics");
    } finally {
      await service.cleanup();
    }
  });
});

describe("collection_list MCP response contract", () => {
  it("returns only text content and output-schema-compatible collection summaries", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });
    const getCollections = vi.spyOn(service.raindropService, "getCollections").mockResolvedValue([
      { _id: 123, title: "Work", count: 8, description: "Articles" },
      { _id: 456, title: "Empty", count: 0 },
    ] as Awaited<ReturnType<typeof service.raindropService.getCollections>>);

    try {
      for (const skipCache of [true, false]) {
        const result = await service.callTool("collection_list", { skipCache });
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe("text");
        expect(result.content[0].text).toContain("Work (ID: 123, Items: 8)");
        expect(result.structuredContent).toEqual({
          count: 2,
          collections: [
            { id: 123, title: "Work", count: 8, description: "Articles" },
            { id: 456, title: "Empty", count: 0 },
          ],
        });
        expect(getCollections).toHaveBeenLastCalledWith(skipCache);
      }
    } finally {
      getCollections.mockRestore();
      await service.cleanup();
    }
  });
});
