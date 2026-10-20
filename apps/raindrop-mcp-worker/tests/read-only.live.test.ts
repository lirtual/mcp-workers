import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

// Explicit manual gate. This test must NEVER be enabled merely by providing
// a token to the normal CI/build process.
const enabled = process.env.RUN_LIVE_API_TESTS === "true";
const suite = enabled ? describe : describe.skip;

suite("Spec #123 authenticated read-only MCP smoke", () => {
  let client: Client;
  let service: RaindropMCPService;
  let bookmarkId: number | undefined;
  let readCount = 0;

  beforeAll(async () => {
    const token = process.env.RAINDROP_ACCESS_TOKEN?.trim();
    if (!token) throw new Error("RUN_LIVE_API_TESTS requires an injected RAINDROP_ACCESS_TOKEN");

    // Guard the entire MCP-to-HTTP boundary against accidental upstream
    // mutation. POST /raindrops/0/exist is intentionally not exercised here.
    const networkFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method !== "GET")
        throw new Error("Read-only acceptance blocked an upstream non-GET request");
      readCount++;
      return networkFetch(request);
    });

    service = new RaindropMCPService({ accessToken: token });
    client = new Client({ name: "spec123-live-readonly", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([service.getServer().connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client?.close();
    await service?.cleanup();
    vi.unstubAllGlobals();
  });

  const read = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError || !result.structuredContent)
      throw new Error(`Read-only MCP smoke failed for ${name} (response content withheld)`);
    return result.structuredContent as Record<string, unknown>;
  };

  it("checks candidate tool registration without calling writes", async () => {
    const listed = await client.listTools();
    for (const name of ["collection_list", "bookmark_search", "bookmark_get", "tag_list", "bookmark_filters_get"]) {
      expect(listed.tools.some((tool) => tool.name === name && tool.annotations?.readOnlyHint === true)).toBe(true);
    }
    expect(readCount).toBe(0);
  });

  it("lists root and child collections with valid IDs", async () => {
    const result = await read("collection_list", { skipCache: true });
    expect(Array.isArray(result.collections)).toBe(true);
    const collections = result.collections as Record<string, unknown>[];
    expect(result.count).toBe(collections.length);
    expect(collections.every((value) => Number.isSafeInteger(value.id) &&
      (value.id as number) > 0 && typeof value.title === "string")).toBe(true);
  });

  it("pages the library through the candidate bookmark_search", async () => {
    const result = await read("bookmark_search", {
      collection: 0, page: 0, perPage: 1, skipCache: true,
    });
    expect(Number.isSafeInteger(result.count)).toBe(true);
    expect(Array.isArray(result.items)).toBe(true);
    const items = result.items as Record<string, unknown>[];
    expect(items.length).toBeLessThanOrEqual(1);
    expect(items.every((value) => Number.isSafeInteger(value.id) &&
      typeof value.url === "string" && Array.isArray(value.tags))).toBe(true);
    if (items.length > 0) bookmarkId = items[0]!.id as number;
  });

  it("reads a real bookmark through the candidate bookmark_get when one exists", async () => {
    if (bookmarkId === undefined) return;
    const result = await read("bookmark_get", { id: bookmarkId, skipCache: true });
    const bookmark = result.bookmark as Record<string, unknown>;
    expect(bookmark.id).toBe(bookmarkId);
    expect(typeof bookmark.url).toBe("string");
    expect(Array.isArray(bookmark.tags)).toBe(true);
  });

  it("gets tag metadata without changing data", async () => {
    const result = await read("tag_list", { collectionId: 0 });
    expect(result.collectionId).toBe(0);
    expect(Array.isArray(result.tags)).toBe(true);
  });

  it("reads filter availability without synthesizing missing fields", async () => {
    const result = await read("bookmark_filters_get", { collectionId: 0 });
    expect(result.filters).toBeDefined();
    expect(typeof result.filters).toBe("object");
    expect(result.filters).not.toBeNull();
  });

  it("never performs a mutation during the entire smoke", () => {
    expect(readCount).toBeGreaterThan(0);
  });
});
