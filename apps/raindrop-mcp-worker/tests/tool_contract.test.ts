import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

const EXPECTED_TOOL_NAMES = [
  "bookmark_exists",
  "bookmark_get",
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
  it("retains the 17 legacy tools while introducing two strict read-only tools", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });

    try {
      const tools = await service.listTools();
      const actual = tools.map((tool) => tool.id).sort();

      expect(actual).toEqual(EXPECTED_TOOL_NAMES);
      expect(actual).toHaveLength(19);
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

describe("preview-first cleanup MCP tools/list and tools/call entry contract", () => {
  it("advertises explicit confirmation, keeps {} read-only, and rejects unknown arguments", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });
    const getStats = vi.spyOn(service.raindropService, "getUserStats")
      .mockResolvedValue({ trash: 7, collections: 5 } as Awaited<ReturnType<typeof service.raindropService.getUserStats>>);
    const roots = vi.spyOn(service.raindropService, "getCollections")
      .mockResolvedValue([{ _id: 11, title: "Empty", count: 0 }] as Awaited<ReturnType<typeof service.raindropService.getCollections>>);
    const children = vi.spyOn(service.raindropService, "getAllChildCollections")
      .mockResolvedValue([] as Awaited<ReturnType<typeof service.raindropService.getAllChildCollections>>);
    const getBookmarks = vi.spyOn(service.raindropService, "getBookmarks")
      .mockResolvedValue({ count: 0, items: [] } as Awaited<ReturnType<typeof service.raindropService.getBookmarks>>);
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
        expect(tool?.description).toMatch(/preview/i);
        const argsProperty = name === "remove_duplicates" ? "dryRun" : "confirm";
        expect((tool?.inputSchema as { properties?: Record<string, unknown> })?.properties?.[argsProperty]).toBeDefined();
        const preview = await client.callTool({ name, arguments: {} });
        expect(preview.isError).not.toBe(true);
        expect(preview.content?.[0]).toMatchObject({ type: "text" });
      }
      // Non-executing flags must also be safe at protocol boundary.
      for (const name of ["empty_trash", "cleanup_collections"]) {
        const preview = await client.callTool({ name, arguments: { confirm: false } });
        expect(preview.isError).not.toBe(true);
      }
      const duplicatePreview = await client.callTool({
        name: "remove_duplicates", arguments: { dryRun: true },
      });
      expect(duplicatePreview.isError).not.toBe(true);
      for (const [name, args] of [
        ["empty_trash", { dryRun: false }],
        ["empty_trash", { unknown: 1 }],
        ["cleanup_collections", { dryRun: true }],
        ["cleanup_collections", { unknown: 1 }],
        ["remove_duplicates", { confirm: true }],
        ["remove_duplicates", { unknown: 1 }],
      ] as const) {
        let rejected = false;
        try {
          const result = await client.callTool({ name, arguments: args });
          rejected = result.isError === true;
        } catch {
          rejected = true;
        }
        expect(rejected).toBe(true);
      }
      expect(getStats).toHaveBeenCalled();
      expect(roots).toHaveBeenCalled();
      expect(children).toHaveBeenCalled();
      expect(getBookmarks).toHaveBeenCalled();
      expect(trashDelete).not.toHaveBeenCalled();
      expect(collectionDelete).not.toHaveBeenCalled();
      expect(duplicateDelete).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await service.cleanup();
      getStats.mockRestore();
      roots.mockRestore();
      children.mockRestore();
      getBookmarks.mockRestore();
      trashDelete.mockRestore();
      collectionDelete.mockRestore();
      duplicateDelete.mockRestore();
    }
  });
});

describe("bookmark_exists over MCP tools/list and tools/call", () => {
  it("uses strict input and returns verified URL existence without mutating bookmarks", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });
    const exists = vi.spyOn(service.raindropService, "bookmarkExists")
      .mockResolvedValue({ exists: false, ids: [] });
    const client = new Client({ name: "bookmark-exists-contract", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        service.getServer().connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const { tools } = await client.listTools();
      const tool = tools.find(entry => entry.name === "bookmark_exists");
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect(tool?.outputSchema).toBeDefined();

      const absent = await client.callTool({
        name: "bookmark_exists",
        arguments: { url: "https://example.com/a" },
      });
      expect(absent.isError).not.toBe(true);
      expect(absent.structuredContent).toEqual({ exists: false, ids: [] });
      expect(exists).toHaveBeenCalledTimes(1);
      expect(exists).toHaveBeenCalledWith("https://example.com/a");

      const invalid = await client.callTool({
        name: "bookmark_exists",
        arguments: { url: "https://example.com/a", unexpected: true },
      });
      expect(invalid.isError).toBe(true);
      expect(exists).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await service.cleanup();
      exists.mockRestore();
    }
  });
});

describe("bookmark_get over MCP tools/list and tools/call", () => {
  it("requires an integer ID and returns available full bookmark metadata", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });
    const get = vi.spyOn(service.raindropService, "getBookmark")
      .mockResolvedValue({
        _id: 123, title: "Example", link: "https://example.com/a",
        tags: ["test"], important: false, excerpt: "Excerpt", note: "Note",
        collection: { $id: 456 },
        highlights: [{ _id: "highlight-string-id", text: "Quote", note: "My note" }],
      } as Awaited<ReturnType<typeof service.raindropService.getBookmark>>);
    const client = new Client({ name: "bookmark-get-contract", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        service.getServer().connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const result = await client.callTool({
        name: "bookmark_get", arguments: { id: 123 },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        bookmark: {
          id: 123, title: "Example", url: "https://example.com/a",
          tags: ["test"], important: false, excerpt: "Excerpt", note: "Note",
          collectionId: 456,
          highlights: [{ id: "highlight-string-id", text: "Quote", note: "My note" }],
        },
      });
      expect(get).toHaveBeenCalledWith(123, undefined);

      for (const badId of [0, -1, 1.5, "123abc"]) {
        const invalid = await client.callTool({
          name: "bookmark_get", arguments: { id: badId },
        });
        expect(invalid.isError).toBe(true);
      }
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await service.cleanup();
      get.mockRestore();
    }
  });
});
