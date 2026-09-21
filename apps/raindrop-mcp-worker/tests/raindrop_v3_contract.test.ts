import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

afterEach(() => vi.unstubAllGlobals());
const service = () => new RaindropMCPService({ accessToken: "fake", maxReadRetries: 0 });

describe("Raindrop v3 official bookmark tracer", () => {
  it("lists precisely one official page, returning compact fields and truthful pagination", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(url.pathname).toBe("/rest/v1/raindrops/0");
      expect(url.searchParams.get("page")).toBe("0");
      expect(url.searchParams.get("perpage")).toBe("25");
      expect(url.searchParams.get("sort")).toBe("-created");
      return Response.json({
        items: [{ _id: 5, link: "https://example.com", title: "Example", note: "private long note", tags: ["test"] }],
        count: 1,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await service().callTool("raindrop_list", {});
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { items: [{ _id: 5, link: "https://example.com" }] },
      meta: { total: 1, returned: 1, hasMore: false, nextPage: null, requestCount: 1 },
    });
    expect(JSON.stringify(result.structuredContent.data.items)).not.toContain("private long note");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not invent a zero total when upstream omits count", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items: [{ _id: 8, link: "https://a.test" }] })));
    const result = await service().callTool("raindrop_list", {});
    expect(result.structuredContent.meta).toMatchObject({
      total: null, hasMore: false, nextPage: null,
    });
  });

  it("keeps full note, highlights and reminder on detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/rest/v1/raindrop/9");
      return Response.json({
        item: { _id: 9, note: "complete note", highlights: [{ _id: "h1", text: "selection" }], reminder: { date: "2030-01-01" } },
      });
    }));
    const result = await service().callTool("raindrop_get", { id: 9 });
    expect(result.structuredContent.data.item).toMatchObject({
      note: "complete note",
      highlights: [{ _id: "h1", text: "selection" }],
      reminder: { date: "2030-01-01" },
    });
  });

  it("creates using just link and defaults to the Unsorted collection", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/rest/v1/raindrop");
      expect(await request.json()).toEqual({
        link: "https://example.com", collection: { $id: -1 }, pleaseParse: {},
      });
      return Response.json({ item: { _id: 19, link: "https://example.com" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await service().callTool("raindrop_create", { link: "https://example.com" });
    expect(result.structuredContent).toMatchObject({
      ok: true, data: { item: { _id: 19 } },
      meta: { status: "succeeded", requestCount: 1 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("updates only supplied fields and preserves empty and false values", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.method).toBe("PUT");
      expect(new URL(request.url).pathname).toBe("/rest/v1/raindrop/19");
      expect(await request.json()).toEqual({ note: "", tags: [], important: false });
      return Response.json({ item: { _id: 19, note: "", tags: [], important: false } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await service().callTool("raindrop_update", {
      id: 19, note: "", tags: [], important: false,
    });
    expect(result.structuredContent).toMatchObject({
      ok: true, data: { item: { _id: 19, note: "", tags: [], important: false } },
      meta: { status: "succeeded", requestedIds: [19], requestCount: 1 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ id: 19 }, "GET", "/rest/v1/raindrop/19/suggest"],
    [{ link: "https://example.com" }, "POST", "/rest/v1/raindrop/suggest"],
  ] as const)("uses the official suggestion endpoint for %j", async (input, method, path) => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.method).toBe(method);
      expect(new URL(request.url).pathname).toBe(path);
      if (method === "POST") expect(await request.json()).toEqual({ link: "https://example.com" });
      return Response.json({ item: { tags: ["official"], collections: [{ $id: 42 }] } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await service().callTool("raindrop_suggest", input);
    expect(result.structuredContent).toMatchObject({
      ok: true, data: { item: { tags: ["official"], collections: [{ $id: 42 }] } },
      meta: { requestCount: 1 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["raindrop_get", { id: "19" }],
    ["raindrop_get", { id: 1.5 }],
    ["raindrop_list", { sort: "+score" }],
    ["raindrop_list", { sort: "-unsupported" }],
    ["raindrop_list", { collectionId: -100 }],
    ["raindrop_create", { link: "ftp://example.com" }],
    ["raindrop_create", { link: "https://example.com", note: "x".repeat(10001) }],
    ["raindrop_update", { id: 19 }],
    ["raindrop_update", { id: 19, reminder: true }],
    ["raindrop_suggest", {}],
    ["raindrop_suggest", { id: 19, link: "https://example.com" }],
  ])("rejects invalid %s input before upstream work: %j", async (tool, input) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await service().callTool(tool as string, input);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: "VALIDATION_ERROR" }, meta: { requestCount: 0 } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies the same validation through a real MCP Client", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = service();
    const client = new Client({ name: "v3-contract", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([app.getServer().connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({
        name: "raindrop_update",
        arguments: { id: 19, note: "", created: "forbidden" },
      });
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await app.cleanup();
    }
  });
});
