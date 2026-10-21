import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import RaindropService from "../src/services/raindrop.service.js";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";
import {
  DuplicateRemovalOutputSchema,
  bookmarkRemoveDuplicatesTool as tool,
} from "../src/tools/duplicates.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const item = (id: number, extra: Record<string, unknown> = {}) => ({
  _id: id,
  link: "https://example.test/exact",
  collection: { $id: 7 },
  title: "Exact duplicate",
  excerpt: "",
  note: "",
  highlights: [],
  tags: [],
  important: false,
  ...extra,
});
// An official HTTP mock: list items deliberately omit full metadata; individual
// GETs provide it. No real network/credentials are used by this suite.
class OfficialMock {
  items = new Map<number, ReturnType<typeof item>>([
    [1, item(1)],
    [2, item(2)],
  ]);
  ids = [1, 2];
  expectedDeleteIds?: number[];
  pageOverride?: (page: number) => unknown;
  detailOverride?: (id: number, read: number) => unknown;
  detailReads = new Map<number, number>();
  write: "ok" | "lost" | "429" = "ok";
  fetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (request.method === "DELETE") {
      expect(url.pathname).toBe("/rest/v1/raindrops/7");
      expect(url.search).toBe("");
      expect(await request.json()).toEqual({
        ids: this.expectedDeleteIds ?? this.ids.filter((id) => id !== 1),
      });
      if (this.write === "lost") throw new TypeError("lost response");
      if (this.write === "429") return json({}, 429);
      return json({ result: true, modified: this.expectedDeleteIds?.length ?? this.ids.length - 1 });
    }
    expect(request.method).toBe("GET");
    if (url.pathname === "/rest/v1/collection/7")
      return json({ result: true, item: { _id: 7 } });
    if (url.pathname === "/rest/v1/raindrops/7") {
      expect(Object.fromEntries(url.searchParams)).toEqual({
        search: "duplicate:true",
        page: url.searchParams.get("page"),
        perpage: "50",
        nested: "false",
      });
      const page = Number(url.searchParams.get("page"));
      return json(
        this.pageOverride
          ? this.pageOverride(page)
          : {
              result: true,
              count: this.ids.length,
              items: page === 0 ? this.ids.map((_id) => ({ _id })) : [],
            },
      );
    }
    const id = Number(url.pathname.split("/").at(-1));
    const read = (this.detailReads.get(id) ?? 0) + 1;
    this.detailReads.set(id, read);
    return json(
      this.detailOverride
        ? this.detailOverride(id, read)
        : { result: true, item: this.items.get(id) },
    );
  });
  constructor() {
    vi.stubGlobal("fetch", this.fetch);
  }
  writes() {
    return this.fetch.mock.calls.filter(([r]) => r.method !== "GET");
  }
}
const api = () =>
  new RaindropService({ accessToken: "mock-only", maxReadRetries: 0 });
const call = (service: RaindropService, args: Record<string, unknown> = {}) =>
  tool.handler(
    { collectionId: 7, ...args } as never,
    { raindropService: service } as never,
  );
