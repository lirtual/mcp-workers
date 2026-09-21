import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";
import { buildToolConfigs } from "../src/tools/index.js";

afterEach(() => vi.unstubAllGlobals());

const bookmark = {
  _id: 7, link: "https://example.test/bookmark", title: "example",
  note: "", tags: [], important: false, collection: { $id: 7 },
  highlights: [{ _id: "hl-7", text: "quote", note: "" }],
  officialExtension: { untouched: true },
};
const collection = { _id: 7, title: "fixture", count: 0 };
const highlight = { _id: "hl-7", text: "quote", note: "" };
const tag = { _id: "fixture", count: 1 };

type ExpectedRequest = { method: string; path: string; body?: unknown };
type Case = {
  name: string;
  args: Record<string, unknown>;
  requests: ExpectedRequest[];
  dataKey?: string;
  status?: string;
  errorCode?: string;
};

const cases: Case[] = [
  { name: "raindrop_list", args: {}, requests: [{ method: "GET", path: "/rest/v1/raindrops/0" }], dataKey: "items" },
  { name: "raindrop_get", args: { id: 7 }, requests: [{ method: "GET", path: "/rest/v1/raindrop/7" }], dataKey: "item" },
  { name: "raindrop_create", args: { link: bookmark.link }, requests: [
    { method: "POST", path: "/rest/v1/raindrop", body: { link: bookmark.link, collection: { $id: -1 }, pleaseParse: {} } },
  ], dataKey: "item", status: "succeeded" },
  { name: "raindrop_update", args: { id: 7, note: "" }, requests: [
    { method: "PUT", path: "/rest/v1/raindrop/7", body: { note: "" } },
  ], dataKey: "item", status: "succeeded" },
  { name: "raindrop_delete", args: { id: 7 }, requests: [{ method: "GET", path: "/rest/v1/raindrop/7" }], dataKey: "targets", status: "preview" },
  { name: "raindrop_bulk_update", args: { collectionId: 7, ids: [8], important: false }, requests: [
    { method: "PUT", path: "/rest/v1/raindrops/7", body: { ids: [8], important: false } },
  ], dataKey: "modified", status: "succeeded" },
  { name: "raindrop_bulk_delete", args: { collectionId: 7, ids: [8], confirm: true }, requests: [
    { method: "DELETE", path: "/rest/v1/raindrops/7", body: { ids: [8] } },
  ], dataKey: "modified", status: "succeeded" },
  { name: "raindrop_suggest", args: { id: 7 }, requests: [{ method: "GET", path: "/rest/v1/raindrop/7/suggest" }], dataKey: "item" },
  { name: "collection_list", args: {}, requests: [
    { method: "GET", path: "/rest/v1/collections" },
    { method: "GET", path: "/rest/v1/collections/childrens" },
  ], dataKey: "items" },
  { name: "collection_tree", args: {}, requests: [
    { method: "GET", path: "/rest/v1/collections" },
    { method: "GET", path: "/rest/v1/collections/childrens" },
  ], dataKey: "roots" },
  { name: "collection_get", args: { id: 7 }, requests: [{ method: "GET", path: "/rest/v1/collection/7" }], dataKey: "item" },
  { name: "collection_create", args: { title: "fixture" }, requests: [
    { method: "POST", path: "/rest/v1/collection", body: { title: "fixture" } },
  ], dataKey: "item", status: "succeeded" },
  { name: "collection_update", args: { id: 7, title: "fixture" }, requests: [
    { method: "PUT", path: "/rest/v1/collection/7", body: { title: "fixture" } },
  ], dataKey: "item", status: "succeeded" },
  { name: "collection_delete", args: { id: 7 }, requests: [
    { method: "GET", path: "/rest/v1/collections" },
    { method: "GET", path: "/rest/v1/collections/childrens" },
  ], dataKey: "targets", status: "preview" },
  { name: "tag_list", args: {}, requests: [{ method: "GET", path: "/rest/v1/tags" }], dataKey: "items" },
  { name: "tag_rename", args: { scope: "collection", collectionId: 7, tags: ["old"], replace: "new", confirm: true }, requests: [
    { method: "PUT", path: "/rest/v1/tags/7", body: { tags: ["old"], replace: "new" } },
  ], dataKey: "targets", status: "succeeded" },
  { name: "tag_merge", args: { scope: "collection", collectionId: 7, tags: ["a", "b"], replace: "new", confirm: true }, requests: [
    { method: "PUT", path: "/rest/v1/tags/7", body: { tags: ["a", "b"], replace: "new" } },
  ], dataKey: "targets", status: "succeeded" },
  { name: "tag_delete", args: { scope: "collection", collectionId: 7, tags: ["old"], confirm: true }, requests: [
    { method: "DELETE", path: "/rest/v1/tags/7", body: { tags: ["old"] } },
  ], dataKey: "targets", status: "succeeded" },
  { name: "highlight_list", args: {}, requests: [{ method: "GET", path: "/rest/v1/highlights" }], dataKey: "items" },
  { name: "highlight_create", args: { raindropId: 7, text: "quote" }, requests: [
    { method: "PUT", path: "/rest/v1/raindrop/7", body: { highlights: [{ text: "quote" }] } },
  ], dataKey: "item", status: "succeeded" },
  { name: "highlight_update", args: { raindropId: 7, _id: "hl-7", note: "" }, requests: [
    { method: "PUT", path: "/rest/v1/raindrop/7", body: { highlights: [{ _id: "hl-7", note: "" }] } },
  ], dataKey: "item", status: "succeeded" },
  { name: "highlight_delete", args: { raindropId: 7, _id: "hl-7" }, requests: [
    { method: "GET", path: "/rest/v1/raindrop/7" },
  ], dataKey: "targets", status: "preview" },
  { name: "library_audit", args: { kind: "untagged" }, requests: [{ method: "GET", path: "/rest/v1/raindrops/0" }], dataKey: "items" },
  { name: "duplicates_delete", args: { collectionId: 7, ids: [8], confirm: true }, requests: [], errorCode: "FEATURE_UNVERIFIED" },
  { name: "trash_empty", args: {}, requests: [{ method: "GET", path: "/rest/v1/user/stats" }], dataKey: "count", status: "preview" },
  { name: "diagnostics", args: {}, requests: [], dataKey: "version" },
];

