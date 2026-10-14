import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTools } from "../src/tools/cleanup.js";

type Candidate = { _id: number; link?: string; note?: string; highlights?: unknown[] };
const verified = (id: number): Candidate => ({
  _id: id, link: "https://example.test/duplicate", note: "", highlights: [],
});

describe("remove_duplicates — direct execution and safe eligibility", () => {
  const tool = cleanupTools.find((item) => item.name === "remove_duplicates")! as any;
  let service: {
    getBookmarks: ReturnType<typeof vi.fn>;
    getCollections: ReturnType<typeof vi.fn>;
    getChildCollections: ReturnType<typeof vi.fn>;
    getBookmark: ReturnType<typeof vi.fn>;
    batchDeleteBookmarksInCollection: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    service = {
      getBookmarks: vi.fn(),
      getCollections: vi.fn().mockResolvedValue([{ _id: 123, title: "A" }]),
      getChildCollections: vi.fn().mockResolvedValue([]),
      getBookmark: vi.fn().mockImplementation(async (id: number) => verified(id)),
      batchDeleteBookmarksInCollection: vi.fn().mockResolvedValue(true),
    };
  });
  const ctx = () => ({ raindropService: service }) as any;
  const textOf = (result: { content: unknown[] }): string =>
    (result.content[0] as { text: string }).text;
  function mockDuplicates(ids: number[], extras: Record<number, Candidate> = {}) {
    service.getBookmarks.mockImplementation(async (params: {
      collection?: number; duplicates?: boolean; page?: number; perPage?: number
    }) => {
      if (params.collection === undefined) return { count: ids.length, items: [] };
      if (params.collection === -1) return { count: 0, items: [] };
      if (params.collection !== 123) throw new Error("Unexpected collection");
      return {
        count: ids.length,
        items: ids.slice((params.page ?? 0) * 50, (params.page ?? 0) * 50 + 50)
          .map(id => extras[id] ?? { _id: id }),
      };
    });
  }

  it("rejects old dryRun and any extra argument, without upstream calls", () => {
    for (const old of [{ dryRun: true }, { dryRun: false }, { other: 1 }]) {
      expect(tool.inputSchema.safeParse(old).success).toBe(false);
    }
    expect(tool.inputSchema.safeParse({ skipCache: true }).success).toBe(true);
    expect(service.getBookmarks).not.toHaveBeenCalled();
  });

  it("reports an empty library without deletion", async () => {
    mockDuplicates([]);
    const response = await tool.handler({}, ctx());
    expect(textOf(response)).toContain("No duplicates found");
    expect(service.batchDeleteBookmarksInCollection).not.toHaveBeenCalled();
  });

  it("deletes only freshly verified unannotated candidates, skipping notes and highlights", async () => {
    mockDuplicates([1, 2, 3, 4, 5]);
    service.getBookmark.mockImplementation(async (id: number) => ({
      1: verified(1),
      2: { _id: 2, link: "https://example.test/duplicate", note: "valuable note", highlights: [] },
      3: { _id: 3, link: "https://example.test/duplicate", note: "", highlights: [{ text: "highlight" }] },
      4: { _id: 4 }, // missing metadata is NOT proof of safety
      5: verified(5),
    })[id]);
    const response = await tool.handler({}, ctx());
    expect(textOf(response)).toContain("Deleted 1 verified");
    expect(textOf(response)).toContain("protected: 2, unverifiable: 1");
    expect(service.getBookmark).toHaveBeenCalledWith(1, true);
    expect(service.batchDeleteBookmarksInCollection).toHaveBeenCalledExactlyOnceWith(123, [5]);
  });

  it("uses -1 for Unsorted and never sends a deletion to all-bookmarks id 0", async () => {
    service.getCollections.mockResolvedValueOnce([]);
    service.getBookmarks.mockImplementation(async (params: { collection?: number }) =>
      params.collection === undefined ? { count: 2, items: [] } :
      params.collection === -1 ? { count: 2, items: [{ _id: 77 }, { _id: 78 }] } :
      (() => { throw new Error("Unexpected collection"); })(),
    );
    const response = await tool.handler({}, ctx());
    expect(textOf(response)).toContain("Deleted 1 verified");
    expect(service.batchDeleteBookmarksInCollection).toHaveBeenCalledWith(-1, [78]);
    expect(service.batchDeleteBookmarksInCollection).not.toHaveBeenCalledWith(0, expect.anything());
  });

  it("scans nested child collections rather than only root collections", async () => {
    service.getChildCollections.mockImplementation(async (id: number) =>
      id === 123 ? [{ _id: 456, title: "Nested" }] : [],
    );
    service.getBookmarks.mockImplementation(async (params: { collection?: number }) => {
      if (params.collection === undefined) return { count: 2, items: [] };
      if (params.collection === 456) return { count: 2, items: [{ _id: 88 }, { _id: 89 }] };
      return { count: 0, items: [] };
    });
    const response = await tool.handler({}, ctx());
    expect(textOf(response)).toContain("Deleted 1 verified");
    expect(service.getChildCollections).toHaveBeenCalledWith(123, undefined);
    expect(service.getChildCollections).toHaveBeenCalledWith(456, undefined);
    expect(service.batchDeleteBookmarksInCollection).toHaveBeenCalledWith(456, [89]);
  });

  it("fails closed when all candidates lack complete metadata", async () => {
    mockDuplicates([1, 2]);
    service.getBookmark.mockResolvedValue({ _id: 1, note: "" });
    const response = await tool.handler({}, ctx());
    expect(textOf(response)).toContain("nothing deleted");
    expect(service.batchDeleteBookmarksInCollection).not.toHaveBeenCalled();
  });

  it("paginates and deletes in upstream batches of 50, not a global 50 cap", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => i + 1);
    mockDuplicates(ids);
    const response = await tool.handler({ skipCache: true }, ctx());
    expect(textOf(response)).toContain("Deleted 119 verified");
    expect(service.batchDeleteBookmarksInCollection).toHaveBeenCalledTimes(3);
    expect(service.batchDeleteBookmarksInCollection).toHaveBeenNthCalledWith(1, 123, ids.slice(1, 51));
    expect(service.batchDeleteBookmarksInCollection).toHaveBeenNthCalledWith(2, 123, ids.slice(51, 101));
    expect(service.batchDeleteBookmarksInCollection).toHaveBeenNthCalledWith(3, 123, ids.slice(101));
  });

  it("preserves the only verified copy of each distinct URL", async () => {
    mockDuplicates([10, 11]);
    service.getBookmark.mockImplementation(async (id: number) => ({
      ...verified(id), link: `https://example.test/item-${id}`,
    }));
    const response = await tool.handler({}, ctx());
    expect(textOf(response)).toContain("Kept canonical copies: 2");
    expect(service.batchDeleteBookmarksInCollection).not.toHaveBeenCalled();
  });

  it("aborts before any deletion when pagination is inconsistent", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => i + 1);
    mockDuplicates(ids);
    service.getBookmarks.mockImplementation(async (p: {collection?: number; page?: number}) =>
      p.collection === undefined ? { count: 60, items: [] } :
      p.collection === -1 ? { count: 0, items: [] } :
      p.page === 1 ? { count: 59, items: ids.slice(50).map(_id => ({_id})) } :
      { count: 60, items: ids.slice(0, 50).map(_id => ({_id})) }
    );
    await expect(tool.handler({}, ctx())).rejects.toThrow(/pagination/);
    expect(service.batchDeleteBookmarksInCollection).not.toHaveBeenCalled();
  });

  it("stops after an uncertain batch failure without retrying", async () => {
    const ids = Array.from({ length: 75 }, (_, i) => i + 1);
    mockDuplicates(ids);
    service.batchDeleteBookmarksInCollection
      .mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("upstream timeout"));
    const response = await tool.handler({}, ctx());
    expect(textOf(response)).toContain("outcome is unknown");
    expect(textOf(response)).toContain("50 items previously acknowledged");
    expect(service.batchDeleteBookmarksInCollection).toHaveBeenCalledTimes(2);
  });

  it("returns a bounded uncertain outcome on false instead of continuing", async () => {
    mockDuplicates([7, 8]);
    service.batchDeleteBookmarksInCollection.mockResolvedValueOnce(false);
    const response = await tool.handler({}, ctx());
    expect(textOf(response)).toContain("outcome is uncertain");
    expect(service.batchDeleteBookmarksInCollection).toHaveBeenCalledTimes(1);
  });
});
