import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTools } from "../src/tools/cleanup.js";

type Candidate = { _id: number; note?: string; highlights?: unknown[] };
const verified = (id: number): Candidate => ({ _id: id, note: "", highlights: [] });

describe("remove_duplicates — direct execution and safe eligibility", () => {
  const tool = cleanupTools.find((item) => item.name === "remove_duplicates")! as any;
  let service: {
    getBookmarks: ReturnType<typeof vi.fn>;
    getCollections: ReturnType<typeof vi.fn>;
    getBookmark: ReturnType<typeof vi.fn>;
    batchDeleteBookmarksInCollection: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    service = {
      getBookmarks: vi.fn(),
      getCollections: vi.fn().mockResolvedValue([{ _id: 123, title: "A" }]),
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
      if (params.collection === 0) return { count: 0, items: [] };
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
      2: { _id: 2, note: "valuable note", highlights: [] },
      3: { _id: 3, note: "", highlights: [{ text: "highlight" }] },
      4: { _id: 4 }, // missing metadata is NOT proof of safety
      5: { _id: 5, note: "", highlights: [] },
    })[id]);
    const response = await tool.handler({}, ctx());
    expect(textOf(response)).toContain("Deleted 2 verified");
    expect(textOf(response)).toContain("Protected: 2, unverifiable: 1");
    expect(service.getBookmark).toHaveBeenCalledWith(1, true);
    expect(service.batchDeleteBookmarksInCollection).toHaveBeenCalledExactlyOnceWith(123, [1, 5]);
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
    expect(textOf(response)).toContain("Deleted 120 verified");
    expect(service.batchDeleteBookmarksInCollection).toHaveBeenCalledTimes(3);
    expect(service.batchDeleteBookmarksInCollection).toHaveBeenNthCalledWith(1, 123, ids.slice(0, 50));
    expect(service.batchDeleteBookmarksInCollection).toHaveBeenNthCalledWith(2, 123, ids.slice(50, 100));
    expect(service.batchDeleteBookmarksInCollection).toHaveBeenNthCalledWith(3, 123, ids.slice(100));
  });

  it("aborts before any deletion when pagination is inconsistent", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => i + 1);
    mockDuplicates(ids);
    service.getBookmarks.mockImplementation(async (p: {collection?: number; page?: number}) =>
      p.collection === undefined ? { count: 60, items: [] } :
      p.collection === 0 ? { count: 0, items: [] } :
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
    mockDuplicates([7]);
    service.batchDeleteBookmarksInCollection.mockResolvedValueOnce(false);
    const response = await tool.handler({}, ctx());
    expect(textOf(response)).toContain("outcome is uncertain");
    expect(service.batchDeleteBookmarksInCollection).toHaveBeenCalledTimes(1);
  });
});
