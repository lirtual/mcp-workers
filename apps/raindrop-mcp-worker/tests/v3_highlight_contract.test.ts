import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

afterEach(() => vi.unstubAllGlobals());
const service = () => new RaindropMCPService({ accessToken: "fake", maxReadRetries: 0 });
const fake = (handler: (request: Request) => Promise<Response> | Response) => {
  const mock = vi.fn(handler);
  vi.stubGlobal("fetch", mock);
  return mock;
};
const bookmark = {
  _id: 7, highlights: [
    { _id: "hl-1", text: "alpha", color: "yellow", note: "" },
    { _id: "hl-2", text: "beta", color: "red", note: "note" },
  ],
};

describe("T06: documented v3 highlight contract", () => {
  it.each([
    ["global", {}, "/rest/v1/highlights"],
    ["collection", { collectionId: -1 }, "/rest/v1/highlights/-1"],
  ])("paginates one official %s highlights endpoint", async (_label, input, path) => {
    const mock = fake((request) => {
      expect(request.method).toBe("GET");
      const url = new URL(request.url);
      expect(url.pathname).toBe(path);
      expect(url.searchParams.get("page")).toBe("0");
      expect(url.searchParams.get("perpage")).toBe("1");
      return Response.json({ result: true, items: [bookmark.highlights[0]], count: 2 });
    });
    const result = await service().callTool("highlight_list", { ...input, perpage: 1 });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      ok: true, data: { items: [{ _id: "hl-1" }] },
      meta: { total: 2, hasMore: true, nextPage: 1, returned: 1, requestCount: 1 },
    });
  });

  it("reads a single bookmark once and locally pages its exact highlights", async () => {
    const mock = fake((request) => {
      expect(new URL(request.url).pathname).toBe("/rest/v1/raindrop/7");
      return Response.json({ result: true, item: bookmark });
    });
    const result = await service().callTool("highlight_list", { raindropId: 7, page: 1, perpage: 1 });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      ok: true, data: { items: [{ _id: "hl-2" }] },
      meta: { total: 2, hasMore: false, nextPage: null, requestCount: 1 },
    });
  });

  it("creates via one-element bookmark PUT and never guesses the new _id from text", async () => {
    const mock = fake(async (request) => {
      expect(request.method).toBe("PUT");
      expect(new URL(request.url).pathname).toBe("/rest/v1/raindrop/7");
      expect(await request.json()).toEqual({ highlights: [{ text: "alpha", color: "indigo", note: "" }] });
      return Response.json({ result: true, item: bookmark });
    });
    const result = await service().callTool("highlight_create", {
      raindropId: 7, text: "alpha", color: "indigo", note: "",
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      ok: true, data: { item: { _id: 7 } },
      meta: { status: "succeeded", targetEffectVerified: false, requestCount: 1 },
    });
    expect(JSON.stringify(result.structuredContent.data)).not.toContain("newHighlightId");
  });

  it("sends a note-only update without text and verifies the target by string _id", async () => {
    const mock = fake(async (request) => {
      expect(request.method).toBe("PUT");
      expect(new URL(request.url).pathname).toBe("/rest/v1/raindrop/7");
      expect(await request.json()).toEqual({ highlights: [{ _id: "hl-2", note: "" }] });
      return Response.json({ result: true, item: { _id: 7, highlights: [{ _id: "hl-2", text: "beta", note: "" }] } });
    });
    const result = await service().callTool("highlight_update", { raindropId: 7, _id: "hl-2", note: "" });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      ok: true, meta: { status: "succeeded", targetEffectVerified: true, requestCount: 1 },
    });
  });

  it("previews a specific highlight before exact one-element deletion", async () => {
    const seen: string[] = [];
    const mock = fake(async (request) => {
      seen.push(`${request.method} ${new URL(request.url).pathname}`);
      if (request.method === "GET") return Response.json({ item: bookmark, result: true });
      expect(await request.json()).toEqual({ highlights: [{ _id: "hl-1", text: "" }] });
      return Response.json({ result: true, item: { _id: 7, highlights: bookmark.highlights.slice(1) } });
    });
    const app = service();
    const preview = await app.callTool("highlight_delete", { raindropId: 7, _id: "hl-1" });
    expect(preview.structuredContent).toMatchObject({ ok: true, meta: { status: "preview", requestCount: 1 } });
    expect(mock).toHaveBeenCalledTimes(1);
    const result = await app.callTool("highlight_delete", { raindropId: 7, _id: "hl-1", confirm: true });
    expect(seen).toEqual([
      "GET /rest/v1/raindrop/7", "GET /rest/v1/raindrop/7", "PUT /rest/v1/raindrop/7",
    ]);
    expect(result.structuredContent).toMatchObject({
      ok: true, meta: { status: "succeeded", targetEffectVerified: true, requestCount: 3 },
    });
  });

  it.each([
    ["simultaneous IDs", "highlight_list", { collectionId: 1, raindropId: 7 }],
    ["invalid global alias", "highlight_list", { collectionId: 0 }],
    ["empty create text", "highlight_create", { raindropId: 7, text: "" }],
    ["invalid color", "highlight_create", { raindropId: 7, text: "x", color: "black" }],
    ["note-only missing target", "highlight_update", { raindropId: 7, _id: "hl-1" }],
    ["update cannot delete implicitly", "highlight_update", { raindropId: 7, _id: "hl-1", text: "" }],
    ["numeric highlight ID", "highlight_delete", { raindropId: 7, _id: 5, confirm: true }],
    ["unknown field", "highlight_update", { raindropId: 7, _id: "hl-1", created: "x", note: "" }],
  ])("rejects %s before fetch", async (_label, name, args) => {
    const mock = fake(() => { throw Error("Unexpected upstream request"); });
    const result = await service().callTool(name, args);
    expect(result.structuredContent).toMatchObject({
      ok: false, error: { code: "VALIDATION_ERROR" }, meta: { status: "not_executed", requestCount: 0 },
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it("a submitted highlight write that gets 503 is unknown and never replayed", async () => {
    const mock = fake(() => new Response(null, { status: 503 }));
    const result = await service().callTool("highlight_update", { raindropId: 7, _id: "hl-1", note: "x" });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      ok: false, error: { code: "WRITE_OUTCOME_UNKNOWN", upstreamStatus: 503 },
      meta: { status: "unknown", requestCount: 1 },
    });
  });

  it("exposes the contract through a real in-memory MCP Client", async () => {
    const mock = fake(() => { throw Error("Unexpected upstream request"); });
    const app = service();
    const client = new Client({ name: "v3-highlights", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([app.getServer().connect(serverTransport), client.connect(clientTransport)]);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of ["highlight_list", "highlight_create", "highlight_update", "highlight_delete"]) {
        expect(names).toContain(name);
      }
      const result = await client.callTool({
        name: "highlight_update", arguments: { raindropId: 7, _id: 123, note: "" },
      });
      expect(result.isError).toBe(true);
      expect(mock).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await app.cleanup();
    }
  });
});
