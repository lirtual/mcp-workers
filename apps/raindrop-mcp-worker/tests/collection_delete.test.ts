import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import RaindropService from "../src/services/raindrop.service.js";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";
import {
  CollectionDeleteInputSchema,
  CollectionRemoveEmptyInputSchema,
} from "../src/types/raindrop-zod.schemas.js";

type Row = {
  _id: number;
  title: string;
  parent?: { $id: number } | null;
  count?: number;
  access?: { level: number };
};
const row = (id: number, parent?: number, count = 0): Row => ({
  _id: id,
  title: `Collection ${id}`,
  parent: parent ? { $id: parent } : null,
  count,
  access: { level: 4 },
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
function fixture(initial = [row(10), row(20, 10), row(30, 10)]) {
  const state = {
    rows: initial,
    writes: [] as number[],
    override: undefined as undefined | ((req: Request) => Response | undefined),
  };
  const fetch = vi.fn(async (req: Request) => {
    const url = new URL(req.url);
    const path = url.pathname.replace("/rest/v1", "");
    if (req.method === "DELETE")
      state.writes.push(Number(path.split("/").at(-1)));
    const overridden = state.override?.(req);
    if (overridden) return overridden;
    if (req.method === "DELETE") {
      const id = Number(path.split("/").at(-1));
      state.rows = state.rows.filter((r) => r._id !== id);
      return json({ result: true });
    }
    if (path === "/collections")
      return json({ result: true, items: state.rows.filter((r) => !r.parent) });
    if (path === "/collections/childrens")
      return json({ result: true, items: state.rows.filter((r) => r.parent) });
    const id = Number(path.split("/").at(-1));
    const item = state.rows.find((r) => r._id === id);
    if (path.startsWith("/collection/")) return json({ result: true, item });
    if (path.startsWith("/raindrops/")) {
      expect(url.searchParams.get("nested")).toBe("false");
      expect(url.searchParams.get("perpage")).toBe("1");
      return json({
        result: true,
        count: item?.count,
        items: item?.count ? [{ _id: id * 100, collection: { $id: id } }] : [],
      });
    }
    throw new Error(`Unexpected mock request: ${req.method} ${path}`);
  });
  vi.stubGlobal("fetch", fetch);
  const service = () =>
    new RaindropService({ accessToken: "mock-only", maxReadRetries: 0 });
  return { state, fetch, service };
}
const confirmation = (preview: {
  total: number;
  collectionIds: number[];
  digest: string;
}) => ({
  confirm: true as const,
  expectedTotal: preview.total,
  collectionIds: preview.collectionIds,
  digest: preview.digest,
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("T07 collection_delete fresh verified cascade", () => {
  it("previews the exact sorted subtree and direct counts, then sends only one root DELETE", async () => {
    const f = fixture([
      row(99),
      row(30, 20, 2),
      row(10, undefined, 1),
      row(20, 10, 3),
    ]);
    const preview = await f.service().deleteCollectionPreviewFirst({ id: 10 });
    expect(preview).toMatchObject({
      preview: true,
      rootId: 10,
      total: 3,
      collectionIds: [10, 20, 30],
      bookmarkCount: 6,
      succeeded: [],
    });
    expect(preview.collections.map((n) => [n.id, n.parentId, n.count])).toEqual(
      [
        [10, null, 1],
        [20, 10, 3],
        [30, 20, 2],
      ],
    );
    expect(preview.digest).toMatch(/^v1:sha256:[a-f0-9]{64}$/);
    expect(f.state.writes).toEqual([]);
    const result = await f
      .service()
      .deleteCollectionPreviewFirst({ id: 10, ...confirmation(preview) });
    expect(result).toMatchObject({
      preview: false,
      succeeded: [10],
      failed: [],
      unknown: [],
      notExecuted: [],
    });
    expect(f.state.writes).toEqual([10]);
    expect(f.fetch.mock.calls.every(([r]) => !r.url.includes("-99"))).toBe(
      true,
    );
  });

  it("digest is deterministic under list reordering and changes on equal-count substitution, parent moves and direct count changes", async () => {
    const f = fixture([row(10), row(20, 10), row(30, 10)]);
    const p = await f.service().deleteCollectionPreviewFirst({ id: 10 });
    f.state.rows.reverse();
    expect(
      (await f.service().deleteCollectionPreviewFirst({ id: 10 })).digest,
    ).toBe(p.digest);
    for (const rows of [
      [row(10), row(21, 10), row(30, 10)],
      [row(10), row(20, 10), row(30, 20)],
      [row(10), row(20, 10, 1), row(30, 10)],
    ]) {
      f.state.rows = rows;
      expect(
        (await f.service().deleteCollectionPreviewFirst({ id: 10 })).digest,
      ).not.toBe(p.digest);
      await expect(
        f
          .service()
          .deleteCollectionPreviewFirst({ id: 10, ...confirmation(p) }),
      ).rejects.toThrow(/mismatch/);
    }
    expect(f.state.writes).toEqual([]);
  });

  it("compares each confirmation field before any write", async () => {
    const f = fixture();
    const p = await f.service().deleteCollectionPreviewFirst({ id: 10 });
    for (const changes of [
      { expectedTotal: 2 },
      { collectionIds: [10, 20] },
      { digest: `v1:sha256:${"0".repeat(64)}` },
    ]) {
      await expect(
        f
          .service()
          .deleteCollectionPreviewFirst({
            id: 10,
            ...confirmation(p),
            ...changes,
          }),
      ).rejects.toThrow(/mismatch/);
    }
    expect(f.state.writes).toEqual([]);
  });

  it.each([
    ["missing count", { count: undefined }],
    ["missing access", { access: undefined }],
    ["non-owner", { access: { level: 3 } }],
    ["wrong parent", { parent: { $id: 99 } }],
  ])("fails closed on %s metadata", async (_name, change) => {
    const f = fixture();
    f.state.override = (req) =>
      req.url.endsWith("/collection/20")
        ? json({ result: true, item: { ...row(20, 10), ...change } })
        : undefined;
    await expect(
      f.service().deleteCollectionPreviewFirst({ id: 10 }),
    ).rejects.toThrow(/verify/);
    expect(f.state.writes).toEqual([]);
  });

  it.each([
    {},
    { result: false, items: [] },
    { result: true },
    { result: true, items: [{}] },
  ])("rejects incomplete hierarchy response %j", async (response) => {
    const f = fixture();
    f.state.override = (req) =>
      req.url.endsWith("/collections/childrens") ? json(response) : undefined;
    await expect(
      f.service().deleteCollectionPreviewFirst({ id: 10 }),
    ).rejects.toThrow(/hierarchy/);
    expect(f.state.writes).toEqual([]);
  });

  it.each([
    { result: true, items: [] },
    { result: false, items: [], count: 0 },
    { result: true, items: [], count: 1 },
    { result: true, items: [{ _id: 1 }], count: 0 },
  ])("rejects unverified direct count %j", async (response) => {
    const f = fixture();
    f.state.override = (req) =>
      req.url.includes("/raindrops/20?") ? json(response) : undefined;
    await expect(
      f.service().deleteCollectionPreviewFirst({ id: 10 }),
    ).rejects.toThrow(/direct bookmarks/);
    expect(f.state.writes).toEqual([]);
  });

  it("fails closed when the nested endpoint is unavailable", async () => {
    const f = fixture();
    f.state.override = (req) =>
      req.url.endsWith("/collections/childrens") ? json({}, 404) : undefined;
    await expect(
      f.service().deleteCollectionPreviewFirst({ id: 10 }),
    ).rejects.toThrow();
    expect(f.state.writes).toEqual([]);
  });

  it("ignores stale caches, preserves them on preview or rejected preflight, and clears after confirmed/uncertain writes", async () => {
    const f = fixture();
    const s = f.service();
    const internals = s as unknown as {
      cacheCollections: Map<string, unknown>;
      cacheBookmarks: Map<string, unknown>;
      cacheSearch: Map<string, unknown>;
    };
    for (const cache of Object.values(internals).filter(
      (v) => v instanceof Map,
    ))
      cache.set("stale", "value");
    const p = await s.deleteCollectionPreviewFirst({ id: 10 });
    expect(internals.cacheCollections.get("stale")).toBe("value");
    await expect(
      s.deleteCollectionPreviewFirst({
        id: 10,
        ...confirmation(p),
        expectedTotal: 0,
      }),
    ).rejects.toThrow();
    expect(internals.cacheBookmarks.get("stale")).toBe("value");
    f.state.override = (req) =>
      req.method === "DELETE" ? json({}) : undefined;
    expect(
      (await s.deleteCollectionPreviewFirst({ id: 10, ...confirmation(p) }))
        .unknown,
    ).toEqual([10]);
    expect(internals.cacheCollections.size).toBe(0);
    expect(internals.cacheBookmarks.size).toBe(0);
    expect(internals.cacheSearch.size).toBe(0);
  });

  it.each([
    [{ result: true }, 200, "succeeded"],
    [{ result: false }, 200, "failed"],
    [{}, 200, "unknown"],
    [{}, 500, "unknown"],
    [{}, 429, "failed"],
  ] as const)(
    "classifies acknowledgement %j HTTP %s and never replays",
    async (body, status, outcome) => {
      const f = fixture();
      const p = await f.service().deleteCollectionPreviewFirst({ id: 10 });
      f.state.override = (req) =>
        req.method === "DELETE" ? json(body, status) : undefined;
      const s = new RaindropService({
        accessToken: "mock-only",
        maxReadRetries: 3,
      });
      const result = await s.deleteCollectionPreviewFirst({
        id: 10,
        ...confirmation(p),
      });
      expect(result[outcome]).toEqual([10]);
      expect(f.state.writes).toEqual([10]);
    },
  );

  it("reports a lost DELETE response as unknown without replaying it", async () => {
    const f = fixture();
    const p = await f.service().deleteCollectionPreviewFirst({ id: 10 });
    f.state.override = (req) => {
      if (req.method === "DELETE") throw new TypeError("Connection lost");
      return undefined;
    };
    const result = await f
      .service()
      .deleteCollectionPreviewFirst({ id: 10, ...confirmation(p) });
    expect(result).toMatchObject({
      succeeded: [],
      failed: [],
      unknown: [10],
      notExecuted: [],
    });
    expect(f.state.writes).toEqual([10]);
  });

  it.each([
    [row(10), row(20, 10), row(20, 10)],
    [row(10), row(20, 30), row(30, 20)],
    [row(10), row(20, 999)],
  ])(
    "rejects duplicate, cyclic or incomplete hierarchy %#",
    async (...rows) => {
      const f = fixture(rows);
      await expect(
        f.service().deleteCollectionPreviewFirst({ id: 10 }),
      ).rejects.toThrow(/Duplicate|Incomplete|cyclic/);
      expect(f.state.writes).toEqual([]);
    },
  );

  it("accepts consistent root/child overlap without widening the deletion scope", async () => {
    const f = fixture([row(10), row(20, 10), row(99)]);
    f.state.override = (req) => {
      if (new URL(req.url).pathname === "/rest/v1/collections")
        return json({ result: true, items: [row(10), row(20, 10), row(99)] });
      return undefined;
    };
    const preview = await f.service().deleteCollectionPreviewFirst({ id: 10 });
    expect(preview).toMatchObject({
      preview: true, rootId: 10, total: 2, collectionIds: [10, 20],
    });
    expect(preview.collections.map(c => [c.id, c.parentId])).toEqual([[10, null], [20, 10]]);
    expect(f.state.writes).toEqual([]);
    const result = await f.service().deleteCollectionPreviewFirst({
      id: 10, ...confirmation(preview),
    });
    expect(result.succeeded).toEqual([10]);
    expect(f.state.writes).toEqual([10]);
  });

  it("rejects conflicting overlap before any deletion", async () => {
    const f = fixture([row(10), row(20, 10)]);
    f.state.override = (req) => {
      if (new URL(req.url).pathname === "/rest/v1/collections")
        return json({ result: true, items: [row(10), { ...row(20, 10), title: "Conflicting" }] });
      return undefined;
    };
    await expect(f.service().deleteCollectionPreviewFirst({ id: 10 }))
      .rejects.toThrow(/Conflicting collection metadata/);
    expect(f.state.writes).toEqual([]);
  });

  it("rejects a large subtree before metadata enumeration or writes", async () => {
    const f = fixture([
      row(10),
      ...Array.from({ length: 30 }, (_, i) => row(20 + i, 10)),
    ]);
    await expect(
      f.service().deleteCollectionPreviewFirst({ id: 10 }),
    ).rejects.toThrow(/budget/);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.state.writes).toEqual([]);
  });

  it("charges read retries to the request budget and never dispatches attempt 61", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const s = new RaindropService({
      accessToken: "mock-only",
      maxReadRetries: 1,
    });
    let once = true;
    f.state.override = (req) => {
      if (once && req.url.endsWith("/collections")) {
        once = false;
        return json({}, 500);
      }
      return undefined;
    };
    const p = s.deleteCollectionPreviewFirst({ id: 10 });
    await vi.runAllTimersAsync();
    await p;
    expect(f.fetch).toHaveBeenCalledTimes(9);
    for (let i = 0; i < 6; i++)
      await s.deleteCollectionPreviewFirst({ id: 10 });
    await expect(s.deleteCollectionPreviewFirst({ id: 10 })).rejects.toThrow(
      /budget/,
    );
    expect(f.fetch.mock.calls.length).toBeLessThanOrEqual(60);
    expect(f.state.writes).toEqual([]);
  });
});

describe("T07 collection_remove_empty approved leaves only", () => {
  it("previews scoped empty leaves and does not delete a newly emptied parent", async () => {
    const f = fixture([row(10), row(20, 10), row(30, 10, 2), row(99)]);
    const p = await f
      .service()
      .removeEmptyCollectionsPreviewFirst({ rootId: 10 });
    expect(p.collectionIds).toEqual([20]);
    expect(p.collections.map((n) => n.id)).toEqual([10, 20, 30]);
    const result = await f
      .service()
      .removeEmptyCollectionsPreviewFirst({ rootId: 10, ...confirmation(p) });
    expect(result.succeeded).toEqual([20]);
    expect(f.state.writes).toEqual([20]);
    expect(f.fetch.mock.calls.every(([r]) => !r.url.includes("/clean"))).toBe(
      true,
    );
  });

  it.each(["nonempty", "nonleaf", "moved"])(
    "aborts before any writes when candidate becomes %s",
    async (change) => {
      const f = fixture();
      const p = await f
        .service()
        .removeEmptyCollectionsPreviewFirst({ rootId: 10 });
      if (change === "nonempty") f.state.rows[1]!.count = 1;
      if (change === "nonleaf") f.state.rows.push(row(40, 20));
      if (change === "moved") {
        f.state.rows.push(row(99));
        f.state.rows[1]!.parent = { $id: 99 };
      }
      await expect(
        f
          .service()
          .removeEmptyCollectionsPreviewFirst({
            rootId: 10,
            ...confirmation(p),
          }),
      ).rejects.toThrow(/mismatch/);
      expect(f.state.writes).toEqual([]);
    },
  );

  it.each(["count", "child", "parent", "permission"])(
    "revalidates %s immediately before each DELETE",
    async (change) => {
      const f = fixture();
      const p = await f
        .service()
        .removeEmptyCollectionsPreviewFirst({ rootId: 10 });
      let treeReads = 0;
      f.state.override = (req) => {
        if (req.url.endsWith("/collections")) {
          treeReads++;
          if (treeReads === 2) {
            if (change === "count") f.state.rows[1]!.count = 1;
            if (change === "child") f.state.rows.push(row(40, 20));
            if (change === "parent") f.state.rows[1]!.parent = { $id: 30 };
            if (change === "permission") f.state.rows[1]!.access = { level: 3 };
          }
        }
        return undefined;
      };
      const result = await f
        .service()
        .removeEmptyCollectionsPreviewFirst({ rootId: 10, ...confirmation(p) });
      expect(result).toMatchObject({
        succeeded: [],
        failed: [20],
        unknown: [],
        notExecuted: [30],
      });
      expect(f.state.writes).toEqual([]);
    },
  );

  it.each([
    [false, "failed"],
    [undefined, "unknown"],
  ] as const)(
    "stops sequential execution on %s acknowledgement",
    async (ack, status) => {
      const f = fixture([row(10), row(20, 10), row(30, 10), row(40, 10)]);
      const p = await f
        .service()
        .removeEmptyCollectionsPreviewFirst({ rootId: 10 });
      f.state.override = (req) =>
        req.method === "DELETE" && req.url.endsWith("/30")
          ? json({ result: ack })
          : undefined;
      const result = await f
        .service()
        .removeEmptyCollectionsPreviewFirst({ rootId: 10, ...confirmation(p) });
      expect(result.succeeded).toEqual([20]);
      expect(result[status]).toEqual([30]);
      expect(result.notExecuted).toEqual([40]);
      expect(f.state.writes).toEqual([20, 30]);
    },
  );

  it("retains prior success when the next candidate fails fresh metadata verification", async () => {
    const f = fixture([row(10), row(20, 10), row(30, 10), row(40, 10)]);
    const p = await f
      .service()
      .removeEmptyCollectionsPreviewFirst({ rootId: 10 });
    f.state.override = (req) =>
      f.state.writes.length === 1 && req.url.endsWith("/collection/30")
        ? json({ result: true, item: { ...row(30, 10), count: undefined } })
        : undefined;
    const result = await f
      .service()
      .removeEmptyCollectionsPreviewFirst({ rootId: 10, ...confirmation(p) });
    expect(result).toMatchObject({
      succeeded: [20],
      failed: [30],
      unknown: [],
      notExecuted: [40],
    });
    expect(f.state.writes).toEqual([20]);
  });

  it("allows a scoped root leaf and an empty candidate set", async () => {
    const f = fixture([row(10)]);
    const p = await f
      .service()
      .removeEmptyCollectionsPreviewFirst({ rootId: 10 });
    expect(p.collectionIds).toEqual([10]);
    f.state.rows[0]!.count = 1;
    const empty = await f
      .service()
      .removeEmptyCollectionsPreviewFirst({ rootId: 10 });
    expect(empty.total).toBe(0);
    expect(
      (
        await f
          .service()
          .removeEmptyCollectionsPreviewFirst({
            rootId: 10,
            ...confirmation(empty),
          })
      ).succeeded,
    ).toEqual([]);
    expect(f.state.writes).toEqual([]);
  });

  it("reserves per-candidate fresh revalidation and writes before starting execution", async () => {
    const f = fixture([
      row(10),
      ...Array.from({ length: 9 }, (_, i) => row(20 + i, 10)),
    ]);
    const p = await f
      .service()
      .removeEmptyCollectionsPreviewFirst({ rootId: 10 });
    await expect(
      f
        .service()
        .removeEmptyCollectionsPreviewFirst({ rootId: 10, ...confirmation(p) }),
    ).rejects.toThrow(/budget/);
    expect(f.state.writes).toEqual([]);
    expect(f.fetch.mock.calls.length).toBeLessThan(60);
  });
});

describe("T07 public MCP schemas and invocation", () => {
  it("rejects system/global scopes, unknown fields and incomplete confirmation", () => {
    for (const [schema, field] of [
      [CollectionDeleteInputSchema, "id"],
      [CollectionRemoveEmptyInputSchema, "rootId"],
    ] as const) {
      for (const id of [
        undefined,
        0,
        -99,
        -1,
        "10",
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
      ])
        expect(schema.safeParse({ [field]: id }).success).toBe(false);
      for (const extra of [
        { confirm: true },
        { all: true },
        { expectedTotal: 1 },
        { confirm: "true" },
      ])
        expect(schema.safeParse({ [field]: 10, ...extra }).success).toBe(false);
      expect(
        schema.safeParse({
          [field]: 10,
          confirm: true,
          expectedTotal: 2,
          collectionIds: [20, 10],
          digest: `v1:sha256:${"0".repeat(64)}`,
        }).success,
      ).toBe(false);
    }
  });

  it("lists 41 tools and executes both strict preview/confirm contracts over MCP", async () => {
    const f = fixture();
    const server = new RaindropMCPService({ accessToken: "mock-only" });
    const client = new Client({ name: "t07-contract", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.getServer().connect(st);
      await client.connect(ct);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(41);
      for (const name of ["collection_delete", "collection_remove_empty"]) {
        expect(tools.find((t) => t.name === name)).toMatchObject({
          outputSchema: expect.any(Object),
          annotations: { destructiveHint: true, idempotentHint: false },
        });
        const scope =
          name === "collection_delete" ? { id: 10 } : { rootId: 10 };
        const preview = await client.callTool({ name, arguments: scope });
        expect(preview.isError).not.toBe(true);
        const content = preview.structuredContent as unknown as Awaited<
          ReturnType<RaindropService["deleteCollectionPreviewFirst"]>
        >;
        expect(content.preview).toBe(true);
        expect(f.state.writes).toEqual([]);
        const invalid = await client.callTool({
          name,
          arguments: { ...scope, confirm: true },
        });
        expect(invalid.isError).toBe(true);
      }
      const preview = await client.callTool({
        name: "collection_remove_empty",
        arguments: { rootId: 10 },
      });
      const p = preview.structuredContent as unknown as Awaited<
        ReturnType<RaindropService["removeEmptyCollectionsPreviewFirst"]>
      >;
      const confirmed = await client.callTool({
        name: "collection_remove_empty",
        arguments: { rootId: 10, ...confirmation(p) },
      });
      expect(confirmed.isError).not.toBe(true);
      expect(confirmed.structuredContent).toMatchObject({
        succeeded: [20, 30],
      });
      expect(f.state.writes).toEqual([20, 30]);
    } finally {
      await client.close();
      await server.cleanup();
    }
  });
});
