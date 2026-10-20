import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";
import { createReadOnlyRaindropFetch } from "./read-only-fetch-guard.js";

// Explicit manual gate. This test must NEVER be enabled merely by providing
// a token to the normal CI/build process.
const enabled = process.env.RUN_LIVE_API_TESTS === "true";
const suite = enabled ? describe : describe.skip;

suite("Spec #123 authenticated read-only MCP smoke", () => {
  let client: Client;
  let service: RaindropMCPService;
  let bookmarkId: number | undefined;
  let collectionId: number | undefined;
  let readCount = 0;

  beforeAll(async () => {
    const token = process.env.RAINDROP_ACCESS_TOKEN?.trim();
    if (!token) throw new Error("RUN_LIVE_API_TESTS requires an injected RAINDROP_ACCESS_TOKEN");

    // Guard against writes, unexpected upstream hosts and redirects carrying
    // Authorization. Read-only POST /import/url/exists is not exercised here.
    const networkFetch = globalThis.fetch;
    const readOnlyFetch = createReadOnlyRaindropFetch(networkFetch);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await readOnlyFetch(input, init);
      readCount++;
      return response;
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
    for (const name of ["collection_list", "collection_get", "bookmark_search", "bookmark_get", "tag_list", "highlight_list", "bookmark_filters_get", "bookmark_suggest"]) {
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
    // Do not treat the untested collection_get as a successful smoke.
    expect(collections.length).toBeGreaterThan(0);
    collectionId = collections[0]!.id as number;
  });

  it("reads the first available real collection with collection_get", async () => {
    if (collectionId === undefined) throw new Error("Collection GET was not exercised: no collection ID");
    const result = await read("collection_get", { id: collectionId, skipCache: true });
    const collection = result.collection as Record<string, unknown>;
    expect(collection.id).toBe(collectionId);
    expect(typeof collection.title).toBe("string");
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
    // The existing production account has saved bookmarks. A zero-result
    // page cannot validate the subsequent get, highlights or suggestions.
    expect(items.length).toBe(1);
    bookmarkId = items[0]!.id as number;
  });

  it("reads a real bookmark through the candidate bookmark_get when one exists", async () => {
    if (bookmarkId === undefined) throw new Error("Bookmark-dependent live smoke was not exercised");
    const result = await read("bookmark_get", { id: bookmarkId, skipCache: true });
    const bookmark = result.bookmark as Record<string, unknown>;
    expect(bookmark.id).toBe(bookmarkId);
    expect(typeof bookmark.url).toBe("string");
    expect(Array.isArray(bookmark.tags)).toBe(true);
  });

  it("reads a bookmark's highlights without writing", async () => {
    if (bookmarkId === undefined) throw new Error("Bookmark-dependent live smoke was not exercised");
    const result = await read("highlight_list", { bookmarkId });
    expect(result.bookmarkId).toBe(bookmarkId);
    expect(Array.isArray(result.highlights)).toBe(true);
  });

  it("gets official suggestions for an existing bookmark via GET", async () => {
    if (bookmarkId === undefined) throw new Error("Bookmark-dependent live smoke was not exercised");
    const result = await read("bookmark_suggest", { bookmarkId });
    const suggestions = result.suggestions as Record<string, unknown>;
    expect(Array.isArray(suggestions.tags)).toBe(true);
    expect(Array.isArray(suggestions.collectionIds)).toBe(true);
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