function fixtureResponse(request: Request): Response {
  const path = new URL(request.url).pathname;
  if (path === "/rest/v1/collections" || path === "/rest/v1/collections/childrens") {
    return Response.json({ result: true, items: path.endsWith("/childrens") ? [] : [collection] });
  }
  if (path === "/rest/v1/collection/7" || path === "/rest/v1/collection") {
    return Response.json({ result: true, item: collection });
  }
  if (path === "/rest/v1/raindrop/7/suggest") {
    return Response.json({ result: true, item: { tags: ["fixture"], collections: [{ $id: 7 }] } });
  }
  if (path === "/rest/v1/raindrop/7" || path === "/rest/v1/raindrop") {
    return Response.json({ result: true, item: bookmark });
  }
  if (path === "/rest/v1/raindrops/0") return Response.json({ result: true, items: [bookmark], count: 1 });
  if (path === "/rest/v1/raindrops/7") return Response.json({ result: true, modified: 1 });
  if (path === "/rest/v1/tags") return Response.json({ result: true, items: [tag] });
  if (path === "/rest/v1/tags/7") return Response.json({ result: true });
  if (path === "/rest/v1/highlights") return Response.json({ result: true, items: [highlight], count: 1 });
  if (path === "/rest/v1/user/stats") return Response.json({ result: true, items: [{ _id: -99, count: 1 }] });
  throw new Error(`Unexpected HTTP path: ${request.method} ${path}`);
}

