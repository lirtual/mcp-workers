import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

afterEach(() => vi.unstubAllGlobals());
const service = () => new RaindropMCPService({ accessToken: "fake", maxReadRetries: 0 });
const fake = (handler: (request: Request) => Promise<Response> | Response) => {
  const spy = vi.fn(handler);
  vi.stubGlobal("fetch", spy);
  return spy;
};

describe("T03: source-scoped Raindrop mutations", () => {
  it("deduplicates selected IDs, moves with official collection body and reports partial without per-ID claims", async () => {
    const spy = fake(async (request) => {
      expect(request.method).toBe("PUT");
      expect(new URL(request.url).pathname).toBe("/rest/v1/raindrops/3");
      expect(await request.json()).toEqual({ ids: [11, 12], collection: { $id: 9 }, important: false });
      return Response.json({ result: true, modified: 1 });
    });
    const result = await service().callTool("raindrop_bulk_update", {
      collectionId: 3, ids: [11, 12, 11], collection: { $id: 9 }, important: false,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      ok: true, data: { requestedIds: [11, 12], modified: 1 },
      meta: { status: "partial", requestedIds: [11, 12], modified: 1, requestCount: 1 },
    });
    expect(result.structuredContent.meta).not.toHaveProperty("succeededIds");
  });

  it("previews deletion without upstream work and writes only the selected source after confirm", async () => {
    const spy = fake(async (request) => {
      expect(request.method).toBe("DELETE");
      expect(new URL(request.url).pathname).toBe("/rest/v1/raindrops/-1");
      expect(await request.json()).toEqual({ ids: [11, 12] });
      return Response.json({ result: true });
    });
    const app = service();
    const input = { collectionId: -1, ids: [11, 12, 11], permanent: false };
    const preview = await app.callTool("raindrop_bulk_delete", input);
    expect(preview.structuredContent).toMatchObject({
      ok: true, data: { targets: [{ id: 11, collectionId: -1 }, { id: 12, collectionId: -1 }] },
      meta: { status: "preview", modified: null, requestCount: 0 },
    });
    expect(spy).not.toHaveBeenCalled();
    const result = await app.callTool("raindrop_bulk_delete", { ...input, confirm: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.structuredContent.meta).toMatchObject({
      status: "succeeded", modified: null, requestedIds: [11, 12], requestCount: 1,
    });
  });

  it("re-reads the single bookmark source and uses batch DELETE, never unscoped DELETE", async () => {
    let detailReads = 0;
    const spy = fake(async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET") {
        expect(path).toBe("/rest/v1/raindrop/19");
        detailReads++;
        return Response.json({ item: { _id: 19, collection: { $id: 5 } } });
      }
      expect(request.method).toBe("DELETE");
      expect(path).toBe("/rest/v1/raindrops/5");
      expect(await request.json()).toEqual({ ids: [19] });
      return Response.json({ result: true, modified: 1 });
    });
    const app = service();
    const preview = await app.callTool("raindrop_delete", { id: 19 });
    expect(preview.structuredContent.meta).toMatchObject({ status: "preview", requestCount: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    const result = await app.callTool("raindrop_delete", { id: 19, confirm: true });
    expect(detailReads).toBe(2);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(result.structuredContent.meta).toMatchObject({ status: "succeeded", modified: 1, requestCount: 3 });
  });

  it("fails closed on source drift between preview and execution, without a delete", async () => {
    let reads = 0;
    const spy = fake((request) => {
      expect(request.method).toBe("GET");
      reads++;
      return Response.json({ item: { _id: 19, collection: { $id: reads === 1 ? 5 : -99 } } });
    });
    const app = service();
    expect((await app.callTool("raindrop_delete", { id: 19 })).structuredContent.meta.status).toBe("preview");
    const result = await app.callTool("raindrop_delete", { id: 19, confirm: true });
    expect(result).toMatchObject({
      isError: true, structuredContent: { ok: false, meta: { status: "not_executed", requestCount: 2 } },
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["empty IDs", "raindrop_bulk_delete", { collectionId: 5, ids: [] }],
    ["source zero", "raindrop_bulk_update", { collectionId: 0, ids: [1], important: true }],
    ["more than 50 IDs", "raindrop_bulk_update", { collectionId: 5, ids: Array.from({ length: 51 }, (_, i) => i + 1), important: true }],
    ["unknown write field", "raindrop_bulk_update", { collectionId: 5, ids: [1], search: "tag:test", important: true }],
    ["illegal target", "raindrop_bulk_update", { collectionId: 5, ids: [1], collection: { $id: 0 } }],
    ["no-op move", "raindrop_bulk_update", { collectionId: 5, ids: [1], collection: { $id: 5 } }],
    ["non-Trash permanent delete", "raindrop_bulk_delete", { collectionId: 5, ids: [1], permanent: true, confirm: true }],
    ["Trash non-permanent delete", "raindrop_bulk_delete", { collectionId: -99, ids: [1], confirm: true }],
    ["invalid single ID", "raindrop_delete", { id: "19", confirm: true }],
  ])("rejects %s before upstream submission", async (_name, tool, input) => {
    const spy = fake(() => Response.json({ result: true }));
    const result = await service().callTool(tool, input);
    expect(result).toMatchObject({
      isError: true, structuredContent: { error: { code: "VALIDATION_ERROR" }, meta: { requestCount: 0 } },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not replay a submitted source-scoped batch mutation after 429", async () => {
    const spy = fake(() => new Response(null, { status: 429, headers: { "retry-after": "60" } }));
    const result = await service().callTool("raindrop_bulk_delete", {
      collectionId: 5, ids: [1], confirm: true,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      isError: true, structuredContent: {
        error: { code: "WRITE_OUTCOME_UNKNOWN", upstreamStatus: 429, retryAfterMs: 60000 },
        meta: { status: "unknown", requestCount: 1 },
      },
    });
  });

  it.each([
    ["explicit result=false", () => Response.json({ result: false, error: "validation" }), undefined],
    ["HTTP 400", () => new Response(null, { status: 400 }), 400],
  ])("reports %s as a definite failed write, not unknown", async (_label, response, status) => {
    const spy = fake(response);
    const result = await service().callTool("raindrop_bulk_delete", {
      collectionId: 5, ids: [1], confirm: true,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: "UPSTREAM_REJECTED", ...(status === undefined ? {} : { upstreamStatus: status }) },
        meta: { status: "failed", requestCount: 1 },
      },
    });
  });

  it("exposes the contract via the actual MCP Client transport", async () => {
    const spy = fake(async (request) => {
      expect(request.method).toBe("PUT");
      return Response.json({ result: true, modified: 1 });
    });
    const app = service();
    const client = new Client({ name: "mutation-contract", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([app.getServer().connect(serverTransport), client.connect(clientTransport)]);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of ["raindrop_delete", "raindrop_bulk_update", "raindrop_bulk_delete"]) {
        expect(names).toContain(name);
      }
      const result = await client.callTool({
        name: "raindrop_bulk_update", arguments: { collectionId: 7, ids: [1], tags: [] },
      });
      expect(result.structuredContent).toMatchObject({ ok: true, meta: { status: "succeeded" } });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await app.cleanup();
    }
  });
});
