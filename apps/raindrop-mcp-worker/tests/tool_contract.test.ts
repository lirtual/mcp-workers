import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";
import { RateLimitError } from "../src/types/mcpErrors.js";

// Spec #145: canonical names from the accepted public issue, not derived from runtime.
const EXPECTED_TOOL_NAMES = [
  "collection_list", "collection_get", "collection_create", "collection_update",
  "bookmark_search", "bookmark_get", "bookmark_exists", "bookmark_create",
  "bookmark_update", "bookmark_move", "bookmark_delete", "bookmark_filters_get",
  "tag_list", "highlight_list", "highlight_create", "highlight_update", "highlight_delete",
  "tag_rename", "tag_merge", "tag_delete", "bookmark_batch_update", "bookmark_batch_delete",
  "collection_delete", "collection_remove_empty",
].sort();
const CANONICAL_TOOL_NAMES = EXPECTED_TOOL_NAMES;

const READ_ONLY_TOOL_NAMES = new Set([
  "bookmark_search", "bookmark_get", "bookmark_exists", "collection_list",
  "collection_get", "tag_list", "highlight_list", "bookmark_filters_get",
]);
const DESTRUCTIVE_TOOL_NAMES = new Set([
  "bookmark_delete", "bookmark_batch_update", "bookmark_batch_delete",
  "collection_delete", "collection_remove_empty", "tag_rename", "tag_merge",
  "tag_delete", "highlight_update", "highlight_delete",
]);

// Preview/confirm schemas emit unions; inspect each object branch as well as flat objects.
function objectBranches(schema: Record<string, unknown>): Array<Record<string, unknown>> {
  const alternatives = schema.anyOf ?? schema.oneOf;
  return Array.isArray(alternatives)
    ? alternatives.flatMap(branch => objectBranches(branch as Record<string, unknown>))
    : [schema];
}

