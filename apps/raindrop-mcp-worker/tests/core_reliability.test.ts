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
    const result = await service.callTool("collection_create", {
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

  it("times out a stalled authenticated MCP ingress before reaching the SDK or upstream", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    });
    const request = new Request("https://raindrop.example/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer portal-test",
        "Content-Type": "application/json",
      },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pending = worker.fetch(request, {
      MCP_ACCESS_TOKEN: "portal-test",
      RAINDROP_ACCESS_TOKEN: "upstream-test",
    } as never);
    const assertion = expect(pending).resolves.toMatchObject({ status: 408 });
    // Portal authentication is asynchronous and may need more than one tick.
    // Wait until the ingress deadline timer is ACTUALLY registered before
    // advancing the fake clock; advancing early can leave the request stuck.
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await vi.waitFor(
        () => expect(timeoutSpy).toHaveBeenCalledWith(
          expect.any(Function),
          EXECUTION_LIMITS.fetchMs,
        ),
        { interval: 1, timeout: 1_000 },
      );
      await vi.advanceTimersByTimeAsync(EXECUTION_LIMITS.fetchMs + 1);
    } finally {
      timeoutSpy.mockRestore();
    }
    await assertion;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts authenticated ingress when the calling client disconnects", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    });
    const controller = new AbortController();
    const request = new Request("https://raindrop.example/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer portal-test",
        "Content-Type": "application/json",
      },
      body: stream,
      signal: controller.signal,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pending = worker.fetch(request, {
      MCP_ACCESS_TOKEN: "portal-test",
      RAINDROP_ACCESS_TOKEN: "upstream-test",
    } as never);
    const assertion = expect(pending).resolves.toMatchObject({ status: 408 });
    controller.abort();
    await assertion;
    expect(fetchMock).not.toHaveBeenCalled();
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
    const result = await service.callTool("collection_create", {
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
    const pending = service.callTool("collection_create", {
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
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
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
  });
});

describe("bounded request-body preflight", () => {
  const stalledBody = () => new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => undefined),
  });

  it("aborts a stalled preflight on its deadline without submitting or counting a write", async () => {
    vi.useFakeTimers();
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const budget = new ExecutionBudget();
    const request = new Request("https://api.raindrop.io/rest/v1/collection", {
      method: "POST",
      body: stalledBody(),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pending = budget.fetch(request);
    const assertion = expect(pending).rejects.toMatchObject({
      cause: { submitted: false },
    });
    await vi.advanceTimersByTimeAsync(EXECUTION_LIMITS.fetchMs + 1);
    await assertion;
    expect(upstream).not.toHaveBeenCalled();
    expect(budget.requestCount).toBe(0);
    expect(budget.writeAttemptCount).toBe(0);
  });

  it("respects external preflight abort before a single upstream submission", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const controller = new AbortController();
    const budget = new ExecutionBudget();
    const request = new Request("https://api.raindrop.io/rest/v1/collection", {
      method: "POST",
      body: stalledBody(),
      signal: controller.signal,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pending = budget.fetch(request);
    const assertion = expect(pending).rejects.toMatchObject({
      cause: { submitted: false },
    });
    controller.abort();
    await assertion;
    expect(upstream).not.toHaveBeenCalled();
    expect(budget.requestCount).toBe(0);
    expect(budget.writeAttemptCount).toBe(0);
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

describe("bounded concurrency wait", () => {
  it("abandons a queued read at the wall deadline without submitting it", async () => {
    vi.useFakeTimers();
    const releases: Array<(response: Response) => void> = [];
    const upstream = vi.fn(async (): Promise<Response> =>
      new Promise((resolve) => releases.push(resolve)),
    );
    vi.stubGlobal("fetch", upstream);
    const budget = new ExecutionBudget();
    const request = () => new Request("https://api.raindrop.io/rest/v1/collections");

    // Fill all read slots with requests whose mocked network never settles.
    const active = Array.from({ length: EXECUTION_LIMITS.concurrentReads },
      () => budget.fetch(request()));
    await vi.advanceTimersByTimeAsync(0);
    expect(upstream).toHaveBeenCalledTimes(EXECUTION_LIMITS.concurrentReads);

    const queued = budget.fetch(request());
    const failed = expect(queued).rejects.toMatchObject({
      cause: { submitted: false, budget: true },
    });
    await vi.advanceTimersByTimeAsync(EXECUTION_LIMITS.wallMs + 1);
    await failed;
    expect(upstream).toHaveBeenCalledTimes(EXECUTION_LIMITS.concurrentReads);

    // Release our fixtures after the deadline so their promises cannot keep
    // an artificially occupied slot or a live timer in the test environment.
    for (const release of releases) release(Response.json({ result: true }));
    await Promise.allSettled(active);
    expect(budget.requestCount).toBe(EXECUTION_LIMITS.concurrentReads);
  });
});

describe("bounded response and definite write errors", () => {
  it("times out when an upstream response body stalls after HTTP headers", async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([123]));
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));
    const budget = new ExecutionBudget();
    const pending = budget.fetch(new Request("https://api.raindrop.io/rest/v1/collections"));
    const assertion = expect(pending).rejects.toThrow(/timed out|aborted/i);
    await vi.advanceTimersByTimeAsync(EXECUTION_LIMITS.fetchMs + 1);
    await assertion;
    expect(budget.requestCount).toBe(1);
  });

  it.each([401, 403, 404])("reports a submitted write with definitive HTTP %i as failed", async (status) => {
    const fetchMock = vi.fn(async () => new Response(null, { status }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new RaindropMCPService({ accessToken: "fake", maxReadRetries: 0 });
    const result = await service.callTool("collection_create", {
      title: "isolated-test-only",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      meta: { status: "failed", requestCount: 1 },
    });
  });
});
