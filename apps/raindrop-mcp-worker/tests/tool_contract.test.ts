import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

const EXPECTED_TOOL_NAMES = [
  "bookmark_exists",
  "bookmark_filters_get",
  "bookmark_suggest",
  "bookmark_get",
  "bookmark_manage",
  "bookmark_search",
  "bulk_edit_raindrops",
  "cleanup_collections",
  "collection_create",
  "collection_get",
  "collection_update",
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
  it("retains legacy tools while adding T01 and T02 atomic tools", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });

    try {
      const tools = await service.listTools();
      const actual = tools.map((tool) => tool.id).sort();

      expect(actual).toEqual(EXPECTED_TOOL_NAMES);
      expect(actual).toHaveLength(24);
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
    const getChildren = vi.spyOn(service.raindropService, "getAllChildCollections")
      .mockResolvedValue([]);

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
      getChildren.mockRestore();
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
    const getChildren = vi.spyOn(service.raindropService, "getAllChildCollections")
      .mockResolvedValue([]);
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
      getChildren.mockRestore();
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
        highlights: [{ _id: "highlight-string-id", text: "Quote", color: "yellow", note: "My note" }],
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
          highlights: [{ id: "highlight-string-id", text: "Quote", color: "yellow", note: "My note" }],
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

describe("bookmark_search strict pagination over public MCP", () => {
  it("accepts empty query with page zero and rejects oversized, malformed and unknown arguments", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });
    const get = vi.spyOn(service.raindropService, "getBookmarks")
      .mockResolvedValue({ count: 0, items: [] });
    const client = new Client({ name: "bookmark-search-contract", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        service.getServer().connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const { tools } = await client.listTools();
      expect(tools.find(tool => tool.name === "bookmark_search")?.annotations?.readOnlyHint).toBe(true);
      const result = await client.callTool({
        name: "bookmark_search",
        arguments: { search: "", page: 0, perPage: 50, collection: -1 },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ count: 0, items: [] });
      expect(get).toHaveBeenCalledWith({
        search: "", page: 0, perPage: 50, collection: -1,
      }, undefined);

      for (const args of [
        { perPage: 51 }, { perPage: 0 }, { page: -1 }, { page: 0.5 },
        { collection: -2 }, { perPage: "50" }, { unexpected: "ignored?" },
      ]) {
        expect((await client.callTool({
          name: "bookmark_search", arguments: args,
        })).isError).toBe(true);
      }
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await service.cleanup();
      get.mockRestore();
    }
  });
});

describe("Official Raindrop helper tools over public MCP", () => {
  it("reads filter statistics and organization suggestions without client Sampling", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });
    const filters = vi.spyOn(service.raindropService, "getBookmarkFilters")
      .mockResolvedValue({ important: 5 });
    const suggestions = vi.spyOn(service.raindropService, "getOfficialSuggestions")
      .mockResolvedValue({ collectionIds: [24], tags: ["backend"] });
    const client = new Client({ name: "bookmark-helpers-contract", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        service.getServer().connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const { tools } = await client.listTools();
      for (const name of ["bookmark_filters_get", "bookmark_suggest"]) {
        expect(tools.find(tool => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
      }
      const stats = await client.callTool({
        name: "bookmark_filters_get",
        arguments: { collectionId: 0, tagsSort: "-count" },
      });
      expect(stats.isError).not.toBe(true);
      expect(stats.structuredContent).toEqual({ filters: { important: 5 } });
      expect(filters).toHaveBeenCalledWith(0, "-count", undefined);

      const suggested = await client.callTool({
        name: "bookmark_suggest",
        arguments: { bookmarkId: 123 },
      });
      expect(suggested.isError).not.toBe(true);
      expect(suggested.structuredContent).toEqual({
        suggestions: { collectionIds: [24], tags: ["backend"] },
      });
      expect(suggestions).toHaveBeenCalledWith(123);

      for (const bad of [
        {},
        { url: "https://example.com", bookmarkId: 123 },
        { url: "file:///etc/passwd" },
        { bookmarkId: "123" },
      ]) {
        expect((await client.callTool({
          name: "bookmark_suggest", arguments: bad,
        })).isError).toBe(true);
      }
      expect(suggestions).toHaveBeenCalledTimes(1);
      expect((await client.callTool({
        name: "bookmark_filters_get", arguments: { collectionId: -99 },
      })).isError).toBe(true);
      expect(filters).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await service.cleanup();
      filters.mockRestore();
      suggestions.mockRestore();
    }
  });
});

