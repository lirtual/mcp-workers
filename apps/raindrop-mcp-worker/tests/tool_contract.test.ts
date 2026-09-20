import { describe, expect, it } from "vitest";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

const EXPECTED_TOOL_NAMES = [
  "raindrop_list",
  "raindrop_get",
  "raindrop_create",
  "raindrop_update",
  "raindrop_delete",
  "raindrop_bulk_update",
  "raindrop_bulk_delete",
  "raindrop_suggest",
  "collection_list",
  "collection_tree",
  "collection_get",
  "collection_create",
  "collection_update",
  "collection_delete",
  "tag_list",
  "tag_rename",
  "tag_merge",
  "tag_delete",
  "highlight_list",
  "highlight_create",
  "highlight_update",
  "highlight_delete",
  "library_audit",
  "duplicates_delete",
  "trash_empty",
  "diagnostics",
].sort();

describe("Raindrop MCP v3 public contract", () => {
  it("exposes exactly the approved 26 tools with no legacy alias", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });
    try {
      const tools = await service.listTools();
      const actual = tools.map((tool) => tool.id).sort();
      expect(actual).toEqual(EXPECTED_TOOL_NAMES);
      expect(new Set(actual).size).toBe(26);
      expect(actual).toHaveLength(26);
      expect(actual).toContain("diagnostics");
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.outputSchema).toBeDefined();
      }
    } finally {
      await service.cleanup();
    }
  });
});
