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
