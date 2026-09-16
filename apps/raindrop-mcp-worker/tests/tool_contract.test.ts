import { describe, expect, it } from "vitest";
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