describe("Spec #145 public contract cutover", () => {
  it("lists only 24 Free-plan atomic names with valid MCP schemas and hints", async () => {
    const service = new RaindropMCPService({ accessToken: "mock-only" });
    const client = new Client({ name: "t10-readiness", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([service.getServer().connect(st), client.connect(ct)]);
      const { tools } = await client.listTools();
      const names = tools.map(tool => tool.name);
      expect(names.toSorted()).toEqual(EXPECTED_TOOL_NAMES);
      expect(names).toHaveLength(24);
      expect(new Set(names).size).toBe(24);
      expect(CANONICAL_TOOL_NAMES).toHaveLength(24);
      expect(new Set(CANONICAL_TOOL_NAMES).size).toBe(24);
      expect(names.filter(name => CANONICAL_TOOL_NAMES.includes(name)).toSorted())
        .toEqual(CANONICAL_TOOL_NAMES.toSorted());
      expect(names.filter(name => !CANONICAL_TOOL_NAMES.includes(name))).toHaveLength(0);
      for (const name of CANONICAL_TOOL_NAMES) {
        const tool = tools.find(entry => entry.name === name)!;
        expect(tool.description?.length, name).toBeGreaterThan(0);
        expect(tool.inputSchema.type, name).toBe("object");

        for (const branch of objectBranches(tool.inputSchema)) {
          expect(branch.properties, name).toBeDefined();
          expect(branch.additionalProperties, name).toBe(false);
        }
        expect(tool.annotations?.readOnlyHint, name).toBe(READ_ONLY_TOOL_NAMES.has(name));
        // Omitted destructiveHint defaults to true in MCP; all writes explicitly declare it.
        if (!READ_ONLY_TOOL_NAMES.has(name)) {
          expect(tool.annotations?.destructiveHint, name).toBe(DESTRUCTIVE_TOOL_NAMES.has(name));
          expect(tool.annotations?.idempotentHint, name).toBe(false);
        } else if (tool.annotations?.idempotentHint !== undefined) {
          expect(tool.annotations.idempotentHint, name).toBe(true);
        }
        // External Raindrop state: an omitted openWorldHint has the correct MCP default.
        expect(tool.annotations?.openWorldHint, name).not.toBe(false);
        if (tool.outputSchema) {
          expect(tool.outputSchema.type, name).toBe("object");
          for (const branch of objectBranches(tool.outputSchema)) {
            expect(branch.properties, name).toBeDefined();
          }
        }
      }
      expect(tools.filter(tool => CANONICAL_TOOL_NAMES.includes(tool.name) && objectBranches(tool.inputSchema).some(branch => branch.additionalProperties !== false))
        .map(tool => tool.name)).toEqual([]);
      // A passing assessment records known blockers; it does not certify cutover readiness.
      expect(tools.filter(tool => CANONICAL_TOOL_NAMES.includes(tool.name) && !tool.outputSchema)
        .map(tool => tool.name)).toEqual([]);
    } finally { await client.close(); await service.cleanup(); }
  });

  it("enforces representative read/write/destructive schemas before upstream access over tools/call", async () => {
    const fetch = vi.fn(() => { throw new Error("Unexpected HTTP"); });
    vi.stubGlobal("fetch", fetch);
    const service = new RaindropMCPService({ accessToken: "mock-only" });
    const exists = vi.spyOn(service.raindropService, "bookmarkExists")
      .mockResolvedValue({ exists: false, ids: [] });
    const client = new Client({ name: "t10-strict-calls", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([service.getServer().connect(st), client.connect(ct)]);
      const result = await client.callTool({ name: "bookmark_exists", arguments: { url: "https://example.com" } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ exists: false, ids: [] });
      for (const [name, args] of [
        ["collection_list", { skipCache: true, extra: true }],
        ["collection_list", { skipCache: "true" }],
        ["bookmark_exists", { url: "https://example.com", extra: true }],
        ["bookmark_get", { id: "42" }],
        ["bookmark_create", { url: "https://example.com", extra: true }],
        ["collection_create", { title: "Test", extra: true }],
        ["tag_delete", { tagNames: ["test"], extra: true }],
        ["highlight_delete", { bookmarkId: 42, highlightId: 123 }],
        ["bookmark_batch_delete", { collectionId: -99, ids: [42] }],
        ["collection_remove_empty", { rootId: 42, confirm: true }],

      ] as const) {
        expect((await client.callTool({ name, arguments: args })).isError, name).toBe(true);
      }
      expect(exists).toHaveBeenCalledExactlyOnceWith("https://example.com");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await client.close(); await service.cleanup();
      exists.mockRestore(); vi.unstubAllGlobals();
    }
  });
});

describe("Raindrop MCP capability contract", () => {
  it("exposes the approved Agent tool names", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });

    try {
      const tools = await service.listTools();
      const actual = tools.map((tool) => tool.id).sort();

      expect(actual).toEqual(EXPECTED_TOOL_NAMES);
      expect(actual).toHaveLength(24);
      expect(actual).not.toContain("diagnostics");
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

describe("collection_list live cross-endpoint overlap", () => {
  it("deduplicates the same collection across roots and children while keeping its parent", async () => {
    const service = new RaindropMCPService({ accessToken: "mock-only" });
    vi.spyOn(service.raindropService, "getCollections").mockResolvedValue([
      { _id: 123, title: "Shared", count: 4 },
      { _id: 456, title: "Other", count: 0 },
    ] as Awaited<ReturnType<typeof service.raindropService.getCollections>>);
    vi.spyOn(service.raindropService, "getAllChildCollections").mockResolvedValue([
      { _id: 123, title: "Shared", count: 4, parent: { $id: 456 } },
    ] as Awaited<ReturnType<typeof service.raindropService.getAllChildCollections>>);
    const client = new Client({ name: "overlap-read", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([service.getServer().connect(b), client.connect(a)]);
      const response = await client.callTool({ name: "collection_list", arguments: { skipCache: true } });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        count: 2, collections: [
          { id: 123, title: "Shared", parentId: 456 },
          { id: 456, title: "Other" },
        ],
      });
    } finally { await client.close(); await service.cleanup(); }
  });

  it("rejects same ID with conflicting titles instead of hiding API inconsistency", async () => {
    const service = new RaindropMCPService({ accessToken: "mock-only" });
    vi.spyOn(service.raindropService, "getCollections").mockResolvedValue([
      { _id: 123, title: "Before" },
    ] as Awaited<ReturnType<typeof service.raindropService.getCollections>>);
    vi.spyOn(service.raindropService, "getAllChildCollections").mockResolvedValue([
      { _id: 123, title: "After" },
    ] as Awaited<ReturnType<typeof service.raindropService.getAllChildCollections>>);
    try {
      await expect(service.callTool("collection_list", {}))
        .rejects.toThrow("Conflicting collection metadata");
    } finally { await service.cleanup(); }
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

      for (const systemId of [-1, -99]) {
        get.mockResolvedValueOnce({
          _id: 123, title: "Example", link: "https://example.com/a",
          tags: [], collection: { $id: systemId },
        } as Awaited<ReturnType<typeof service.raindropService.getBookmark>>);
        const systemResult = await client.callTool({
          name: "bookmark_get", arguments: { id: 123 },
        });
        expect(systemResult.isError).not.toBe(true);
        expect(systemResult.structuredContent).toMatchObject({
          bookmark: { id: 123, collectionId: systemId },
        });
      }

      for (const badId of [0, -1, 1.5, "123abc"]) {
        const invalid = await client.callTool({
          name: "bookmark_get", arguments: { id: badId },
        });
        expect(invalid.isError).toBe(true);
      }
      expect(get).toHaveBeenCalledTimes(3);
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
  it("reads filter statistics without client Sampling", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });
    const filters = vi.spyOn(service.raindropService, "getBookmarkFilters")
      .mockResolvedValue({ important: 5 });
    const client = new Client({ name: "bookmark-helpers-contract", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        service.getServer().connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const { tools } = await client.listTools();
      expect(tools.find(tool => tool.name === "bookmark_filters_get")?.annotations?.readOnlyHint).toBe(true);
      expect(tools.some(tool => tool.name === "bookmark_suggest")).toBe(false);
      await expect(client.callTool({
        name: "bookmark_suggest", arguments: { bookmarkId: 123 },
      })).rejects.toThrow(/Tool bookmark_suggest not found/);
      const stats = await client.callTool({
        name: "bookmark_filters_get",
        arguments: { collectionId: 0, tagsSort: "-count" },
      });
      expect(stats.isError).not.toBe(true);
      expect(stats.structuredContent).toEqual({ filters: { important: 5 } });
      expect(filters).toHaveBeenCalledWith(0, "-count", undefined);

      expect((await client.callTool({
        name: "bookmark_filters_get", arguments: { collectionId: -99 },
      })).isError).toBe(true);
      expect(filters).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await service.cleanup();
      filters.mockRestore();
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
      .mockResolvedValue({ _id: 55, title: "Test", public: false } as unknown as Awaited<ReturnType<typeof service.raindropService.createCollection>>);
    const update = vi.spyOn(service.raindropService, "updateCollection")
      .mockResolvedValue({ _id: 55, title: "Renamed" } as unknown as Awaited<ReturnType<typeof service.raindropService.updateCollection>>);
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
        status: "succeeded", collection: { id: 55, title: "Test" },
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
        status: "succeeded", collection: { id: 55, title: "Renamed" },
      });
      expect(update).toHaveBeenCalledWith(55, { title: "Renamed" });

      // A lost write reply must not look like a proven rejection or a success.
      create.mockRejectedValueOnce(new TypeError("connection lost after POST"));
      const uncertainCreate = await client.callTool({
        name: "collection_create", arguments: { title: "Disposable" },
      });
      expect(uncertainCreate.isError).not.toBe(true);
      expect(uncertainCreate.structuredContent).toMatchObject({
        status: "unknown", reason: expect.stringMatching(/do not automatically retry/),
      });
      update.mockRejectedValueOnce(new TypeError("connection lost after PUT"));
      const uncertainUpdate = await client.callTool({
        name: "collection_update", arguments: { id: 55, title: "After" },
      });
      expect(uncertainUpdate.isError).not.toBe(true);
      expect(uncertainUpdate.structuredContent).toMatchObject({
        status: "unknown", id: 55, reason: expect.stringMatching(/do not automatically retry/),
      });

      // 429 is an explicit upstream refusal, not a lost response. Keep the
      // rate-limit error and its retry guidance, but do not replay a write.
      create.mockRejectedValueOnce(new RateLimitError("Retry after 30s"));
      const rateLimitedCreate = await client.callTool({
        name: "collection_create", arguments: { title: "RateLimited" },
      });
      expect(rateLimitedCreate.isError).toBe(true);
      expect(JSON.stringify(rateLimitedCreate)).toMatch(/Retry after 30s/);
      update.mockRejectedValueOnce(new RateLimitError("Retry after 30s"));
      const rateLimitedUpdate = await client.callTool({
        name: "collection_update", arguments: { id: 55, title: "RateLimited" },
      });
      expect(rateLimitedUpdate.isError).toBe(true);
      expect(JSON.stringify(rateLimitedUpdate)).toMatch(/Retry after 30s/);
    } finally {
      await client.close();
      await service.cleanup();
      create.mockRestore();
      update.mockRestore();
    }
  });
});


describe("T03 atomic bookmark writes over public MCP", () => {
  it("rejects invalid schemas and verifies small create/update/move effects", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });
    const existing = { _id: 23, link: "https://example.com", title: "Old",
      tags: [], collection: { $id: 11 } };
    const get = vi.spyOn(service.raindropService, "getBookmark")
      .mockResolvedValue(existing as Awaited<ReturnType<typeof service.raindropService.getBookmark>>);
    const getCollection = vi.spyOn(service.raindropService, "getCollection")
      .mockResolvedValue({ _id: 22, title: "Target" } as Awaited<ReturnType<typeof service.raindropService.getCollection>>);
    const create = vi.spyOn(service.raindropService, "createBookmark")
      .mockResolvedValue({ ...existing, _id: 24, title: "Created" } as Awaited<ReturnType<typeof service.raindropService.createBookmark>>);
    const update = vi.spyOn(service.raindropService, "updateBookmark")
      .mockResolvedValueOnce({ ...existing, title: "Edited" } as Awaited<ReturnType<typeof service.raindropService.updateBookmark>>)
      .mockResolvedValueOnce({ ...existing, collection: { $id: 22 } } as Awaited<ReturnType<typeof service.raindropService.updateBookmark>>);
    const client = new Client({ name: "t03-write-contract", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([service.getServer().connect(st), client.connect(ct)]);
      const { tools } = await client.listTools();
      for (const name of ["bookmark_create", "bookmark_update", "bookmark_move", "bookmark_delete"]) {
        expect(tools.find(tool => tool.name === name)?.annotations?.readOnlyHint).toBe(false);
      }
      for (const bad of [{}, { title: "No URL" },
        { url: "file:///x" }, { url: "https://example.com", extra: 1 },
        { url: "https://example.com", collectionId: -99 }]) {
        expect((await client.callTool({ name: "bookmark_create", arguments: bad })).isError).toBe(true);
      }
      const made = await client.callTool({
        name: "bookmark_create", arguments: { url: "https://example.com" },
      });
      expect(made.isError).not.toBe(true);
      expect(made.structuredContent).toMatchObject({ status: "succeeded",
        bookmark: { id: 24, title: "Created" } });
      expect(create).toHaveBeenCalledWith(undefined, { link: "https://example.com" });
      for (const bad of [{ id: 23 }, { id: 23, extra: 1 },
        { id: "23", title: "Edited" }, { id: 0, title: "Edited" }]) {
        expect((await client.callTool({ name: "bookmark_update", arguments: bad })).isError).toBe(true);
      }
      const edited = await client.callTool({
        name: "bookmark_update", arguments: { id: 23, title: "Edited" },
      });
      expect(edited.isError).not.toBe(true);
      expect(edited.structuredContent).toMatchObject({ status: "succeeded" });
      expect(update).toHaveBeenCalledWith(23, { title: "Edited" });
      for (const bad of [{ id: 23, collectionId: 0 },
        { id: 23, collectionId: -99 }, { id: 23, collectionId: 22, extra: true }]) {
        expect((await client.callTool({ name: "bookmark_move", arguments: bad })).isError).toBe(true);
      }
      const moved = await client.callTool({
        name: "bookmark_move", arguments: { id: 23, collectionId: 22 },
      });
      expect(moved.structuredContent).toMatchObject({ status: "succeeded" });
      expect(getCollection).toHaveBeenCalledWith(22, true);
      expect(update).toHaveBeenCalledWith(23, { collection: { $id: 22 } });
      expect(create).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledTimes(2);
      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      await client.close(); await service.cleanup();
      get.mockRestore(); getCollection.mockRestore(); create.mockRestore(); update.mockRestore();
    }
  });

  it("only moves non-Trash bookmarks to Trash and never replays uncertain deletes", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });
    const normal = { _id: 7, link: "https://example.com", title: "Example",
      tags: [], collection: { $id: 11 } };
    const trash = { ...normal, collection: { $id: -99 } };
    const get = vi.spyOn(service.raindropService, "getBookmark");
    const remove = vi.spyOn(service.raindropService, "deleteBookmark").mockResolvedValue(undefined);
    const client = new Client({ name: "spec145-soft-delete", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([service.getServer().connect(st), client.connect(ct)]);
      const permanent = await client.callTool({ name: "bookmark_delete", arguments: { id: 7, permanent: true } });
      expect(permanent.isError).toBe(true);
      expect(get).not.toHaveBeenCalled();
      get.mockResolvedValueOnce(trash as Awaited<ReturnType<typeof service.raindropService.getBookmark>>);
      expect((await client.callTool({ name: "bookmark_delete", arguments: { id: 7 } })).isError).toBe(true);
      expect(remove).not.toHaveBeenCalled();
      get.mockResolvedValueOnce(normal as Awaited<ReturnType<typeof service.raindropService.getBookmark>>);
      const soft = await client.callTool({ name: "bookmark_delete", arguments: { id: 7 } });
      expect(soft.structuredContent).toEqual({ status: "succeeded", id: 7, outcome: "trashed" });
      get.mockResolvedValueOnce(normal as Awaited<ReturnType<typeof service.raindropService.getBookmark>>);
      remove.mockRejectedValueOnce(new Error("network acknowledgement lost"));
      const uncertain = await client.callTool({ name: "bookmark_delete", arguments: { id: 7 } });
      expect(uncertain.structuredContent).toMatchObject({ status: "unknown", id: 7 });
      expect(remove).toHaveBeenCalledTimes(2);
      expect(remove).toHaveBeenNthCalledWith(1, 7, 11);
      expect(remove).toHaveBeenNthCalledWith(2, 7, 11);
      expect(get).toHaveBeenCalledTimes(3);
    } finally {
      await client.close(); await service.cleanup(); get.mockRestore(); remove.mockRestore();
    }
  });
});



