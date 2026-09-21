import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

const RAINDROP_HOST = "https://api.raindrop.io/rest/v1";

async function connect(fetchImpl: typeof fetch, maxReadRetries = 1) {
  const service = new RaindropMCPService({
    accessToken: "raindrop-test-token",
    maxReadRetries,
    fetchImpl,
    maxResponseBytes: 64,
    maxRequestBytes: 128,
  });
  const client = new Client({ name: "bounded-execution-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    service.getServer().connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { service, client };
}

describe("Raindrop bounded MCP execution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects unknown tool input before any upstream fetch", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const { client, service } = await connect(fetchImpl as typeof fetch);
    try {
      const result = await client.callTool({
        name: "diagnostics",
        arguments: { includeUpstream: true, unexpected: true },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/Unrecognized key|unexpected/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await service.cleanup();
    }
  });

  it("returns default diagnostics with zero upstream calls and no negotiated protocol claim", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const { client, service } = await connect(fetchImpl as typeof fetch);
    try {
      const result = await client.callTool({ name: "diagnostics", arguments: {} });
      expect(fetchImpl).not.toHaveBeenCalled();
      const structured = (result as { structuredContent: Record<string, unknown> })
        .structuredContent;
      expect(structured.libraryHealth).toBeNull();
      expect(structured).not.toHaveProperty("mcpProtocolVersion");
      expect(structured.protocolTarget).toBe("2026-07-28");
      expect(JSON.stringify(result)).not.toContain("raindrop-test-token");
    } finally {
      await client.close();
      await service.cleanup();
    }
  });

  it("counts GET retries against the shared attempt budget and returns promptly on long Retry-After", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("fail", { status: 500, statusText: "Internal Server Error" }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const { client, service } = await connect(fetchImpl as typeof fetch, 1);
    try {
      const result = await client.callTool({
        name: "collection_list",
        arguments: { skipCache: true },
      });
      expect((result as { isError?: boolean }).isError).not.toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
      await service.cleanup();
    }

    const limited = vi.fn(async () =>
      new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "60" },
      }),
    );
    const second = await connect(limited as typeof fetch, 1);
    try {
      const started = Date.now();
      const result = await second.client.callTool({
        name: "collection_list",
        arguments: { skipCache: true },
      });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(limited).toHaveBeenCalledTimes(1);
      const structured = (result as { structuredContent: { meta?: { retryAfterMs?: number } } })
        .structuredContent;
      expect(result.isError).toBe(true);
      expect(structured.meta?.retryAfterMs).toBeGreaterThan(50_000);
    } finally {
      await second.client.close();
      await second.service.cleanup();
    }
  });

  it("attempts a write once and returns unknown on 429, 5xx, timeout, disconnect, and unparseable bodies", async () => {
    const cases: Array<{ name: string; impl: typeof fetch }> = [
      {
        name: "500",
        impl: vi.fn(async () => new Response("fail", { status: 500 })) as unknown as typeof fetch,
      },
      {
        name: "429",
        impl: vi.fn(
          async () => new Response("limited", { status: 429, headers: { "retry-after": "1" } }),
        ) as unknown as typeof fetch,
      },
      {
        name: "timeout",
        impl: vi.fn(async () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }) as unknown as typeof fetch,
      },
      {
        name: "disconnect",
        impl: vi.fn(async () => {
          throw new TypeError("network down");
        }) as unknown as typeof fetch,
      },
      {
        name: "unparseable",
        impl: vi.fn(
          async () =>
            new Response("{not-json", {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        ) as unknown as typeof fetch,
      },
    ];

    for (const testCase of cases) {
      const { client, service } = await connect(testCase.impl, 3);
      try {
        const result = await client.callTool({
          name: "collection_manage",
          arguments: { operation: "create", title: "once" },
        });
        expect(result.isError, testCase.name).toBe(true);
        const structured = result.structuredContent as {
          error?: { state?: string };
        };
        expect(structured.error?.state, testCase.name).toBe("unknown");
        expect(testCase.impl, testCase.name).toHaveBeenCalledTimes(1);
      } finally {
        await client.close();
        await service.cleanup();
      }
    }
  });

  it("enforces response size without trusting Content-Length", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("x".repeat(200), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": "1",
        },
      }),
    );
    const { client, service } = await connect(fetchImpl as typeof fetch);
    try {
      const result = await client.callTool({
        name: "collection_list",
        arguments: { skipCache: true },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/size budget|exceeded/i);
    } finally {
      await client.close();
      await service.cleanup();
    }
  });

  it("does not forward credentials on a cross-host redirect", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = request.url;
      if (url.startsWith(RAINDROP_HOST)) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/steal" },
        });
      }
      expect(request.headers.get("authorization")).toBeNull();
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const { client, service } = await connect(fetchImpl as typeof fetch);
    try {
      await client.callTool({
        name: "collection_list",
        arguments: { skipCache: true },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
      await service.cleanup();
    }
  });
});
