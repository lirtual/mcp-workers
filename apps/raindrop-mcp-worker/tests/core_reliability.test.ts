import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionBudget, EXECUTION_LIMITS } from "../src/services/execution-budget.js";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";
import worker from "../src/worker.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Raindrop request budget", () => {
  it("counts each GET retry and never retries a submitted write", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("failure", { status: 500, statusText: "Internal Server Error" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = new RaindropMCPService({
      accessToken: "fake",
      maxReadRetries: 0,
    });
    const result = await service.callTool("collection_manage", {
      operation: "create",
      title: "disposable-fixture",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: "WRITE_OUTCOME_UNKNOWN", upstreamStatus: 500 },
        meta: { status: "unknown", requestCount: 1 },
      },
    });
  });

  it("refuses upstream redirects instead of following token-bearing requests", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "https://example.org/" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = new RaindropMCPService({ accessToken: "fake", maxReadRetries: 0 });
    const result = await service.callTool("collection_list", {});
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { ok: false },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBeInstanceOf(Request);
    expect(((fetchMock.mock.calls[0] as unknown[])[0] as Request).redirect).toBe("manual");
  });

  it("limits the response stream even without Content-Length", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array(EXECUTION_LIMITS.responseBytes + 1).buffer, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const budget = new ExecutionBudget();
    await expect(
      budget.fetch(new Request("https://api.raindrop.io/rest/v1/collections")),
    ).rejects.toThrow(/byte limit/);
    expect(budget.requestCount).toBe(1);
  });

  it("rejects oversized authenticated MCP ingress by actual streamed bytes", async () => {
    const request = new Request("https://raindrop.example/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer portal-test",
        "Content-Type": "application/json",
      },
      body: "x".repeat(EXECUTION_LIMITS.requestBytes + 1),
    });
    const response = await worker.fetch(request, {
      MCP_ACCESS_TOKEN: "portal-test",
      RAINDROP_ACCESS_TOKEN: "upstream-test",
    } as never);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: "REQUEST_TOO_LARGE",
    });
  });
});

describe("submitted-write uncertainty regressions", () => {
  const runWrite = async (upstream: (request: Request) => Promise<Response>) => {
    const fetchMock = vi.fn(upstream);
    vi.stubGlobal("fetch", fetchMock);
    const service = new RaindropMCPService({
      accessToken: "fake-token",
      maxReadRetries: 3,
    });
    const result = await service.callTool("collection_manage", {
      operation: "create",
      title: "isolated-test-only",
    });
    return { fetchMock, result };
  };

  it.each([
    ["429 with Retry-After", 429, "60"],
    ["503 after submission", 503, undefined],
  ])("does not replay a write after %s", async (_case, status, retryAfter) => {
    const { fetchMock, result } = await runWrite(async () =>
      new Response("upstream failure", {
        status,
        headers: retryAfter ? { "retry-after": retryAfter } : {},
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: "WRITE_OUTCOME_UNKNOWN", upstreamStatus: status },
        meta: { status: "unknown", requestCount: 1 },
      },
    });
    if (status === 429) {
      expect(result.structuredContent.error.retryAfterMs).toBe(60_000);
    }
  });

  it("does not replay a write after a transport disconnect", async () => {
    const { fetchMock, result } = await runWrite(async () => {
      throw new TypeError("mock network disconnect");
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "WRITE_OUTCOME_UNKNOWN" },
        meta: { status: "unknown", requestCount: 1 },
      },
    });
  });

  it("does not replay a write after an unparseable successful HTTP response", async () => {
    const { fetchMock, result } = await runWrite(async () =>
      new Response("{broken-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "WRITE_OUTCOME_UNKNOWN" },
        meta: { status: "unknown", requestCount: 1 },
      },
    });
  });

  it("aborts a stalled upstream write once instead of replaying it", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (request: Request): Promise<Response> =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = new RaindropMCPService({
      accessToken: "fake-token",
      maxReadRetries: 3,
    });
    const pending = service.callTool("collection_manage", {
      operation: "create",
      title: "isolated-test-only",
    });
    await vi.advanceTimersByTimeAsync(EXECUTION_LIMITS.fetchMs + 1);
    const result = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "WRITE_OUTCOME_UNKNOWN" },
        meta: { status: "unknown", requestCount: 1 },
      },
    });
  });
});

describe("streaming request safety", () => {
  it("rejects an oversized write body before submission", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const budget = new ExecutionBudget();
    const request = new Request("https://api.raindrop.io/rest/v1/collection", {
      method: "POST",
      body: "x".repeat(EXECUTION_LIMITS.requestBytes + 1),
    });
    await expect(budget.fetch(request)).rejects.toThrow(/byte limit/);
    expect(budget.requestCount).toBe(0);
    expect(budget.writeAttemptCount).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops reading an over-limit streamed upstream response without Content-Length", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi.fn(async () => new Response(stream, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const budget = new ExecutionBudget();
    await expect(
      budget.fetch(new Request("https://api.raindrop.io/rest/v1/collections")),
    ).rejects.toThrow(/byte limit/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(budget.requestCount).toBe(1);
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });
});

describe("request budget concurrency", () => {
  it.each([
    ["GET", 3],
    ["POST", 1],
  ])("never exceeds the %s concurrency limit when new work races queued work", async (method, limit) => {
    const budget = new ExecutionBudget();
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const fetchMock = vi.fn(
      async (): Promise<Response> =>
        new Promise((resolve) => {
          active++;
          maximum = Math.max(maximum, active);
          releases.push(() => {
            active--;
            resolve(Response.json({ result: true }));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const submit = () =>
      budget.fetch(new Request("https://api.raindrop.io/rest/v1/collection", { method }));
    const initial = Array.from({ length: limit + 1 }, submit);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(limit));
    releases.shift()?.();
    const late = submit();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(limit + 1));
    expect(maximum).toBeLessThanOrEqual(limit);
    for (let remaining = 0; remaining < limit + 1; remaining++) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
      releases.shift()?.();
    }
    await Promise.all([...initial, late]);
    expect(maximum).toBeLessThanOrEqual(limit);
  });
});