describe("T03 unsafe source-state preflight", () => {
  it("rejects a global/unknown collection marker before update or move", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });
    const get = vi.spyOn(service.raindropService, "getBookmark")
      .mockResolvedValue({ _id: 23, link: "https://example.com", title: "Old",
        tags: [], collection: { $id: 0 } } as Awaited<ReturnType<typeof service.raindropService.getBookmark>>);
    const put = vi.spyOn(service.raindropService, "updateBookmark");
    const getCollection = vi.spyOn(service.raindropService, "getCollection");
    const client = new Client({ name: "source-state-preflight", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([service.getServer().connect(st), client.connect(ct)]);
      expect((await client.callTool({ name: "bookmark_update",
        arguments: { id: 23, title: "Edited" } })).isError).toBe(true);
      expect((await client.callTool({ name: "bookmark_move",
        arguments: { id: 23, collectionId: 22 } })).isError).toBe(true);
      expect(put).not.toHaveBeenCalled();
      expect(getCollection).not.toHaveBeenCalled();
    } finally {
      await client.close(); await service.cleanup();
      get.mockRestore(); put.mockRestore(); getCollection.mockRestore();
    }
  });
});

const items = ["a", "b", "target"].map((_id) => ({ _id, count: 2 }));
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
function mockHttp(
  write: () => Response | Promise<Response> = () => json({ result: true }),
) {
  const fetch = vi.fn(async (request: Request) =>
    request.method === "GET" ? json({ result: true, items }) : write(),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function withMcp(work: (client: Client) => Promise<void>) {
  const service = new RaindropMCPService({
    accessToken: "test",
    maxReadRetries: 0,
  });
  const client = new Client({ name: "tag-contract", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([service.getServer().connect(st), client.connect(ct)]);
    await work(client);
  } finally {
    await client.close();
    await service.cleanup();
  }
}

describe("tag MCP tools/list and tools/call contract", () => {
  it("advertises strict independent tools and validates their successful outputs over HTTP mocks", async () => {
    const fetch = mockHttp();
    await withMcp(async (client) => {
      const { tools } = await client.listTools();
      for (const name of [
        "tag_list",
        "tag_rename",
        "tag_merge",
        "tag_delete",
      ]) {
        const tool = tools.find((tool) => tool.name === name)!;
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool.outputSchema).toBeDefined();
        expect(tool.annotations?.readOnlyHint).toBe(name === "tag_list");
      }
      const listed = await client.callTool({ name: "tag_list", arguments: {} });
      expect(listed.isError).not.toBe(true);
      expect(listed.structuredContent).toEqual({
        collectionId: 0,
        tags: items,
      });
      for (const [name, args] of [
        ["tag_rename", { oldName: "a", newName: "fresh" }],
        ["tag_merge", { tagNames: ["a", "b"], newName: "target" }],
        ["tag_delete", { tagNames: ["b"] }],

      ] as const) {
        const result = await client.callTool({
          name,
          arguments: { ...args, collectionId: 42 },
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          status: "succeeded",
          success: true,
          collectionId: 42,
        });
      }
    });
    expect(fetch).toHaveBeenCalledTimes(7);
  });

  it("supports an explicit global tag mutation only with collectionId:0", async () => {
    const fetch = mockHttp();
    await withMcp(async (client) => {
      const result = await client.callTool({
        name: "tag_rename",
        arguments: { collectionId: 0, oldName: "a", newName: "fresh" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        collectionId: 0, status: "succeeded", success: true,
      });
    });
    expect(fetch.mock.calls.some(([request]) => request.method === "PUT")).toBe(true);
  });

  it("rejects strict, empty, duplicate, nonexistent and conflicting inputs including legacy bypasses", async () => {
    const fetch = mockHttp();
    await withMcp(async (client) => {
      // No tag mutation may silently turn an omitted scope into global /tags/0.
      for (const [name, args] of [
        ["tag_rename", { oldName: "a", newName: "fresh" }],
        ["tag_merge", { tagNames: ["a", "b"], newName: "target" }],
        ["tag_delete", { tagNames: ["a"] }],
      ] as const) {
        expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
      }
      for (const [name, args] of [
        ["tag_list", { collectionId: -1 }],
        ["tag_list", { collectionId: 1.5 }],
        ["tag_list", { collectionId: "42" }],
        ["tag_list", { collectionId: Number.MAX_SAFE_INTEGER + 1 }],
        ["tag_list", { extra: true }],
        ["tag_rename", { oldName: "", newName: "fresh" }],
        ["tag_rename", { oldName: "a", newName: "target" }],
        ["tag_rename", { oldName: "a", newName: "a" }],
        ["tag_merge", { tagNames: ["a"], newName: "fresh" }],
        ["tag_merge", { tagNames: ["a", "a"], newName: "fresh" }],
        ["tag_merge", { tagNames: ["a", "b"], newName: "a" }],
        ["tag_merge", { tagNames: ["a", "missing"], newName: "target" }],
        ["tag_delete", { tagNames: [] }],
        ["tag_delete", { tagNames: [" "] }],
        ["tag_delete", { tagNames: ["a", "a"] }],
        ["tag_delete", { tagNames: ["missing"], collectionId: 42 }],
        ["tag_delete", { tagNames: ["a"], newName: "ignored" }],




      ] as const) {
        expect((await client.callTool({ name, arguments: args })).isError).toBe(
          true,
        );
      }
    });
    expect(
      fetch.mock.calls.every(([request]) => request.method === "GET"),
    ).toBe(true);
  });

  it.each(["false", "unknown", "429", "preflight"])(
    "reports %s without claiming completion or replaying",
    async (failure) => {
      const fetch =
        failure === "preflight"
          ? vi.fn(async () => json({ result: false }))
          : mockHttp(() => {
              if (failure === "unknown") throw new TypeError("connection lost");
              if (failure === "429")
                return new Response("limited", { status: 429 });
              return json({ result: false });
            });
      vi.stubGlobal("fetch", fetch);
      await withMcp(async (client) => {
        for (const [name, args] of [
          ["tag_rename", { oldName: "a", newName: "fresh" }],
          ["tag_merge", { tagNames: ["a", "b"], newName: "target" }],
          ["tag_delete", { tagNames: ["a"] }],


        ] as const) {
          const result = await client.callTool({ name, arguments: { ...args, collectionId: 42 } });
          if (failure === "unknown") {
            expect(result.structuredContent).toMatchObject({
              status: "unknown",
              success: false,
            });
          } else {
            expect(result.isError).toBe(true);
            expect(result.structuredContent).toBeUndefined();
          }
        }
      });
      expect(fetch).toHaveBeenCalledTimes(failure === "preflight" ? 3 : 6);
    },
  );
});

describe("highlight atomic and Draft compatibility contracts", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const highlight = { _id: "string-highlight-id", text: "Quote", color: "yellow" as const };
  const confirmed = { status: "succeeded" as const, bookmarkId: 42, highlightId: highlight._id, highlight, deleted: false };

  it("delegates all atomic actions and safe legacy inputs to the centralized Service", async () => {
    const service = new RaindropMCPService({ accessToken: "mock-only" });
    const list = vi.spyOn(service.raindropService, "getHighlights").mockResolvedValue([highlight]);
    const create = vi.spyOn(service.raindropService, "createHighlight").mockResolvedValue(confirmed);
    const update = vi.spyOn(service.raindropService, "updateHighlight").mockResolvedValue(confirmed);
    const deleted = { ...confirmed, highlight: null, deleted: true };
    const remove = vi.spyOn(service.raindropService, "deleteHighlight").mockResolvedValue(deleted);
    try {
      expect((await service.callTool("highlight_list", { bookmarkId: 42 })).structuredContent).toEqual({ bookmarkId: 42, highlights: [highlight] });
      expect((await service.callTool("highlight_create", { bookmarkId: 42, text: "Quote" })).structuredContent).toEqual(confirmed);
      expect((await service.callTool("highlight_update", { bookmarkId: 42, highlightId: highlight._id, color: "blue" })).structuredContent).toEqual(confirmed);
      expect((await service.callTool("highlight_delete", { bookmarkId: 42, highlightId: highlight._id })).structuredContent).toEqual(deleted);
      expect(list).toHaveBeenCalledExactlyOnceWith(42);
      expect(create).toHaveBeenCalledWith(42, { text: "Quote" });
      expect(update).toHaveBeenCalledWith(42, highlight._id, { color: "blue" });
      expect(remove).toHaveBeenCalledWith(42, highlight._id);
    } finally { await service.cleanup(); }
  });

  it("rejects invalid/legacy inputs before HTTP, including missing bookmark scope", async () => {
    const fetch = vi.fn(() => { throw new Error("Unexpected HTTP"); });
    vi.stubGlobal("fetch", fetch);
    const service = new RaindropMCPService({ accessToken: "mock-only" });
    try {
      for (const tool of ["highlight_list", "highlight_create", "highlight_update", "highlight_delete"]) {
        for (const bookmarkId of [undefined, null, "42", -1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
          const args = tool === "highlight_list" ? { bookmarkId }
            : tool === "highlight_create" ? { bookmarkId, text: "Quote" }
            : tool === "highlight_delete" ? { bookmarkId, highlightId: "id" }
            : { bookmarkId, highlightId: "id", color: "blue", ...(tool === "highlight_manage" ? { operation: "update" } : {}) };
          await expect(service.callTool(tool, args)).rejects.toThrow();
        }
      }
      const invalid: Array<[string, Record<string, unknown>]> = [
        ["highlight_list", { bookmarkId: 42, extra: true }],
        ["highlight_create", { bookmarkId: 42, text: "" }],
        ["highlight_create", { bookmarkId: 42, text: " " }],
        ["highlight_create", { bookmarkId: 42, text: "Quote", color: "black" }],
        ["highlight_create", { bookmarkId: 42, text: "Quote", highlightId: "injected" }],
        ["highlight_update", { bookmarkId: 42, highlightId: "id" }],
        ["highlight_update", { bookmarkId: 42, highlightId: "id", text: "" }],
        ["highlight_update", { bookmarkId: 42, highlightId: 123, color: "blue" }],
        ["highlight_delete", { bookmarkId: 42, highlightId: "" }],
        ["highlight_delete", { bookmarkId: 42, highlightId: "id", note: "ignored?" }],
      ];
      for (const [name, args] of invalid) await expect(service.callTool(name, args)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    } finally { await service.cleanup(); }
  });

  it("exposes atomic schemas and confirmed/unknown outcomes over MCP tools/call", async () => {
    const service = new RaindropMCPService({ accessToken: "mock-only" });
    vi.spyOn(service.raindropService, "getHighlights").mockResolvedValue([highlight]);
    vi.spyOn(service.raindropService, "createHighlight").mockResolvedValue(confirmed);
    const update = vi.spyOn(service.raindropService, "updateHighlight").mockResolvedValue(confirmed);
    vi.spyOn(service.raindropService, "deleteHighlight").mockResolvedValue({ ...confirmed, highlight: null, deleted: true });
    const client = new Client({ name: "highlights-contract", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await service.getServer().connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(24);
      for (const name of ["highlight_list", "highlight_create", "highlight_update", "highlight_delete"]) {
        const tool = tools.tools.find(t => t.name === name)!;
        expect(tool.inputSchema.required).toContain("bookmarkId");
        expect(tool.annotations?.readOnlyHint).toBe(name === "highlight_list");
        if (name !== "highlight_list") expect(tool.annotations?.idempotentHint).toBe(false);
      }
      for (const [name, args] of [
        ["highlight_list", { bookmarkId: 42 }],
        ["highlight_create", { bookmarkId: 42, text: "Quote" }],
        ["highlight_update", { bookmarkId: 42, highlightId: highlight._id, color: "blue" }],
        ["highlight_delete", { bookmarkId: 42, highlightId: highlight._id }],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ bookmarkId: 42 });
      }
      update.mockResolvedValue({ status: "unknown", bookmarkId: 42, highlightId: highlight._id, reason: "Result unknown; inspect before retry" });
      const unknown = await client.callTool({ name: "highlight_update", arguments: { bookmarkId: 42, highlightId: highlight._id, color: "blue" } });
      expect(unknown.isError).not.toBe(true);
      expect(unknown.structuredContent).toMatchObject({ status: "unknown" });
      const invalid = await client.callTool({ name: "highlight_update", arguments: { bookmarkId: 42, highlightId: 123, color: "blue" } });
      expect(invalid.isError).toBe(true);
      update.mockRejectedValue(new Error("403 permission denied"));
      expect((await client.callTool({ name: "highlight_update", arguments: { bookmarkId: 42, highlightId: highlight._id, color: "blue" } })).isError).toBe(true);
    } finally { await client.close(); await service.cleanup(); }
  });
});
