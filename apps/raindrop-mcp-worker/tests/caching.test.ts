import { describe, expect, it, vi, beforeEach } from "vitest";
import RaindropService from "../src/services/raindrop.service.js";

// Mock openapi-fetch
vi.mock("openapi-fetch", () => ({
  default: vi.fn(() => ({
    GET: vi.fn().mockResolvedValue({
      data: { result: true, items: [{ _id: 1, title: "Test" }], count: 1 },
    }),
    POST: vi.fn(),
    PUT: vi.fn(),
    DELETE: vi.fn(),
    use: vi.fn(),
  })),
}));

describe("RaindropService Caching Logic", () => {
  let service: RaindropService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new RaindropService("fake-token");
  });

  it("getCollections should use cache and only call API once", async () => {
    const mockGet = (service as any).client.GET;

    // First call - should call API
    const cols1 = await service.getCollections();
    expect(cols1).toHaveLength(1);
    expect(mockGet).toHaveBeenCalledTimes(1);

    // Second call - should return cached value and NOT call API
    const cols2 = await service.getCollections();
    expect(cols2).toHaveLength(1);
    expect(cols2).toEqual(cols1);
    expect(mockGet).toHaveBeenCalledTimes(1); // Still 1
  });

  it("getCollections accepts a verified empty root list", async () => {
    const mockGet = (service as any).client.GET;
    mockGet.mockResolvedValueOnce({ data: { result: true, items: [] } });

    await expect(service.getCollections(true)).resolves.toEqual([]);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["upstream HTTP error", { error: { message: "rejected" }, data: undefined }],
    ["missing response", { data: undefined }],
    ["upstream result false", { data: { result: false, items: [] } }],
    ["missing result", { data: { items: [] } }],
    ["missing items", { data: { result: true } }],
    ["non-array items", { data: { result: true, items: {} } }],
  ])("getCollections rejects %s rather than claiming an empty account", async (_label, response) => {
    const mockGet = (service as any).client.GET;
    mockGet.mockResolvedValueOnce(response);

    await expect(service.getCollections(true))
      .rejects.toThrow("root collection list response could not be verified");
  });

  it("does not cache an invalid collection list as empty", async () => {
    const mockGet = (service as any).client.GET;
    mockGet.mockResolvedValueOnce({ data: { result: false, items: [] } });
    mockGet.mockResolvedValueOnce({ data: { result: true, items: [{ _id: 1, title: "Valid" }] } });

    await expect(service.getCollections()).rejects.toThrow(
      "root collection list response could not be verified",
    );
    await expect(service.getCollections()).resolves.toEqual([{ _id: 1, title: "Valid" }]);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("getBookmark should use cache and only call API once", async () => {
    const mockGet = (service as any).client.GET;
    mockGet.mockResolvedValue({
      data: { item: { _id: 123, title: "Bookmark" } },
    });

    // First call
    const b1 = await service.getBookmark(123);
    expect(b1._id).toBe(123);
    expect(mockGet).toHaveBeenCalledTimes(1);

    // Second call
    const b2 = await service.getBookmark(123);
    expect(b2).toEqual(b1);
    expect(mockGet).toHaveBeenCalledTimes(1); // Still 1
  });

  it("getBookmarks should use cache and only call API once for same query", async () => {
    const mockGet = (service as any).client.GET;
    mockGet.mockResolvedValue({ data: { result: true, items: [], count: 0 } });

    const params = { search: "test", collection: 123 };

    // First call
    await service.getBookmarks(params);
    expect(mockGet).toHaveBeenCalledTimes(1);

    // Second call with same params
    await service.getBookmarks(params);
    expect(mockGet).toHaveBeenCalledTimes(1); // Still 1

    // Third call with different params
    await service.getBookmarks({ ...params, search: "other" });
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("modifying collections should clear collection cache", async () => {
    const mockGet = (service as any).client.GET;
    const mockPost = (service as any).client.POST;
    mockPost.mockResolvedValue({ data: { result: true, item: { _id: 1, title: "New" } } });

    await service.getCollections();
    expect(mockGet).toHaveBeenCalledTimes(1);

    // Create a collection
    await service.createCollection("New");

    // Should call API again after cache cleared
    await service.getCollections();
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("modifying a bookmark should clear bookmark and search cache", async () => {
    const mockGet = (service as any).client.GET;
    const mockPut = (service as any).client.PUT;

    mockGet.mockResolvedValue({
      data: { result: true, item: { _id: 123, title: "Initial" }, items: [], count: 0 },
    });
    mockPut.mockResolvedValue({
      data: { result: true, item: { _id: 123, title: "Updated" } },
    });

    await service.getBookmark(123);
    await service.getBookmarks({ search: "test" });
    expect(mockGet).toHaveBeenCalledTimes(2);

    // Update bookmark
    await service.updateBookmark(123, { title: "Updated" });

    // Should call API again
    await service.getBookmark(123);
    expect(mockGet).toHaveBeenCalledTimes(3);

    await service.getBookmarks({ search: "test" });
    expect(mockGet).toHaveBeenCalledTimes(4);
  });

  it("should bypass cache when skipCache is true", async () => {
    const mockGet = (service as any).client.GET;
    mockGet.mockResolvedValue({ data: { result: true, items: [], count: 0 } });

    // First call - populates cache
    await service.getCollections();
    expect(mockGet).toHaveBeenCalledTimes(1);

    // Second call with skipCache: true - should bypass cache and call API
    await service.getCollections(true);
    expect(mockGet).toHaveBeenCalledTimes(2);

    // Same for bookmarks
    mockGet.mockResolvedValue({ data: { item: { _id: 123 } } });
    await service.getBookmark(123);
    expect(mockGet).toHaveBeenCalledTimes(3);

    await service.getBookmark(123, true);
    expect(mockGet).toHaveBeenCalledTimes(4);
  });
});