const preview = async (service: RaindropService) =>
  (await call(service)).structuredContent;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("official atomic duplicate removal", () => {
  it("binds a deterministic complete preview and preserves T06 unknown aggregate outcomes", async () => {
    const mock = new OfficialMock();
    const p = await preview(api());
    expect(p).toMatchObject({
      status: "preview",
      observedTotal: 2,
      protectedCount: 0,
      unknownCount: 0,
      confirmation: { candidateIds: [2], keeperIds: [1], total: 1 },
    });
    expect(p.confirmation.digest).toMatch(
      /^duplicates-v1:sha256:[a-f0-9]{64}$/,
    );
    expect(DuplicateRemovalOutputSchema.safeParse(p).success).toBe(true);
    expect(DuplicateRemovalOutputSchema.safeParse({ ...p, items: [{ id: "invalid" }] }).success).toBe(false);
    expect(DuplicateRemovalOutputSchema.safeParse({ ...p, notInContract: 123 }).success).toBe(false);
    expect((await preview(api())).confirmation).toEqual(p.confirmation);
    expect(mock.writes()).toHaveLength(0);
    const result = await call(api(), { confirm: p.confirmation });
    expect(result.structuredContent).toMatchObject({
      status: "unknown",
      succeeded: [],
      unknown: [2],
      notExecuted: [],
      acknowledged: true,
      dispatched: true,
    });
    expect(DuplicateRemovalOutputSchema.safeParse(result.structuredContent).success).toBe(true);
    expect(mock.writes()).toHaveLength(1);
    expect(mock.detailReads.get(1)).toBe(4); // two previews, confirm scan, final keeper
    expect(mock.detailReads.get(2)).toBe(5); // includes T06 independent preflight
  });

  it.each([
    ["different title", { title: "Unique edited title" }],
    ["different excerpt", { excerpt: "Unique saved summary" }],
    ["missing title", { title: undefined }],
    ["missing excerpt", { excerpt: undefined }],
  ])("preserves distinct user content: %s", async (_name, changed) => {
    const mock = new OfficialMock();
    mock.items.set(2, item(2, changed));
    const p = await preview(api());
    expect(p.confirmation.candidateIds).toEqual([]);
    expect(p.protectedCount + p.unknownCount).toBeGreaterThan(0);
    expect((await call(api(), { confirm: p.confirmation })).structuredContent.status)
      .toBe("notExecuted");
    expect(mock.writes()).toHaveLength(0);
  });

  it("allows a 50-item preview with one actual duplicate and a feasible confirmation budget", async () => {
    const mock = new OfficialMock();
    mock.ids = Array.from({ length: 50 }, (_, i) => i + 1);
    for (const id of mock.ids)
      mock.items.set(id, item(id, {
        link: id <= 2 ? "https://example.test/exact" : `https://example.test/unique/${id}`,
      }));
    const result = await preview(api());
    expect(result.observedTotal).toBe(50);
    expect(result.confirmation.candidateIds).toEqual([2]);
    expect(mock.writes()).toHaveLength(0);
    mock.fetch.mockClear();
    mock.expectedDeleteIds = [2];
    const done = await call(api(), { confirm: result.confirmation });
    expect(done.structuredContent).toMatchObject({
      status: "unknown", dispatched: true, unknown: [2],
    });
    // 3 list requests + 50 metadata + 2 affected items + 1 candidate
    // membership preflight + 1 scoped write = 57.
    expect(mock.fetch).toHaveBeenCalledTimes(57);
    expect(mock.writes()).toHaveLength(1);
  });

  it("sorts official IDs and preserves the same digest across result order changes", async () => {
    const mock = new OfficialMock();
    const p = await preview(api());
    mock.ids = [2, 1];
    expect((await preview(api())).confirmation).toEqual(p.confirmation);
  });

  it("truthfully previews and confirms an empty official scope without writes", async () => {
    const mock = new OfficialMock();
    mock.ids = [];
    const p = await preview(api());
    expect(p).toMatchObject({
      observedTotal: 0,
      confirmation: { candidateIds: [], keeperIds: [], total: 0 },
    });
    expect(
      (await call(api(), { confirm: p.confirmation })).structuredContent.status,
    ).toBe("notExecuted");
    expect(mock.writes()).toHaveLength(0);
  });

  it("rejects final candidate metadata changes even with unchanged URL and source", async () => {
    const mock = new OfficialMock();
    const p = await preview(api());
    mock.detailReads.clear();
    mock.detailOverride = (id, read) => ({
      result: true,
      item: item(
        id,
        id === 2 && read >= 2 ? { highlights: [{ text: "new" }] } : {},
      ),
    });
    await expect(call(api(), { confirm: p.confirmation })).rejects.toThrow(
      /changed/,
    );
    expect(mock.writes()).toHaveLength(0);
  });

  it.each([
    { note: "valuable" },
    { highlights: [{ text: "valuable" }] },
    { tags: ["keep"] },
    { important: true },
    { reminder: { date: "2030-01-01" } },
  ])(
    "prefers a protected keeper and never deletes its metadata: %j",
    async (extra) => {
      const mock = new OfficialMock();
      mock.items.set(2, item(2, extra));
      const p = await preview(api());
      expect(p).toMatchObject({
        protectedCount: 1,
        confirmation: { keeperIds: [2], candidateIds: [1] },
      });
      expect(mock.writes()).toHaveLength(0);
    },
  );

  it.each(["note", "highlights", "tags", "important"])(
    "protects missing %s metadata and reports uncertainty",
    async (key) => {
      const mock = new OfficialMock();
      const partial = item(2);
      delete (partial as Record<string, unknown>)[key];
      mock.items.set(2, partial);
      const p = await preview(api());
      expect(p).toMatchObject({
        unknownCount: 1,
        confirmation: { candidateIds: [], total: 0 },
      });
      await call(api(), { confirm: p.confirmation });
      expect(mock.writes()).toHaveLength(0);
    },
  );

  it("retains the sole official candidate even when another collection has the URL", async () => {
    const mock = new OfficialMock();
    mock.ids = [2];
    mock.items.set(99, item(99, { collection: { $id: 99 } }));
    const p = await preview(api());
    expect(p.confirmation).toMatchObject({ candidateIds: [], keeperIds: [2] });
    await call(api(), { confirm: p.confirmation });
    expect(mock.writes()).toHaveLength(0);
    expect(mock.detailReads.has(99)).toBe(false);
  });

  it("uses exact URL equality without normalization", async () => {
    const mock = new OfficialMock();
    mock.items.set(2, item(2, { link: "https://example.test/exact/" }));
    expect((await preview(api())).confirmation.candidateIds).toEqual([]);
  });

  it.each([
    "replacement",
    "url",
    "note",
    "keeper",
    "parent",
    "count",
    "keeper-protected-change",
  ])("rejects fresh snapshot mutation: %s", async (change) => {
    const mock = new OfficialMock();
    if (change === "keeper-protected-change")
      mock.items.set(1, item(1, { tags: ["old"] }));
    const p = await preview(api());
    if (change === "replacement") {
      mock.ids = [1, 3];
      mock.items.set(3, item(3));
    }
    if (change === "url") {
      mock.items.set(1, item(1, { link: "changed" }));
      mock.items.set(2, item(2, { link: "changed" }));
    }
    if (change === "note") mock.items.set(2, item(2, { note: "new" }));
    if (change === "keeper") mock.items.set(1, item(1, { important: true }));
    if (change === "keeper-protected-change")
      mock.items.set(1, item(1, { tags: ["new"] }));
    if (change === "parent")
      mock.items.set(1, item(1, { collection: { $id: 8 } }));
    if (change === "count") mock.ids = [1];
    await expect(call(api(), { confirm: p.confirmation })).rejects.toThrow();
    expect(mock.writes()).toHaveLength(0);
  });

  it.each([1, 2])(
    "rechecks deletion candidates and final retained keeper %s before writes",
    async (changedId) => {
      const mock = new OfficialMock();
      const p = await preview(api());
      mock.detailReads.clear();
      mock.detailOverride = (id, read) => ({
        result: true,
        item: item(
          id,
          id === changedId && read >= 2 ? { collection: { $id: 8 } } : {},
        ),
      });
      await expect(call(api(), { confirm: p.confirmation })).rejects.toThrow();
      expect(mock.writes()).toHaveLength(0);
    },
  );

  it("ignores stale metadata and search caches", async () => {
    const mock = new OfficialMock();
    const service = api();
    await service.getBookmark(2);
    const p = await preview(service);
    mock.items.set(2, item(2, { note: "fresh note" }));
    await expect(call(service, { confirm: p.confirmation })).rejects.toThrow(
      /mismatch/,
    );
    expect(mock.writes()).toHaveLength(0);
  });

  it.each([
    {},
    { result: false, count: 0, items: [] },
    { count: 0, items: [] },
    { result: true, count: -1, items: [] },
    { result: true, count: 1.5, items: [] },
    { result: true, count: 51, items: [] },
    { result: true, count: 2, items: [] },
    { result: true, count: 2, items: [{ _id: 1 }, { _id: 1 }] },
    { result: true, count: 1, items: [{ _id: "1" }] },
    { result: true, count: 0, items: null },
  ])(
    "fails closed on malformed/incomplete/oversized official scope %j",
    async (body) => {
      const mock = new OfficialMock();
      mock.pageOverride = () => body;
      await expect(preview(api())).rejects.toThrow();
      expect(mock.writes()).toHaveLength(0);
    },
  );

  it.each(["overlap", "count-change"])(
    "rejects terminal page %s",
    async (change) => {
      const mock = new OfficialMock();
      mock.pageOverride = (page) => ({
        result: true,
        count: page && change === "count-change" ? 1 : 2,
        items: page
          ? change === "overlap"
            ? [{ _id: 1 }]
            : []
          : [{ _id: 1 }, { _id: 2 }],
      });
      await expect(preview(api())).rejects.toThrow(/pagination/);
      expect(mock.writes()).toHaveLength(0);
    },
  );

  it("rejects more than 10 eligible deletions without silently truncating", async () => {
    const mock = new OfficialMock();
    mock.ids = Array.from({ length: 12 }, (_, i) => i + 1);
    mock.items = new Map(mock.ids.map((id) => [id, item(id)]));
    await expect(preview(api())).rejects.toThrow(/more than 10/);
    expect(mock.writes()).toHaveLength(0);
  });

  it.each(["lost", "429"] as const)(
    "never replays writes with %s response",
    async (failure) => {
      const mock = new OfficialMock();
      const p = await preview(api());
      mock.write = failure;
      const result = await call(
        new RaindropService({ accessToken: "mock-only", maxReadRetries: 3 }),
        { confirm: p.confirmation },
      );
      expect(result.structuredContent).toMatchObject({
        status: "unknown",
        unknown: [2],
        succeeded: [],
        dispatched: true,
      });
      expect(mock.writes()).toHaveLength(1);
    },
  );

  it("bounds upstream attempts including read retries at 60 before any write", async () => {
    vi.useFakeTimers();
    const mock = new OfficialMock();
    mock.ids = Array.from({ length: 50 }, (_, i) => i + 1);
    mock.items = new Map(
      mock.ids.map((id) => [
        id,
        item(id, { link: `https://example.test/${id}` }),
      ]),
    );
    const original = mock.fetch.getMockImplementation()!;
    let detailAttempt = 0;
    mock.fetch.mockImplementation(async (request) => {
      if (new URL(request.url).pathname.includes("/raindrop/")) {
        detailAttempt++;
        if (detailAttempt % 2) return json({}, 500);
      }
      return original(request);
    });
    const pending = expect(
      preview(
        new RaindropService({ accessToken: "mock-only", maxReadRetries: 1 }),
      ),
    ).rejects.toThrow(/60/);
    await vi.runAllTimersAsync();
    await pending;
    expect(mock.fetch).toHaveBeenCalledTimes(60);
    expect(mock.writes()).toHaveLength(0);
  });

  it("refuses a confirmation that cannot fit the 60-request budget at preview", async () => {
    const mock = new OfficialMock();
    mock.ids = Array.from({ length: 50 }, (_, i) => i + 1);
    mock.items = new Map(
      mock.ids.map((id) => [
        id,
        item(id, { link: id <= 11 ? "same" : `url-${id}` }),
      ]),
    );
    await expect(preview(api())).rejects.toThrow(/exceeds 60 upstream requests/);
    // Rejection happens during preview, not after issuing an impossible confirm.
    expect(mock.fetch).toHaveBeenCalledTimes(53);
    expect(mock.writes()).toHaveLength(0);
  });

  it("preserves T06 notExecuted on a failed independent membership preflight", async () => {
    const mock = new OfficialMock();
    const p = await preview(api());
    mock.detailReads.clear();
    mock.detailOverride = (id, read) => ({
      result: true,
      item: item(id, id === 2 && read >= 3 ? { collection: { $id: 8 } } : {}),
    });
    const result = await call(api(), { confirm: p.confirmation });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        status: "failed",
        dispatched: false,
        unknown: [],
        notExecuted: [2],
        succeeded: [],
      },
    });
    expect(mock.writes()).toHaveLength(0);
  });

  it.each([
    {},
    { result: false, item: item(1) },
    { result: true, item: { _id: 1 } },
  ])("refuses malformed fresh full metadata %j", async (body) => {
    const mock = new OfficialMock();
    mock.detailOverride = () => body;
    await expect(preview(api())).rejects.toThrow(/verify/);
    expect(mock.writes()).toHaveLength(0);
  });

  it.each([403, 404])(
    "fails closed on inaccessible collection %s",
    async (status) => {
      const mock = new OfficialMock();
      mock.fetch.mockImplementation(async () => json({}, status));
      await expect(preview(api())).rejects.toThrow();
      expect(mock.writes()).toHaveLength(0);
    },
  );

  it("validates strict public MCP preview/confirmation and keeps legacy deletion closed", async () => {
    const mock = new OfficialMock();
    const mcp = new RaindropMCPService({
      accessToken: "mock-only",
      maxReadRetries: 0,
    });
    const client = new Client({ name: "duplicates-protocol", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await mcp.getServer().connect(st);
      await client.connect(ct);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(25);
      const listed = tools.find((t) => t.name === tool.name)!;
      expect(listed.outputSchema).toBeDefined();
      expect(listed.outputSchema?.type).toBe("object");
      expect(listed.outputSchema?.additionalProperties).toBe(false);
      expect(listed.inputSchema.required).toEqual(["collectionId"]);
      expect(listed.inputSchema.additionalProperties).toBe(false);
      for (const args of [
        {},
        { collectionId: 0 },
        { collectionId: -1 },
        { collectionId: 7, dryRun: false },
        { collectionId: 7, confirm: true },
        { collectionId: 7, nested: true },
      ])
        expect(
          (await client.callTool({ name: tool.name, arguments: args })).isError,
        ).toBe(true);
      await expect(client.callTool({
        name: "remove_duplicates",
        arguments: { dryRun: false },
      })).rejects.toThrow(/not found/i);
      expect(mock.fetch).not.toHaveBeenCalled();
      const p = await client.callTool({
        name: tool.name,
        arguments: { collectionId: 7 },
      });
      expect(p.isError).not.toBe(true);
      expect(DuplicateRemovalOutputSchema.safeParse(p.structuredContent).success).toBe(true);
      const confirm = (p.structuredContent as Record<string, unknown>)
        .confirmation as Record<string, unknown>;
      for (const bad of [
        { ...confirm, digest: "duplicates-v1:sha256:" + "0".repeat(64) },
        { ...confirm, total: 0 },
        { ...confirm, candidateIds: [1] },
        { ...confirm, keeperIds: [2] },
        { ...confirm, candidateIds: [2, 1] },
        { ...confirm, extra: true },
      ]) {
        expect(
          (
            await client.callTool({
              name: tool.name,
              arguments: { collectionId: 7, confirm: bad },
            })
          ).isError,
        ).toBe(true);
        expect(mock.writes()).toHaveLength(0);
      }
      const result = await client.callTool({
        name: tool.name,
        arguments: { collectionId: 7, confirm },
      });
      expect(result.structuredContent).toMatchObject({
        status: "unknown",
        unknown: [2],
        notExecuted: [],
      });
      expect(DuplicateRemovalOutputSchema.safeParse(result.structuredContent).success).toBe(true);
      expect(mock.writes()).toHaveLength(1);
    } finally {
      await client.close();
      await mcp.cleanup();
    }
  });
});
