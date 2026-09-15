import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RaindropService from "../src/services/raindrop.service.js";

describe("RaindropService retry safety", () => {
  beforeEach(() => {
    process.env.RAINDROP_RATE_LIMIT_MAX_RETRIES = "1";
    process.env.RAINDROP_RATE_LIMIT_POINTS = "1000";
    process.env.RAINDROP_RATE_LIMIT_DURATION_SECONDS = "1";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.RAINDROP_RATE_LIMIT_MAX_RETRIES;
    delete process.env.RAINDROP_RATE_LIMIT_POINTS;
    delete process.env.RAINDROP_RATE_LIMIT_DURATION_SECONDS;
  });

  it("does not retry an upstream failure after submitting a write", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("upstream failure", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const service = new RaindropService("test-token");
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

    const service = new RaindropService("test-token");
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

    const service = new RaindropService("test-token");
    (service as any).rateLimiter = undefined;

    await expect(service.getCollections(true)).rejects.toThrow(
      /exceeds remaining read retry budget/,
    );
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

    const service = new RaindropService("test-token");
    (service as any).rateLimiter = undefined;

    await expect(service.createCollection("one-shot")).rejects.toThrow(
      /Rate limited by Raindrop.io/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
