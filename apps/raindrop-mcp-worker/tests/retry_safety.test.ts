import { afterEach, describe, expect, it, vi } from "vitest";
import RaindropService from "../src/services/raindrop.service.js";

describe("RaindropService retry safety", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("caps upstream HTTP requests at 60 even when callers bypass the cache", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ result: true, items: [], count: 0 }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const service = new RaindropService({ accessToken: "test-token", maxReadRetries: 0 });

    for (let index = 0; index < 60; index++) {
      await expect(service.getBookmarks({ page: 0 }, true)).resolves.toEqual({
        items: [], count: 0,
      });
    }
    await expect(service.getBookmarks({ page: 0 }, true))
      .rejects.toThrow(/upstream request budget/i);
    expect(fetchMock).toHaveBeenCalledTimes(60);
  });

  it("charges a transient read retry against the same 60-request cap", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("failure", {
        status: 500, statusText: "Internal Server Error",
      }))
      .mockImplementation(async () => new Response(
        JSON.stringify({ result: true, items: [], count: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    vi.stubGlobal("fetch", fetchMock);
    const service = new RaindropService({ accessToken: "test-token", maxReadRetries: 1 });

    const first = service.getBookmarks({ page: 0 }, true);
    await vi.runAllTimersAsync();
    await expect(first).resolves.toEqual({ items: [], count: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 2 HTTP attempts already consumed (including the first failed read).
    for (let index = 0; index < 58; index++) {
      await service.getBookmarks({ page: 0 }, true);
    }
    await expect(service.getBookmarks({ page: 0 }, true))
      .rejects.toThrow(/upstream request budget/i);
    expect(fetchMock).toHaveBeenCalledTimes(60);
  });

  it("does not retry an upstream failure after submitting a write", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("upstream failure", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const service = new RaindropService({ accessToken: "test-token", maxReadRetries: 1 });
    (service as any).rateLimiter = undefined;

    await expect(service.createCollection("one-shot")).rejects.toThrow(
      "API Error: 500 Internal Server Error",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps bounded transient retries for reads", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("upstream failure", {
          status: 500,
          statusText: "Internal Server Error",
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const service = new RaindropService({ accessToken: "test-token", maxReadRetries: 1 });
    (service as any).rateLimiter = undefined;

    const resultPromise = service.getCollections(true);
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a read before a Retry-After that exceeds its budget", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "60" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const service = new RaindropService({ accessToken: "test-token", maxReadRetries: 1 });
    (service as any).rateLimiter = undefined;

    await expect(service.getCollections(true)).rejects.toThrow(
      /exceeds remaining read retry budget/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never replays a failed single-bookmark DELETE", async () => {
    const fetchMock = vi.fn(async () => new Response("upstream failure", {
      status: 500, statusText: "Internal Server Error",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new RaindropService({ accessToken: "test-token", maxReadRetries: 3 });
    await expect(service.deleteBookmark(78)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry an upstream 429 after submitting a write", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "1" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const service = new RaindropService({ accessToken: "test-token", maxReadRetries: 1 });
    (service as any).rateLimiter = undefined;

    await expect(service.createCollection("one-shot")).rejects.toThrow(
      /Rate limited by Raindrop.io/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
