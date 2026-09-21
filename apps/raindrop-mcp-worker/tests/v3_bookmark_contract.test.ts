import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

afterEach(() => vi.unstubAllGlobals());

const item = {
  _id: 17, link: "https://example.com/", title: "Example", excerpt: "",
  tags: [], important: false, collection: { $id: -1 },
  note: "note retained in full", highlights: [{ _id: "highlight-1", text: "quotation" }],
  reminder: { date: "2026-10-01T00:00:00.000Z" },
};
const service = () => new RaindropMCPService({ accessToken: "fake", maxReadRetries: 0 });
const fake = (handler: (request: Request) => Promise<Response> | Response) => {
  const spy = vi.fn(handler);
  vi.stubGlobal("fetch", spy);
  return spy;
};

describe("five bounded v3 Raindrop bookmark contracts", () => {
  it("lists one official page, preserves filter/search, and returns truthful pagination", async () => {
    const spy = fake((request) => {
      const url = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(url.pathname).toBe("/rest/v1/raindrops/0");
      expect(url.searchParams.get("search")).toBe("#engineering important:true");
      expect(url.searchParams.get("page")).toBe("0");
      expect(url.searchParams.get("perpage")).toBe("1");
      expect(url.searchParams.get("sort")).toBe("-created");
      expect(url.searchParams.get("nested")).toBe("false");
      return Response.json({ result: true, items: [item], count: 2 });
    });
    const result = await service().callTool("raindrop_list", {
      search: "#engineering important:true", perpage: 1,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      ok: true, data: { items: [{ _id: 17, link: item.link }] },
      meta: { page: 0, perpage: 1, returned: 1, total: 2, hasMore: true, nextPage: 1, requestCount: 1 },
    });
  });

  it("keeps total unknown when upstream omits count; a full page does not prove next exists", async () => {
    const spy = fake(() => Response.json({ result: true, items: [item] }));
    const result = await service().callTool("raindrop_list", { perpage: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.structuredContent.meta).toMatchObject({
      total: null, hasMore: null, nextPage: 1,
    });
  });

  it("gets complete documented detail, including note, highlights and reminder", async () => {
    const spy = fake((request) => {
      expect(new URL(request.url).pathname).toBe("/rest/v1/raindrop/17");
      return Response.json({ result: true, item });
    });
    const result = await service().callTool("raindrop_get", { id: 17 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      ok: true, data: { item: {
        _id: 17, note: item.note, highlights: item.highlights, reminder: item.reminder,
      } },
    });
  });

  it("creates from link alone, defaulting to Unsorted without inventing a title", async () => {
    const spy = fake(async (request) => {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/rest/v1/raindrop");
      const body = await request.json() as Record<string, unknown>;
      expect(body).toMatchObject({ link: item.link, collection: { $id: -1 }, pleaseParse: {} });
      expect(body).not.toHaveProperty("title");
      return Response.json({ result: true, item });
    });
    const result = await service().callTool("raindrop_create", { link: item.link });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      ok: true, meta: { status: "succeeded", requestCount: 1 }, data: { item: { _id: 17 } },
    });
  });

  it("updates only explicit note and preserves false, empty arrays and empty strings", async () => {
    const bodies: Record<string, unknown>[] = [];
    const spy = fake(async (request) => {
      expect(request.method).toBe("PUT");
      expect(new URL(request.url).pathname).toBe("/rest/v1/raindrop/17");
      bodies.push(await request.json() as Record<string, unknown>);
      return Response.json({ result: true, item });
    });
    const s = service();
    const note = await s.callTool("raindrop_update", { id: 17, note: "only" });
    const empty = await s.callTool("raindrop_update", {
      id: 17, important: false, tags: [], note: "",
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(bodies).toEqual([
      { note: "only" }, { important: false, tags: [], note: "" },
    ]);
    expect(note.structuredContent.meta.status).toBe("succeeded");
    expect(empty.structuredContent.meta.status).toBe("succeeded");
  });

  it.each([
    ["non-integer ID", "raindrop_get", { id: 1.2 }],
    ["numeric ID as string", "raindrop_get", { id: "17" }],
    ["score without search", "raindrop_list", { sort: "score" }],
    ["unsupported sort", "raindrop_list", { sort: "newest" }],
    ["out-of-range perpage", "raindrop_list", { perpage: 51 }],
    ["unknown write field", "raindrop_update", { id: 17, cover: "url" }],
    ["oversized note", "raindrop_create", { link: item.link, note: "x".repeat(10001) }],
    ["empty update", "raindrop_update", { id: 17 }],
    ["invalid collection", "raindrop_create", { link: item.link, collection: 0 }],
    ["ambiguous suggestion", "raindrop_suggest", { id: 17, link: item.link }],
  ])("rejects %s before any upstream request", async (_name, name, args) => {
    const spy = fake(() => Response.json({ item }));
    const result = await service().callTool(name, args);
    expect(result.structuredContent).toMatchObject({
      ok: false, error: { code: "VALIDATION_ERROR" }, meta: { status: "not_executed", requestCount: 0 },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("uses one official suggestion endpoint for each target and no model sampling", async () => {
    const spy = fake(async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST") {
        expect(url.pathname).toBe("/rest/v1/raindrop/suggest");
        expect(await request.json()).toEqual({ link: item.link });
      } else {
        expect(url.pathname).toBe("/rest/v1/raindrop/17/suggest");
      }
      return Response.json({ result: true, item: { tags: ["engineering"], collections: [] } });
    });
    const s = service();
    const byId = await s.callTool("raindrop_suggest", { id: 17 });
    const byLink = await s.callTool("raindrop_suggest", { link: item.link });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(byId.structuredContent.ok).toBe(true);
    expect(byLink.structuredContent.ok).toBe(true);
  });

  it.each([
    [429, "RATE_LIMITED"],
    [503, "UPSTREAM_ERROR"],
  ])("classifies failed read-only URL suggestion POST (%i) without claiming a mutation", async (status, expectedCode) => {
    const spy = fake((request) => {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/rest/v1/raindrop/suggest");
      return new Response(null, { status });
    });
    const result = await service().callTool("raindrop_suggest", { link: item.link });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: expectedCode, upstreamStatus: status },
        meta: { status: "not_executed", requestCount: 1 },
      },
    });
    expect(result.structuredContent.error.code).not.toBe("WRITE_OUTCOME_UNKNOWN");
  });

  it("registers the five tools for a real in-memory MCP client", async () => {
    const spy = fake(() => Response.json({ result: true, item }));
    const s = service();
    const client = new Client({ name: "v3-contract-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([s.getServer().connect(serverTransport), client.connect(clientTransport)]);
      const listed = await client.listTools();
      for (const name of ["raindrop_list", "raindrop_get", "raindrop_create", "raindrop_update", "raindrop_suggest"]) {
        expect(listed.tools.find((tool) => tool.name === name)).toBeDefined();
      }
      const result = await client.callTool({ name: "raindrop_get", arguments: { id: 17 } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: true, data: { item: { _id: 17 } } });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await s.cleanup();
    }
  });
});