describe("26-tool legal-argument MCP Client success contract", () => {
  it("lists exactly the required output schemas with business containers", async () => {
    const app = new RaindropMCPService({ accessToken: "fake" });
    const client = new Client({ name: "v3-all-output", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([app.getServer().connect(serverTransport), client.connect(clientTransport)]);
      const listed = (await client.listTools()).tools;
      expect(listed.map((tool) => tool.name).sort()).toEqual(cases.map((entry) => entry.name).sort());
      const configured = buildToolConfigs({ serverVersion: "3.0.0" }).toolConfigs;
      for (const entry of cases) {
        const tool = listed.find((candidate) => candidate.name === entry.name);
        const config = configured.find((candidate) => candidate.name === entry.name);
        expect(tool?.outputSchema, entry.name).toBeDefined();
        expect(config?.outputSchema, entry.name).toBeDefined();
        const declared = JSON.stringify(tool!.outputSchema);
        expect(declared, entry.name).toContain('"data"');
        expect(declared, entry.name).toContain('"error"');
        if (entry.dataKey) expect(declared, entry.name).toContain('"' + entry.dataKey + '"');
        expect(config!.outputSchema!.safeParse({ ok: true, data: { item: "invalid" }, meta: {} }).success,
          "bad item must fail for " + entry.name).toBe(false);
      }
    } finally {
      await client.close();
      await app.cleanup();
    }
  });

  it.each(cases)("calls $name with legal arguments and exact fake-upstream requests", async (entry) => {
    const seen: ExpectedRequest[] = [];
    const spy = vi.fn(async (request: Request) => {
      const body = request.method === "GET" ? undefined : await request.clone().json();
      seen.push({ method: request.method, path: new URL(request.url).pathname,
        ...(body === undefined ? {} : { body }) });
      return fixtureResponse(request);
    });
    vi.stubGlobal("fetch", spy);
    const app = new RaindropMCPService({ accessToken: "fake", maxReadRetries: 0 });
    const client = new Client({ name: "v3-all-success", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([app.getServer().connect(serverTransport), client.connect(clientTransport)]);
      const output = await client.callTool({ name: entry.name, arguments: entry.args });
      expect(seen, entry.name).toEqual(entry.requests);
      expect(spy, entry.name).toHaveBeenCalledTimes(entry.requests.length);
      if (entry.errorCode) {
        expect(output.isError, entry.name).toBe(true);
        expect(output.structuredContent, entry.name).toMatchObject({
          ok: false, error: { code: entry.errorCode },
        });
      } else {
        expect(output.isError, entry.name).not.toBe(true);
        expect(output.structuredContent, entry.name).toMatchObject({
          ok: true, meta: { requestCount: entry.requests.length },
        });
        const result = output.structuredContent as { data: Record<string, unknown>; meta: Record<string, unknown> };
        expect(result.data, entry.name).toHaveProperty(entry.dataKey!);
        if (entry.status) expect(result.meta.status, entry.name).toBe(entry.status);
        if (entry.name === "raindrop_get") {
          expect(result.data.item).toMatchObject({ officialExtension: { untouched: true } });
        }
      }
    } finally {
      await client.close();
      await app.cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("rejects unverified move-to-root without any fake upstream write", async () => {
    const spy = vi.fn(async () => { throw Error("Feature gate must not reach HTTP"); });
    vi.stubGlobal("fetch", spy);
    const app = new RaindropMCPService({ accessToken: "fake" });
    const client = new Client({ name: "v3-root-gate", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([app.getServer().connect(serverTransport), client.connect(clientTransport)]);
      const output = await client.callTool({ name: "collection_update", arguments: { id: 7, parent: null } });
      expect(output.isError).toBe(true);
      expect(output.structuredContent).toMatchObject({ ok: false, error: { code: "FEATURE_UNVERIFIED" } });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await app.cleanup();
      vi.unstubAllGlobals();
    }
  });
});
