import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";
import { buildCollectionIndexV3, descendantIdsV3 } from "../src/tools/collection-index-v3.js";

afterEach(() => vi.unstubAllGlobals());
const app = () => new RaindropMCPService({ accessToken: "fake", maxReadRetries: 0 });
const C = (id: number, parent?: number, count = 0) => ({
  _id: id, title: `collection-${id}`, count,
  ...(parent === undefined ? {} : { parent: { $id: parent } }),
});
const mockIndex = (
  roots: ReturnType<typeof C>[],
  children: ReturnType<typeof C>[] = [],
  onWrite?: (req: Request) => Promise<Response> | Response,
) => {
  const spy = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/rest/v1/collections") {
      return Response.json({ result: true, items: roots });
    }
    if (request.method === "GET" && path === "/rest/v1/collections/childrens") {
      return Response.json({ result: true, items: children });
    }
    if (onWrite) return onWrite(request);
    throw new Error(`Unexpected ${request.method} ${path}`);
  });
  vi.stubGlobal("fetch", spy);
  return spy;
};
const resultOf = async (name: string, input: Record<string, unknown> = {}) =>
  (await app().callTool(name, input)).structuredContent;

describe("T04: collection hierarchy and exact deletion scope", () => {
  it("merges both official endpoints, deduplicates child IDs and sorts/paginates by _id", async () => {
    const spy = mockIndex([C(9), C(1)], [C(4, 1), C(4, 1), C(3, 4)]);
    const result = await resultOf("collection_list", { perpage: 2, page: 1 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: true, data: { items: [
        { _id: 4, path: ["collection-1", "collection-4"] },
        { _id: 9, path: ["collection-9"] },
      ] },
      meta: { total: 4, page: 1, perpage: 2, returned: 2, hasMore: false, requestCount: 2 },
    });
  });

  it("keeps orphan/cycle records unattached, reports warnings and never loops on deep trees", async () => {
    const root = C(1);
    const nested = Array.from({ length: 997 }, (_, i) => C(i + 2, i + 1));
    const orphan = C(999, 5000);
    const cycle = C(1000, 1000);
    const graph = buildCollectionIndexV3([orphan, cycle, ...nested.reverse(), root]);
    expect(graph.nodes).toHaveLength(1000);
    expect(graph.roots).toHaveLength(1);
    expect(graph.unattached.map((x) => x._id)).toEqual([999, 1000]);
    expect(graph.warnings).toEqual(["cycle:1000", "missing-parent:5000"]);
    expect(descendantIdsV3(graph.roots[0])).toHaveLength(997);
    expect(graph.byId.get(998)?.path).toHaveLength(998);
  });

  it("rejects an invalid or partial child response rather than claiming a complete tree", async () => {
    const spy = vi.fn((request: Request) =>
      Response.json(new URL(request.url).pathname.endsWith("/childrens")
        ? { result: false, items: [] }
        : { result: true, items: [C(1)] }),
    );
    vi.stubGlobal("fetch", spy);
    const result = await resultOf("collection_tree");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: false, error: { code: "UPSTREAM_ERROR" } });
  });

  it("rejects indexes beyond the project cap (1000 unique IDs)", async () => {
    const spy = mockIndex(Array.from({ length: 1000 }, (_, i) => C(i + 1)), [C(1001, 1)]);
    const result = await resultOf("collection_list");
    expect(result).toMatchObject({ ok: false, error: { code: "RESOURCE_LIMIT" } });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("creates privately with only explicit title and optional parent", async () => {
    const spy = mockIndex([], [], async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/rest/v1/collection");
      expect(await req.json()).toEqual({ title: "hello", parent: { $id: 7 } });
      return Response.json({ result: true, item: C(42, 7) });
    });
    const result = await resultOf("collection_create", { title: "hello", parent: { $id: 7 } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, data: { item: { _id: 42 } }, meta: { status: "succeeded", requestCount: 1 } });
  });

  it("updates only explicit fields and rejects self-parenting without upstream work", async () => {
    const spy = mockIndex([], [], async (req) => {
      expect(req.method).toBe("PUT");
      expect(new URL(req.url).pathname).toBe("/rest/v1/collection/5");
      expect(await req.json()).toEqual({ title: "renamed" });
      return Response.json({ result: true, item: C(5) });
    });
    const result = await resultOf("collection_update", { id: 5, title: "renamed" });
    expect(result).toMatchObject({ ok: true, meta: { status: "succeeded", requestCount: 1 } });
    expect(spy).toHaveBeenCalledTimes(1);
    const blocked = await resultOf("collection_update", { id: 5, parent: { $id: 5 } });
    expect(blocked).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("rejects an ancestor moving beneath its descendant without issuing PUT", async () => {
    const spy = mockIndex([C(1)], [C(2, 1), C(3, 2)]);
    const result = await resultOf("collection_update", { id: 1, parent: { $id: 3 } });
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("gates parent=null before any upstream request until isolated live acceptance", async () => {
    const spy = vi.fn(() => { throw Error("must not call upstream"); });
    vi.stubGlobal("fetch", spy);
    const result = await resultOf("collection_update", { id: 5, parent: null });
    expect(result).toMatchObject({ ok: false, error: { code: "FEATURE_UNVERIFIED" }, meta: { requestCount: 0 } });
    expect(spy).not.toHaveBeenCalled();
  });

  it("previews the whole subtree and checks an exact fresh descendant set before one DELETE", async () => {
    const spy = mockIndex([C(1, undefined, 10)], [C(2, 1, 2), C(3, 2, 0)], async (req) => {
      expect(req.method).toBe("DELETE");
      expect(new URL(req.url).pathname).toBe("/rest/v1/collection/1");
      return Response.json({ result: true });
    });
    const service = app();
    const preview = await service.callTool("collection_delete", { id: 1 });
    expect(preview.structuredContent).toMatchObject({
      ok: true, data: { targets: [
        { id: 1, count: 10 }, { id: 2, count: 2 }, { id: 3, count: 0 },
      ], descendantIds: [2, 3] },
      meta: { status: "preview", requestCount: 2 },
    });
    expect(spy).toHaveBeenCalledTimes(2);
    const mismatch = await service.callTool("collection_delete", { id: 1, confirm: true, descendantIds: [2] });
    expect(mismatch.structuredContent).toMatchObject({ ok: false, error: { code: "SCOPE_CHANGED" } });
    expect(spy).toHaveBeenCalledTimes(4);
    const confirmed = await service.callTool("collection_delete", { id: 1, confirm: true, descendantIds: [2, 3] });
    expect(confirmed.structuredContent).toMatchObject({ ok: true, meta: { status: "succeeded", requestCount: 7 } });
    expect(spy).toHaveBeenCalledTimes(7);
  });

  it("allows only a known-empty leaf to be cleaned with one targeted DELETE", async () => {
    const spy = mockIndex([C(1, undefined, 0)], [], (req) => {
      expect(req.method).toBe("DELETE");
      return Response.json({ result: true });
    });
    const result = await resultOf("collection_delete", { id: 1, confirm: true, onlyIfEmpty: true });
    expect(result).toMatchObject({ ok: true, meta: { status: "succeeded", requestCount: 3 } });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it.each([
    [C(1, undefined, 1), [], "nonempty"],
    [{ _id: 1, title: "unknown count" }, [], "unknown count"],
    [C(1, undefined, 0), [C(2, 1, 0)], "has descendant"],
  ])("rejects onlyIfEmpty %s before deletion", async (root, children) => {
    const spy = mockIndex([root], children);
    const result = await resultOf("collection_delete", { id: 1, onlyIfEmpty: true, confirm: true, descendantIds: children.map(x => x._id) });
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["unknown write field", "collection_create", { title: "new", description: "not writable" }],
    ["unknown update", "collection_update", { id: 5, title: "new", color: "red" }],
    ["invalid parent", "collection_update", { id: 5, parent: { $id: -1 } }],
    ["untyped ID", "collection_delete", { id: "5", confirm: true }],
    ["unexpected descendant", "collection_delete", { id: 5, confirm: true, descendantIds: ["6"] }],
  ])("rejects %s without reaching upstream", async (_label, name, args) => {
    const spy = vi.fn(() => { throw Error("Unexpected upstream request"); });
    vi.stubGlobal("fetch", spy);
    const result = await resultOf(name, args);
    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(spy).not.toHaveBeenCalled();
  });

  it("publishes all six tools and their input validation through a real MCP Client", async () => {
    const spy = vi.fn(() => { throw Error("must not call upstream"); });
    vi.stubGlobal("fetch", spy);
    const service = app();
    const client = new Client({ name: "v3-collection-contract", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([service.getServer().connect(serverTransport), client.connect(clientTransport)]);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of ["collection_list", "collection_tree", "collection_get", "collection_create", "collection_update", "collection_delete"]) {
        expect(names).toContain(name);
        expect(names.filter((value) => value === name)).toHaveLength(1);
      }
      const invalid = await client.callTool({ name: "collection_delete", arguments: { id: 5, descendantIds: ["bad"], confirm: true } });
      expect(invalid.isError).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await service.cleanup();
    }
  });
});
