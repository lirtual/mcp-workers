import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

afterEach(() => vi.unstubAllGlobals());
const app = () => new RaindropMCPService({ accessToken: "fake", maxReadRetries: 0 });
const stub = (handler: (request: Request) => Promise<Response> | Response) => {
  const mock = vi.fn(handler);
  vi.stubGlobal("fetch", mock);
  return mock;
};

describe("T05: official scoped v3 tags", () => {
  it("reads the global /tags endpoint and locally sorts and pages", async () => {
    const mock = stub((request) => {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe("/rest/v1/tags");
      return Response.json({ result: true, items: [
        { _id: "z", count: 2 }, { _id: "a", count: 1 }, { _id: "b", count: 4 },
      ] });
    });
    const result = await app().callTool("tag_list", { page: 0, perpage: 2 });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      ok: true, data: { items: [{ _id: "a" }, { _id: "b" }] },
      meta: { scope: { type: "all" }, total: 3, returned: 2,
        page: 0, perpage: 2, hasMore: true, nextPage: 1, requestCount: 1 },
    });
  });

  it("uses an explicit collection endpoint including supported system IDs", async () => {
    const mock = stub((request) => {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe("/rest/v1/tags/-1");
      return Response.json({ result: true, items: [] });
    });
    const result = await app().callTool("tag_list", { collectionId: -1 });
    expect(result.structuredContent).toMatchObject({
      ok: true, data: { items: [] }, meta: { total: 0, hasMore: false, scope: { collectionId: -1 } },
    });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["tag_rename", ["old"], "new"],
    ["tag_merge", ["old", "other"], "new"],
  ])("previews then submits official PUT body for %s", async (name, tags, replace) => {
    const mock = stub(async (request) => {
      expect(request.method).toBe("PUT");
      expect(new URL(request.url).pathname).toBe("/rest/v1/tags/17");
      expect(await request.json()).toEqual({ tags, replace });
      return Response.json({ result: true });
    });
    const service = app();
    const input = { scope: "collection", collectionId: 17, tags, replace };
    const preview = await service.callTool(name, input);
    expect(preview.structuredContent).toMatchObject({ ok: true, meta: { status: "preview", requestCount: 0 } });
    expect(mock).not.toHaveBeenCalled();
    const result = await service.callTool(name, { ...input, confirm: true });
    expect(result.structuredContent).toMatchObject({ ok: true, meta: { status: "succeeded", modified: null, requestCount: 1 } });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("deletes only named global tags after confirmation", async () => {
    const mock = stub(async (request) => {
      expect(request.method).toBe("DELETE");
      expect(new URL(request.url).pathname).toBe("/rest/v1/tags");
      expect(await request.json()).toEqual({ tags: ["unused"] });
      return Response.json({ result: true });
    });
    const result = await app().callTool("tag_delete", {
      scope: "all", tags: ["unused"], confirm: true,
    });
    expect(result.structuredContent).toMatchObject({
      ok: true, meta: { status: "succeeded", scope: { type: "all" }, requestCount: 1 },
    });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["global scope has collection", "tag_delete", { scope: "all", collectionId: 1, tags: ["a"], confirm: true }],
    ["collection scope missing ID", "tag_delete", { scope: "collection", tags: ["a"], confirm: true }],
    ["zero is not global alias", "tag_list", { collectionId: 0 }],
    ["blank tag", "tag_delete", { scope: "all", tags: ["  "], confirm: true }],
    ["duplicate merge", "tag_merge", { scope: "all", tags: ["x", "x"], replace: "y", confirm: true }],
    ["no-op rename", "tag_rename", { scope: "all", tags: ["x"], replace: "x", confirm: true }],
    ["unknown field", "tag_delete", { scope: "all", tags: ["x"], arbitrary: true, confirm: true }],
    ["over limit", "tag_delete", { scope: "all", tags: Array(51).fill("x"), confirm: true }],
  ])("rejects %s before fetch", async (_label, name, input) => {
    const mock = stub(() => { throw Error("Unexpected network request"); });
    const result = await app().callTool(name, input);
    expect(result.structuredContent).toMatchObject({
      ok: false, error: { code: "VALIDATION_ERROR" }, meta: { status: "not_executed", requestCount: 0 },
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it("never returns an empty successful tag list for a rejected or invalid upstream response", async () => {
    const mock = stub(() => Response.json({ result: false, items: [] }));
    const result = await app().callTool("tag_list", {});
    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: "UPSTREAM_ERROR" } });
  });

  it("treats submitted 429 mutation as unknown and never replays it", async () => {
    const mock = stub(() => new Response(null, { status: 429, headers: { "retry-after": "60" } }));
    const result = await app().callTool("tag_delete", { scope: "all", tags: ["x"], confirm: true });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      ok: false, error: { code: "WRITE_OUTCOME_UNKNOWN", upstreamStatus: 429 },
      meta: { status: "unknown", requestCount: 1 },
    });
  });

  it("exposes scope validation through an actual MCP Client", async () => {
    const mock = stub(() => { throw Error("Unexpected network request"); });
    const service = app();
    const client = new Client({ name: "v3-tags-contract", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([service.getServer().connect(serverTransport), client.connect(clientTransport)]);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of ["tag_list", "tag_rename", "tag_merge", "tag_delete"]) {
        expect(names).toContain(name);
      }
      const result = await client.callTool({
        name: "tag_delete", arguments: { scope: "all", collectionId: 1, tags: ["x"], confirm: true },
      });
      expect(result.isError).toBe(true);
      expect(mock).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await service.cleanup();
    }
  });
});
