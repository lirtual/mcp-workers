import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
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

describe("collection_list over MCP tools/call", () => {
  it("accepts the declared output schema with an SDK client, with and without cache bypass", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });
    const getCollections = vi.spyOn(service.raindropService, "getCollections").mockResolvedValue([
      { _id: 123, title: "Work", count: 8, description: "Articles" },
      { _id: 456, title: "Empty", count: 0 },
    ] as Awaited<ReturnType<typeof service.raindropService.getCollections>>);
    const client = new Client({ name: "collection-list-regression", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        service.getServer().connect(serverTransport),
        client.connect(clientTransport),
      ]);

      const tools = await client.listTools();
      expect(tools.tools.find((tool) => tool.name === "collection_list")?.outputSchema)
        .toBeDefined();

      for (const skipCache of [false, true]) {
        const result = await client.callTool({
          name: "collection_list",
          arguments: { skipCache },
        });
        expect(result.isError).not.toBe(true);
        expect(result.content).toHaveLength(1);
        expect(result.content[0]).toMatchObject({
          type: "text",
        });
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
      await client.close();
      await service.cleanup();
      getCollections.mockRestore();
    }
  });
});

describe("destructive cleanup MCP tools/list and tools/call entry contract", () => {
  it("exposes truthful annotations and rejects stale arguments before upstream deletion", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });
    const trashDelete = vi.spyOn(service.raindropService, "emptyTrash");
    const collectionDelete = vi.spyOn(service.raindropService, "removeEmptyCollections");
    const duplicateDelete = vi.spyOn(
      service.raindropService, "batchDeleteBookmarksInCollection",
    );
    const client = new Client({ name: "cleanup-protocol-regression", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([service.getServer().connect(serverTransport), client.connect(clientTransport)]);
      const { tools } = await client.listTools();
      for (const name of ["empty_trash", "cleanup_collections", "remove_duplicates"]) {
        const tool = tools.find(entry => entry.name === name);
        expect(tool?.annotations).toMatchObject({
          readOnlyHint: false, destructiveHint: true,
        });
      }
      for (const [name, args] of [
        ["empty_trash", { confirm: false }],
        ["empty_trash", { confirm: true }],
        ["cleanup_collections", { confirm: true }],
        ["cleanup_collections", { confirm: false }],
        ["remove_duplicates", { dryRun: true }],
        ["remove_duplicates", { dryRun: false }],
        ["remove_duplicates", { unknown: 0 }],
      ] as const) {
        try {
          const result = await client.callTool({ name, arguments: args });
          expect(result.isError).toBe(true);
        } catch (error) {
          expect(error).toBeDefined();
        }
      }
      expect(trashDelete).not.toHaveBeenCalled();
      expect(collectionDelete).not.toHaveBeenCalled();
      expect(duplicateDelete).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await service.cleanup();
      trashDelete.mockRestore();
      collectionDelete.mockRestore();
      duplicateDelete.mockRestore();
    }
  });
});