describe("T02 full collection hierarchy and exact get", () => {
  it("includes all nested collection IDs with their verifiable parents", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });
    const roots = vi.spyOn(service.raindropService, "getCollections").mockResolvedValue([
      { _id: 11, title: "Root", count: 2 },
    ] as Awaited<ReturnType<typeof service.raindropService.getCollections>>);
    const children = vi.spyOn(service.raindropService, "getAllChildCollections").mockResolvedValue([
      { _id: 12, title: "Child", parent: { $id: 11 }, count: 1 },
      { _id: 13, title: "Grandchild", parent: { $id: 12 } },
    ] as Awaited<ReturnType<typeof service.raindropService.getAllChildCollections>>);
    const get = vi.spyOn(service.raindropService, "getCollection").mockResolvedValue({
      _id: 13, title: "Grandchild", parent: { $id: 12 }, count: 0,
    } as Awaited<ReturnType<typeof service.raindropService.getCollection>>);
    const client = new Client({ name: "collections-t02-contract", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        service.getServer().connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const { tools } = await client.listTools();
      expect(tools.find(t => t.name === "collection_list")?.annotations?.readOnlyHint).toBe(true);
      expect(tools.find(t => t.name === "collection_get")?.annotations?.readOnlyHint).toBe(true);
      const listed = await client.callTool({ name: "collection_list", arguments: {} });
      expect(listed.isError).not.toBe(true);
      expect(listed.structuredContent).toEqual({
        count: 3,
        collections: [
          { id: 11, title: "Root", count: 2 },
          { id: 12, title: "Child", count: 1, parentId: 11 },
          { id: 13, title: "Grandchild", parentId: 12 },
        ],
      });
      const exact = await client.callTool({
        name: "collection_get", arguments: { id: 13 },
      });
      expect(exact.isError).not.toBe(true);
      expect(exact.structuredContent).toEqual({
        collection: { id: 13, title: "Grandchild", count: 0, parentId: 12 },
      });
      expect(get).toHaveBeenCalledWith(13, undefined);
      for (const bad of [{ id: "13" }, { id: 0 }, { id: -99 }, { id: 13, extra: 1 }]) {
        expect((await client.callTool({
          name: "collection_get", arguments: bad,
        })).isError).toBe(true);
      }
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await service.cleanup();
      roots.mockRestore();
      children.mockRestore();
      get.mockRestore();
    }
  });
});

describe("T02 atomic collection mutations through MCP", () => {
  it("uses minimal create/update schemas and no hidden writes", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });
    const create = vi.spyOn(service.raindropService, "createCollection")
      .mockResolvedValue({ _id: 55, title: "Test", public: false }
        as Awaited<ReturnType<typeof service.raindropService.createCollection>>);
    const update = vi.spyOn(service.raindropService, "updateCollection")
      .mockResolvedValue({ _id: 55, title: "Renamed" }
        as Awaited<ReturnType<typeof service.raindropService.updateCollection>>);
    const client = new Client({ name: "collection-mutations-contract", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        service.getServer().connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const { tools } = await client.listTools();
      expect(tools.find(t => t.name === "collection_create")?.annotations?.readOnlyHint).toBe(false);
      expect(tools.find(t => t.name === "collection_update")?.annotations?.readOnlyHint).toBe(false);

      for (const args of [{}, { title: "" }, { title: "Test", extra: 123 }]) {
        expect((await client.callTool({
          name: "collection_create", arguments: args,
        })).isError).toBe(true);
      }
      expect(create).not.toHaveBeenCalled();
      const made = await client.callTool({ name: "collection_create", arguments: { title: "Test" } });
      expect(made.isError).not.toBe(true);
      expect(made.structuredContent).toEqual({
        collection: { id: 55, title: "Test" },
      });
      expect(create).toHaveBeenCalledWith("Test", false);

      for (const args of [
        { id: 55 }, { id: "55", title: "Renamed" }, { id: 0, title: "Renamed" },
        { id: 55, unknownField: "bad" },
      ]) {
        expect((await client.callTool({
          name: "collection_update", arguments: args,
        })).isError).toBe(true);
      }
      expect(update).not.toHaveBeenCalled();
      const renamed = await client.callTool({
        name: "collection_update", arguments: { id: 55, title: "Renamed" },
      });
      expect(renamed.isError).not.toBe(true);
      expect(renamed.structuredContent).toEqual({
        collection: { id: 55, title: "Renamed" },
      });
      expect(update).toHaveBeenCalledWith(55, { title: "Renamed" });
    } finally {
      await client.close();
      await service.cleanup();
      create.mockRestore();
      update.mockRestore();
    }
  });
});
