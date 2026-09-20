import { describe, expect, it } from "vitest";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

const EXPECTED_TOOL_NAMES = [
  "bookmark_manage",
  "bookmark_search",
  "bulk_edit_raindrops",
  "cleanup_collections",
  "collection_create",
  "collection_delete",
  "collection_get",
  "collection_list",
  "collection_tree",
  "collection_update",
  "collection_manage",
  "diagnostics",
  "empty_trash",
  "get_collection_tree",
  "get_raindrop",
  "get_suggestions",
  "highlight_create",
  "highlight_delete",
  "highlight_list",
  "highlight_manage",
  "highlight_update",
  "library_audit",
  "list_raindrops",
  "raindrop_bulk_delete",
  "raindrop_bulk_update",
  "raindrop_create",
  "raindrop_delete",
  "raindrop_get",
  "raindrop_list",
  "raindrop_suggest",
  "raindrop_update",
  "remove_duplicates",
  "suggest_tags",
  "tag_delete",
  "tag_list",
  "tag_manage",
  "tag_merge",
  "tag_rename",
].sort();

describe("Raindrop MCP capability contract", () => {
  it("tracks the transitional 38-tool set until final 26-tool cutover", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });

    try {
      const tools = await service.listTools();
      const actual = tools.map((tool) => tool.id).sort();

      expect(actual).toEqual(EXPECTED_TOOL_NAMES);
      expect(actual).toHaveLength(38);
      expect(actual).toContain("diagnostics");
    } finally {
      await service.cleanup();
    }
  });
});
