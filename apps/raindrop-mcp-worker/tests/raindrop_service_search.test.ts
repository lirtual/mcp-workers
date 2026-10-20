import { describe, expect, it, vi, beforeEach } from "vitest";
import RaindropService from "../src/services/raindrop.service.js";

// Mock openapi-fetch
vi.mock("openapi-fetch", () => ({
  default: vi.fn(() => ({
    GET: vi.fn().mockResolvedValue({ data: { items: [], count: 0 } }),
    POST: vi.fn().mockResolvedValue({ data: { result: false, ids: [] } }),
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
