import { describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
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
  it("rejects unknown fields for every one of the 26 tools through MCP Client", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("Schema must reject inputs before any upstream request");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const service = new RaindropMCPService({ accessToken: "offline-token" });
    const client = new Client({ name: "v3-exact-tool-validation", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        service.getServer().connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOL_NAMES);
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.outputSchema).toBeDefined();
        const result = await client.callTool({
          name: tool.name,
          arguments: { __contractProbe: true },
        });
        expect(result.isError, `tool ${tool.name} should reject an unknown field`).toBe(true);
        expect(fetchSpy, `tool ${tool.name} must not contact upstream`).not.toHaveBeenCalled();
      }
    } finally {
      await client.close();
      await service.cleanup();
      vi.unstubAllGlobals();
    }
  });

});
