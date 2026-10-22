import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import RaindropService from "../src/services/raindrop.service.js";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const bookmark = (id: number, collectionId = 7) => ({
  result: true,
  item: { _id: id, collection: { $id: collectionId }, tags: ["existing"] },
});
function mockHttp(
  write: () => Response | Promise<Response> = () =>
    json({ result: true, modified: 2 }),
) {
  const fetch = vi.fn(async (request: Request) => {
    if (request.method !== "GET") return write();
    const path = new URL(request.url).pathname;
    const id = Number(path.split("/").at(-1));
    return path.includes("/collection/")
      ? json({ result: true, item: { _id: id } })
      : json(bookmark(id));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const service = () =>
  new RaindropService({ accessToken: "mock-only", maxReadRetries: 0 });
const ids = [11, 12];
const scope = { collectionId: 7, ids };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("safe bookmark batch Service HTTP contract", () => {
  it("sends append, clear, move and false favorite as exact official JSON after all fresh GETs", async () => {
    const fetch = mockHttp();
    const api = service();
    // Populate caches with misleading data: mutation checks must bypass them.
    await api.getBookmark(11);
    await api.getCollection(8);
    fetch.mockClear();
    for (const [changes, body] of [
      [
        { tagsToAdd: ["new"], important: false, destinationCollectionId: 8 },
        { tags: ["new"], important: false, collection: { $id: 8 } },
      ],
      [{ clearTags: true }, { tags: [] }],
    ] as const) {
      const result = await api.updateBookmarkBatch({
        ...scope,
        ...changes,
        tagsToAdd: "tagsToAdd" in changes ? [...changes.tagsToAdd] : undefined,
      });
      expect(result).toMatchObject({
        status: "unknown",
        acknowledged: true,
        modified: 2,
        unknown: ids,
        succeeded: [],
      });
      const calls = fetch.mock.calls.map(([request]) => request);
      const move = "destinationCollectionId" in changes;
      expect(calls.map((r) => r.method)).toEqual(
        move ? ["GET", "GET", "GET", "PUT"] : ["GET", "GET", "PUT"],
      );
      expect(calls.slice(0, 2).map((r) => new URL(r.url).pathname)).toEqual([
        "/rest/v1/raindrop/11",
        "/rest/v1/raindrop/12",
      ]);
      if (move)
        expect(calls[2]!.url).toBe(
          "https://api.raindrop.io/rest/v1/collection/8",
        );
      const write = calls.at(-1)!;
      expect(write.url).toBe("https://api.raindrop.io/rest/v1/raindrops/7");
      expect(await write.json()).toEqual({ ids, ...body });
      fetch.mockClear();
    }
  });

  it("accepts 50 unique IDs with exactly 50 preflights and one DELETE JSON body", async () => {
    const fetch = mockHttp();
    const fifty = Array.from({ length: 50 }, (_, i) => i + 1);
    const result = await service().deleteBookmarkBatch({
      collectionId: 7,
      ids: fifty,
    });
    expect(result).toMatchObject({
      status: "unknown",
      unknown: fifty,
      succeeded: [],
      notExecuted: [],
    });
    expect(fetch).toHaveBeenCalledTimes(51);
    const write = fetch.mock.calls.at(-1)![0];
    expect(write.method).toBe("DELETE");
    expect(write.url).toBe("https://api.raindrop.io/rest/v1/raindrops/7");
    expect(await write.json()).toEqual({ ids: fifty });
  });

  it("rejects unsafe scopes, IDs and update fields at the Service boundary before any HTTP", async () => {
    const fetch = mockHttp();
    const api = service();
    for (const collectionId of [
      0,
      -1,
      -99,
      -2,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      "7",
      null,
    ]) {
      await expect(
        api.deleteBookmarkBatch({ ...scope, collectionId } as never),
      ).rejects.toThrow();
      await expect(
        api.updateBookmarkBatch({
          ...scope,
          collectionId,
          important: false,
        } as never),
      ).rejects.toThrow();
    }
    for (const badIds of [
      [],
      [11, 11],
      [0],
      [-99],
      [1.5],
      [Number.MAX_SAFE_INTEGER + 1],
      ["11"],
      Array.from({ length: 51 }, (_, i) => i + 1),
    ]) {
      await expect(
        api.deleteBookmarkBatch({ ...scope, ids: badIds } as never),
      ).rejects.toThrow();
      await expect(
        api.updateBookmarkBatch({
          ...scope,
          ids: badIds,
          clearTags: true,
        } as never),
      ).rejects.toThrow();
    }
    for (const changes of [
      {},
      { tagsToAdd: [] },
      { tagsToAdd: ["a", "a"] },
      { tagsToAdd: [""] },
      { tagsToAdd: [" "] },
      { tagsToAdd: [" a"] },
      { clearTags: false },
      { clearTags: true, tagsToAdd: ["a"] },
      { destinationCollectionId: 0 },
      { destinationCollectionId: -99 },
      { destinationCollectionId: 2.5 },
      { search: "all", important: true },
      { nest: true, important: true },
    ]) {
      await expect(
        api.updateBookmarkBatch({ ...scope, ...changes } as never),
      ).rejects.toThrow();
    }
    await expect(
      api.deleteBookmarkBatch({ ...scope, search: "all" } as never),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "wrong source",
    "trash",
    "wrong id",
    "missing collection",
    "false",
    "missing",
    "inaccessible",
  ])("aborts the whole batch on %s in the final preflight", async (failure) => {
    const fetch = mockHttp();
    fetch.mockImplementation(async (request) => {
      if (request.url.endsWith("/11")) return json(bookmark(11));
      if (failure === "inaccessible") return json({}, 403);
      const body =
        failure === "wrong source"
          ? bookmark(12, 8)
          : failure === "trash"
            ? bookmark(12, -99)
            : failure === "wrong id"
              ? bookmark(99)
              : failure === "missing collection"
                ? { result: true, item: { _id: 12 } }
                : failure === "false"
                  ? { ...bookmark(12), result: false }
                  : {};
      return json(body);
    });
    const result = await service().updateBookmarkBatch({
      ...scope,
      important: true,
    });
    expect(result).toMatchObject({
      status: "failed",
      dispatched: false,
      succeeded: [],
      unknown: [],
      failed: [],
      notExecuted: ids,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
  });

  it.each([
    {},
    { result: false, item: { _id: 8 } },
    { result: true, item: { _id: 9 } },
  ])("requires a fresh acknowledged matching destination: %j", async (body) => {
    const fetch = mockHttp();
    fetch.mockImplementation(async (request) =>
      request.url.includes("/collection/")
        ? json(body)
        : json(bookmark(Number(request.url.split("/").at(-1)))),
    );
    const result = await service().updateBookmarkBatch({
      ...scope,
      destinationCollectionId: 8,
    });
    expect(result).toMatchObject({
      status: "failed",
      dispatched: false,
      notExecuted: ids,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
  });

  it.each([
    { result: true, modified: 2 },
    { result: true, modified: 1 },
    { result: true, modified: 0 },
    { result: true },
    {},
    { result: "true" },
    { result: true, modified: -1 },
  ])(
    "never attributes aggregate acknowledgement to specific IDs: %j",
    async (ack) => {
      const fetch = mockHttp(() => json(ack));
      const result = await service().deleteBookmarkBatch(scope);
      expect(result).toMatchObject({
        status: "unknown",
        dispatched: true,
        succeeded: [],
        failed: [],
        unknown: ids,
        notExecuted: [],
      });
      expect(result.acknowledged).toBe(
        ack.result === true && !("modified" in ack && Number(ack.modified) < 0),
      );
      expect(fetch).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["update", "delete"] as const)(
    "fails explicitly on result:false for %s",
    async (method) => {
      const fetch = mockHttp(() => json({ result: false, modified: "invalid" }));
      const api = service();
      const result = await (method === "update"
        ? api.updateBookmarkBatch({ ...scope, important: false })
        : api.deleteBookmarkBatch(scope));
      expect(result).toMatchObject({
        status: "failed",
        dispatched: true,
        acknowledged: false,
        failed: ids,
        unknown: [],
        succeeded: [],
      });
      expect(fetch).toHaveBeenCalledTimes(3);
    },
  );

  it.each([401, 403, 404, 400, 422, 429, 500, "lost", "malformed"])(
    "never retries a batch write after %s",
    async (failure) => {
      for (const operation of ["update", "delete"]) {
        const fetch = mockHttp(() => {
          if (failure === "lost") throw new TypeError("connection lost");
          if (failure === "malformed")
            return new Response("{", {
              headers: { "content-type": "application/json" },
            });
          return json({}, failure as number);
        });
        const api = new RaindropService({
          accessToken: "mock-only",
          maxReadRetries: 3,
        });
        const result = await (operation === "update"
          ? api.updateBookmarkBatch({ ...scope, clearTags: true })
          : api.deleteBookmarkBatch(scope));
        const rejected =
          typeof failure === "number" &&
          [400, 401, 403, 404, 422].includes(failure);
        expect(result).toMatchObject({
          status: rejected ? "failed" : "unknown",
          succeeded: [],
          acknowledged: false,
          dispatched: true,
        });
        expect(result[rejected ? "failed" : "unknown"]).toEqual(ids);
        expect(result.reason).toMatch(/do not automatically retry/i);
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(
          fetch.mock.calls.filter(([r]) => r.method !== "GET"),
        ).toHaveLength(1);
      }
    },
  );

  it.each([10, 11])(
    "counts %s read retries toward the shared 60-request budget without dispatching a write",
    async (retryReads) => {
      vi.useFakeTimers();
      let reads = 0;
      const fetch = mockHttp();
      fetch.mockImplementation(async (request) => {
        // Exhaust the budget either at the destination GET or the write boundary.
        reads++;
        if (reads <= retryReads * 2 && reads % 2 === 1) return json({}, 500);
        return json(bookmark(Number(request.url.split("/").at(-1))));
      });
      const api = new RaindropService({
        accessToken: "mock-only",
        maxReadRetries: 1,
      });
      const promise = api.updateBookmarkBatch({
        collectionId: 7,
        ids: Array.from({ length: 50 }, (_, i) => i + 1),
        important: false,
      });
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result).toMatchObject({
        status: "failed",
        dispatched: false,
        succeeded: [],
      });
      expect(result.notExecuted).toHaveLength(50);
      expect(fetch).toHaveBeenCalledTimes(60);
      expect(fetch.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
    },
  );
});

describe("batch tools over MCP tools/list and tools/call", () => {
  it("exposes exactly two strict destructive tools, validates input, and preserves bounded outcomes", async () => {
    const fetch = mockHttp();
    const mcp = new RaindropMCPService({
      accessToken: "mock-only",
      maxReadRetries: 0,
    });
    const client = new Client({ name: "batch-contract", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await mcp.getServer().connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(24);
      expect(tools.map((t) => t.name)).not.toContain("bookmark_batch_move");
      for (const name of ["bookmark_batch_update", "bookmark_batch_delete"]) {
        const tool = tools.find((t) => t.name === name)!;
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool.inputSchema.required).toEqual(
          expect.arrayContaining(["collectionId", "ids"]),
        );
        expect(tool.outputSchema).toBeDefined();
        expect(tool.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
        });
        for (const bad of [
          {},
          { collectionId: 0, ids },
          { ...scope, search: "all" },
          { ...scope, nest: true },
          { ...scope, nested: true },
          { ...scope, ids: [] },
        ]) {
          expect(
            (await client.callTool({ name, arguments: bad })).isError,
          ).toBe(true);
        }
      }
      for (const bad of [
        scope,
        { ...scope, tagsToAdd: [] },
        { ...scope, clearTags: true, tagsToAdd: ["a"] },
      ]) {
        expect(
          (
            await client.callTool({
              name: "bookmark_batch_update",
              arguments: bad,
            })
          ).isError,
        ).toBe(true);
      }
      expect(fetch).not.toHaveBeenCalled();
      for (const [name, args] of [
        ["bookmark_batch_update", { ...scope, important: false }],
        ["bookmark_batch_delete", scope],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          status: "unknown",
          unknown: ids,
          succeeded: [],
          modified: 2,
        });
      }
      fetch.mockImplementation(async () => json({}, 403));
      const rejected = await client.callTool({
        name: "bookmark_batch_delete",
        arguments: scope,
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toMatchObject({
        status: "failed",
        dispatched: false,
        notExecuted: ids,
      });
    } finally {
      await client.close();
      await mcp.cleanup();
    }
  });
});
