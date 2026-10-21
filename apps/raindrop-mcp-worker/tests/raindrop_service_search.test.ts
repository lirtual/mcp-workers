import { describe, expect, it, vi, beforeEach } from "vitest";
import RaindropService from "../src/services/raindrop.service.js";

// Mock openapi-fetch
vi.mock("openapi-fetch", () => ({
  default: vi.fn(() => ({
    GET: vi.fn().mockResolvedValue({ data: { result: true, items: [], count: 0 } }),
    POST: vi.fn().mockResolvedValue({ data: { result: false, ids: [] } }),
    PUT: vi.fn(),
    DELETE: vi.fn(),
    use: vi.fn(),
  })),
}));

describe("RaindropService.getBookmarks filter mapping", () => {
  let service: RaindropService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new RaindropService("fake-token");
  });

  it("maps new filters to search string", async () => {
    const mockGet = (service as any).client.GET;

    await service.getBookmarks({
      createdStart: "2023-01-01",
      createdEnd: "2023-12-31",
      media: "video",
      duplicates: true,
    });

    expect(mockGet).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        params: expect.objectContaining({
          query: expect.objectContaining({
            search: expect.stringContaining("created:>=2023-01-01"),
          }),
        }),
      }),
    );

    const searchString = mockGet.mock.calls[0][1].params.query.search;
    expect(searchString).toContain("created:>=2023-01-01");
    expect(searchString).toContain("created:<=2023-12-31");
    expect(searchString).toContain("type:video");
    expect(searchString).toContain("duplicate:true");
  });
});

describe("RaindropService.bookmarkExists official URL existence contract", () => {
  it("treats result:false as a normal, absent bookmark", async () => {
    const service = new RaindropService("fake-token");
    const post = (service as any).client.POST;
    post.mockResolvedValueOnce({ data: { result: false, ids: [] } });

    await expect(service.bookmarkExists("https://example.com/a")).resolves.toEqual({
      exists: false,
      ids: [],
    });
    expect(post).toHaveBeenCalledWith("/import/url/exists", {
      body: { urls: ["https://example.com/a"] },
    });
  });

  it("returns all IDs actually reported for a single URL", async () => {
    const service = new RaindropService("fake-token");
    const post = (service as any).client.POST;
    post.mockResolvedValueOnce({ data: { result: true, ids: [123, 456] } });

    await expect(service.bookmarkExists("https://example.com/a")).resolves.toEqual({
      exists: true,
      ids: [123, 456],
    });
  });

  it("rejects contradictory or unverified upstream results", async () => {
    const service = new RaindropService({ accessToken: "fake-token", maxReadRetries: 0 });
    const post = (service as any).client.POST;
    post.mockResolvedValueOnce({ data: { result: false, ids: [123] } });
    await expect(service.bookmarkExists("https://example.com/a")).rejects.toThrow();

    post.mockResolvedValueOnce({ data: { result: true, ids: ["123"] } });
    await expect(service.bookmarkExists("https://example.com/a")).rejects.toThrow();
  });
});

describe("RaindropService search semantics and pagination", () => {
  it("passes zero-based page zero and max 50 per page to the official endpoint", async () => {
    const service = new RaindropService("fake-token");
    const get = (service as any).client.GET;
    await service.getBookmarks({ collection: -1, page: 0, perPage: 50 });
    expect(get).toHaveBeenCalledWith("/raindrops/{id}", {
      params: { path: { id: -1 }, query: { page: 0, perpage: 50 } },
    });
  });

  it("uses the official Favorites search operator and collection path", async () => {
    const service = new RaindropService("fake-token");
    const get = (service as any).client.GET;
    await service.getBookmarks({ important: true, collection: 97, page: 0, perPage: 10 }, true);
    expect(get).toHaveBeenCalledWith("/raindrops/{id}", {
      params: { path: { id: 97 }, query: { search: "❤️", page: 0, perpage: 10 } },
    });
  });

  it.each([
    ["HTTP error response", { error: { message: "upstream error" } }],
    ["missing response", { data: undefined }],
    ["upstream result false", { data: { result: false, items: [], count: 0 } }],
    ["missing count", { data: { result: true, items: [] } }],
    ["wrong count type", { data: { result: true, items: [], count: "0" } }],
    ["missing items", { data: { result: true, count: 0 } }],
    ["negative count", { data: { result: true, items: [], count: -1 } }],
  ])("rejects %s rather than returning zero Favorites", async (_label, response) => {
    const service = new RaindropService({ accessToken: "fake-token", maxReadRetries: 0 });
    const get = (service as any).client.GET;
    get.mockResolvedValueOnce(response);
    await expect(service.getBookmarks({ important: true }, true))
      .rejects.toThrow("bookmark search response could not be verified");
  });

  it("never turns important:false into favorites-only results", async () => {
    const service = new RaindropService("fake-token");
    const get = (service as any).client.GET;
    await service.getBookmarks({ important: false });
    const search = get.mock.calls[0][1].params.query.search;
    expect(search).not.toContain("important:true");
    expect(search).toContain("-❤️");
  });

  it("uses actual search operators rather than undocumented API query fields", async () => {
    const service = new RaindropService("fake-token");
    const get = (service as any).client.GET;
    await service.getBookmarks({ search: "rust", tags: ["dev"], media: "article" });
    const query = get.mock.calls[0][1].params.query;
    expect(query).not.toHaveProperty("tag");
    expect(query.search).toContain("#dev");
    expect(query.search).toContain("type:article");
    expect(query.search).toContain("rust");
  });
});

