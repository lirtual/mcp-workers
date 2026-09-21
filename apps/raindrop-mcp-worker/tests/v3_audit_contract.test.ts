import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

afterEach(() => vi.unstubAllGlobals());
const app = () => new RaindropMCPService({ accessToken: "fake", maxReadRetries: 0 });
const fake = (handler: (request: Request) => Promise<Response> | Response) => {
  const spy = vi.fn(handler);
  vi.stubGlobal("fetch", spy);
  return spy;
};
const stats = (pro: boolean | null) => Response.json({
  result: true,
  items: [],
  ...(pro === null ? {} : { meta: { pro } }),
});

describe("T07: one-page audits and protected duplicate-deletion gate", () => {
  it("queries only one official untagged page with explicit source and no full-library scan", async () => {
    const spy = fake((req) => {
      expect(req.method).toBe("GET");
      const url = new URL(req.url);
      expect(url.pathname).toBe("/rest/v1/raindrops/9");
      expect(url.searchParams.get("search")).toBe("notag:true");
      expect(url.searchParams.get("page")).toBe("2");
      expect(url.searchParams.get("perpage")).toBe("25");
      expect(url.searchParams.get("nested")).toBe("false");
      return Response.json({ result: true, items: [{ _id: 9, link: "https://example.com", title: "a" }], count: 91 });
    });
    const result = await app().callTool("library_audit", {
      kind: "untagged", collectionId: 9, page: 2,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      ok: true, data: { items: [{ _id: 9 }] },
      meta: { kind: "untagged", total: 91, hasMore: true, nextPage: 3, requestCount: 1 },
    });
  });

  it("rejects duplicate audit without the official Pro entitlement instead of reporting zero matches", async () => {
    const spy = fake((req) => {
      expect(new URL(req.url).pathname).toBe("/rest/v1/user/stats");
      return stats(false);
    });
    const result = await app().callTool("library_audit", { kind: "duplicates" });
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: "FEATURE_UNAVAILABLE" } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown entitlement instead of silently assuming the subscription", async () => {
    const spy = fake(() => stats(null));
    const result = await app().callTool("library_audit", { kind: "broken" });
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: "FEATURE_UNVERIFIED" } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reads entitlement then exactly one duplicate page and marks unverified operator semantics", async () => {
    const seen: string[] = [];
    const spy = fake((req) => {
      const url = new URL(req.url);
      seen.push(url.pathname);
      if (url.pathname === "/rest/v1/user/stats") return stats(true);
      expect(url.pathname).toBe("/rest/v1/raindrops/0");
      expect(url.searchParams.get("search")).toBe("duplicate:true");
      return Response.json({ result: true, items: [], count: 0 });
    });
    const result = await app().callTool("library_audit", { kind: "duplicates" });
    expect(seen).toEqual(["/rest/v1/user/stats", "/rest/v1/raindrops/0"]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.structuredContent).toMatchObject({
      ok: true, meta: { total: 0, returned: 0, hasMore: false, requestCount: 2 },
    });
    expect(result.structuredContent.meta.warnings).toHaveLength(1);
  });

  it("finds only known empty leaves from merged metadata with a stable page", async () => {
    const seen: string[] = [];
    const spy = fake((req) => {
      const path = new URL(req.url).pathname;
      seen.push(path);
      if (path === "/rest/v1/collections") return Response.json({ result: true, items: [
        { _id: 1, title: "Root", count: 0 }, { _id: 5, title: "Empty", count: 0 },
      ] });
      if (path === "/rest/v1/collections/childrens") return Response.json({ result: true, items: [
        { _id: 2, title: "Child", count: 0, parent: { $id: 1 } },
        { _id: 3, title: "Unknown", parent: { $id: 1 } },
        { _id: 4, title: "Orphan", count: 0, parent: { $id: 400 } },
      ] });
      throw Error("Unexpected HTTP endpoint");
    });
    const result = await app().callTool("library_audit", { kind: "empty_collections" });
    expect(seen).toEqual(["/rest/v1/collections", "/rest/v1/collections/childrens"]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.structuredContent).toMatchObject({
      ok: true, data: { items: [{ _id: 2 }, { _id: 5 }] },
      meta: { total: 2, requestCount: 2 },
    });
  });

  it("refuses system IDs for the empty collection kind without upstream requests", async () => {
    const spy = fake(() => { throw Error("No request expected"); });
    const result = await app().callTool("library_audit", { kind: "empty_collections", collectionId: -1 });
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(spy).not.toHaveBeenCalled();
  });

  it("never submits duplicate deletion while the documented compile-time gate is disabled", async () => {
    const spy = fake(() => { throw Error("No request expected"); });
    const result = await app().callTool("duplicates_delete", {
      collectionId: 8, ids: [91], confirm: true,
    });
    expect(result.structuredContent).toMatchObject({
      ok: false, error: { code: "FEATURE_UNVERIFIED" }, meta: { requestCount: 0 },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("previews explicit current-page IDs; stale and content-bearing candidates are skipped", async () => {
    const seen: string[] = [];
    const spy = fake((req) => {
      const url = new URL(req.url);
      seen.push(url.pathname);
      if (url.pathname === "/rest/v1/user/stats") return stats(true);
      if (url.pathname === "/rest/v1/raindrops/8") {
        expect(url.searchParams.get("perpage")).toBe("50");
        expect(url.searchParams.get("search")).toBe("duplicate:true");
        return Response.json({ result: true, items: [{ _id: 1 }, { _id: 2 }], count: 2 });
      }
      if (url.pathname === "/rest/v1/raindrop/1") {
        return Response.json({ result: true, item: {
          _id: 1, collection: { $id: 8 }, note: "", highlights: [],
        } });
      }
      if (url.pathname === "/rest/v1/raindrop/2") {
        return Response.json({ result: true, item: {
          _id: 2, collection: { $id: 8 }, note: "important", highlights: [],
        } });
      }
      throw Error(`Unexpected request: ${url.pathname}`);
    });
    const result = await app().callTool("duplicates_delete", { collectionId: 8, ids: [1, 2, 3] });
    expect(result.structuredContent).toMatchObject({
      ok: true, data: {
        eligibleIds: [1],
        skipped: [{ id: 2, reason: "PROTECTED_CONTENT" }, { id: 3, reason: "STALE_CANDIDATE" }],
      },
      meta: { status: "preview", requestCount: 4 },
    });
    expect(seen).toEqual(["/rest/v1/user/stats", "/rest/v1/raindrops/8", "/rest/v1/raindrop/1", "/rest/v1/raindrop/2"]);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("rejects unknown fields and over-limit IDs at the real MCP Client boundary", async () => {
    const spy = fake(() => { throw Error("No request expected"); });
    const service = app();
    const client = new Client({ name: "v3-audit-contract", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([service.getServer().connect(serverTransport), client.connect(clientTransport)]);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("library_audit");
      expect(names).toContain("duplicates_delete");
      const result = await client.callTool({
        name: "duplicates_delete",
        arguments: { collectionId: 8, ids: Array(11).fill(1), confirm: true },
      });
      expect(result.isError).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await service.cleanup();
    }
  });
});