describe("RaindropService official filters", () => {
  it("queries the /filters/{collectionId} scope and omits absent statistics", async () => {
    const service = new RaindropService("fake-token");
    const get = (service as any).client.GET;
    get.mockResolvedValueOnce({
      data: { result: true, important: { count: 3 },
        tags: [{ _id: "backend", count: 2 }] },
    });
    await expect(service.getBookmarkFilters(0, "-count", "dev"))
      .resolves.toEqual({ important: 3, tags: [{ name: "backend", count: 2 }] });
    expect(get).toHaveBeenCalledWith("/filters/{collectionId}", {
      params: { path: { collectionId: 0 }, query: { tagsSort: "-count", search: "dev" } },
    });
  });

  it("fails closed for an upstream result:false or fabricated count", async () => {
    const service = new RaindropService({ accessToken: "fake-token", maxReadRetries: 0 });
    const get = (service as any).client.GET;
    get.mockResolvedValueOnce({ data: { result: false } });
    await expect(service.getBookmarkFilters(0)).rejects.toThrow();
    get.mockResolvedValueOnce({ data: { result: true, duplicates: { count: "0" } } });
    await expect(service.getBookmarkFilters(0)).rejects.toThrow();
  });
});

describe("T03 Raindrop single-write HTTP contracts", () => {
  it("creates URL-only without unwanted default updates", async () => {
    const service = new RaindropService("fake-token");
    const post = (service as any).client.POST;
    post.mockResolvedValueOnce({ data: { result: true,
      item: { _id: 78, link: "https://example.com", title: "Example", tags: [] } } });
    const created = await service.createBookmark(undefined, { link: "https://example.com" });
    expect(created._id).toBe(78);
    expect(post).toHaveBeenCalledWith("/raindrop", {
      body: { link: "https://example.com", important: false },
    });
  });

  it("updates only explicit fields and refuses an unsuccessful result", async () => {
    const service = new RaindropService("fake-token");
    const put = (service as any).client.PUT;
    put.mockResolvedValueOnce({ data: { result: true,
      item: { _id: 78, link: "https://example.com", title: "After" } } });
    const result = await service.updateBookmark(78, { title: "After" });
    expect(result.title).toBe("After");
    expect(put).toHaveBeenCalledWith("/raindrop/{id}", {
      params: { path: { id: 78 } }, body: { title: "After" },
    });

    put.mockResolvedValueOnce({ data: { result: false, item: { _id: 78, title: "After" } } });
    await expect(service.updateBookmark(78, { title: "Not saved" })).rejects.toThrow();
  });

  it("requires a scoped, single-ID modification before confirming deletion", async () => {
    const service = new RaindropService("fake-token");
    const get = (service as any).client.GET;
    const remove = (service as any).client.DELETE;
    get.mockResolvedValue({ data: { result: true,
      item: { _id: 78, collection: { $id: 11 } } } });
    remove.mockResolvedValueOnce({ data: { result: true, modified: 1 } });
    await expect(service.deleteBookmark(78, 11)).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith("/raindrops/{collectionId}", {
      params: { path: { collectionId: 11 }, query: { nested: false } },
      body: { ids: [78] },
    });

    remove.mockResolvedValueOnce({ data: { result: true } });
    await expect(service.deleteBookmark(78, 11)).rejects.toThrow(/individually acknowledged/);
    remove.mockResolvedValueOnce({ data: { result: false, modified: 0 } });
    await expect(service.deleteBookmark(78, 11)).rejects.toThrow(/individually acknowledged/);
    get.mockResolvedValueOnce({ data: { result: true,
      item: { _id: 78, collection: { $id: -99 } } } });
    await expect(service.deleteBookmark(78, 11)).rejects.toThrow(/source changed/);
    expect(remove).toHaveBeenCalledTimes(3);
    await expect(service.deleteBookmark(78, 0)).rejects.toThrow(/source collection/);
  });
});
