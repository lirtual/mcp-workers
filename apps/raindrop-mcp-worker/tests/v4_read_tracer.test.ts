import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";
import worker from "../src/worker.js";

const makeService = () => new RaindropMCPService({ accessToken: "offline-token", maxReadRetries: 0 });
const portalToken = "test-portal-token";
const workerEnv = {
  MCP_ACCESS_TOKEN: portalToken,
  RAINDROP_ACCESS_TOKEN: "test-raindrop-token",
};
const workerUrl = "https://raindrop-mcp-worker.example.test/mcp";

async function callWorker(id: number, method: string, params?: Record<string, unknown>) {
  const response = await worker.fetch(new Request(workerUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${portalToken}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id, method,
      ...(params ? { params } : {}),
    }),
  }), workerEnv);
  return { response, body: await response.text() };
}

afterEach(() => vi.unstubAllGlobals());

describe("T03 (#130) SDK-backed read-only vertical tracer", () => {
  it("discovers only the two new v4 tracer tools alongside the frozen 26 v3 tools", async () => {
    const service = makeService();
    const client = new Client({ name: "v4-tracer-contract", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        service.getServer().connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const tools = (await client.listTools()).tools;
      const names = tools.map((tool) => tool.name);
      expect(names).toContain("diagnostics_read");
      expect(names).toContain("raindrop_read");
      expect(names).toHaveLength(28);
      expect(new Set(names).size).toBe(28);
      expect(names).toContain("diagnostics");
      expect(names).toContain("raindrop_list");

      for (const name of ["diagnostics_read", "raindrop_read"]) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(tool?.annotations?.readOnlyHint).toBe(true);
        expect(tool?.outputSchema).toMatchObject({
          type: "object",
          properties: { ok: { type: "boolean" }, meta: { type: "object" } },
        });
        expect(tool?.inputSchema).toMatchObject({
          type: "object",
          additionalProperties: false,
          required: ["action"],
        });
      }
    } finally {
      await client.close();
      await service.cleanup();
    }
  });

  it("local diagnostics makes zero upstream calls, and SDK validation rejects unknown actions and fields", async () => {
    const upstream = vi.fn(() => { throw Error("Unexpected upstream network request"); });
    vi.stubGlobal("fetch", upstream);
    const service = makeService();
    const client = new Client({ name: "v4-diagnostics", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([service.getServer().connect(serverTransport), client.connect(clientTransport)]);
      const good = await client.callTool({ name: "diagnostics_read", arguments: { action: "local" } });
      expect(good.structuredContent).toMatchObject({
        ok: true, data: { runtime: "cloudflare-workers", protocolVersion: null },
        meta: { requestCount: 0 },
      });
      for (const [name, args] of [
        ["diagnostics_read", { action: "upstream" }],
        ["diagnostics_read", { action: "local", includeUpstream: true }],
        ["raindrop_read", { action: "get", id: 17 }],
        ["raindrop_read", { action: "list", perpage: 51 }],
        ["raindrop_read", { action: "list", unexpected: true }],
        ["raindrop_read", { action: "list", sort: "score" }],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, name).toBe(true);
      }
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await service.cleanup();
    }
  });

  it("list uses exactly the frozen v3 domain service, field projection and pagination envelope", async () => {
    const upstream = vi.fn((request: Request) => {
      const url = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(url.pathname).toBe("/rest/v1/raindrops/0");
      expect(url.searchParams.get("page")).toBe("0");
      expect(url.searchParams.get("perpage")).toBe("1");
      expect(url.searchParams.get("sort")).toBe("-created");
      return Response.json({
        result: true,
        items: [{ _id: 17, link: "https://example.test", title: "Example", note: "do-not-expose" }],
        count: 2,
      });
    });
    vi.stubGlobal("fetch", upstream);
    const service = makeService();
    const client = new Client({ name: "v4-list", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([service.getServer().connect(serverTransport), client.connect(clientTransport)]);
      const v4 = await client.callTool({ name: "raindrop_read", arguments: { action: "list", perpage: 1 } });
      expect(v4.structuredContent).toMatchObject({
        ok: true,
        data: { items: [{ _id: 17, link: "https://example.test", title: "Example" }] },
        meta: { page: 0, perpage: 1, returned: 1, total: 2, hasMore: true, nextPage: 1, requestCount: 1 },
      });
      expect(v4.structuredContent).not.toHaveProperty("data.items.0.note");
      expect(upstream).toHaveBeenCalledTimes(1);
      const v3 = await makeService().callTool("raindrop_list", { perpage: 1 });
      expect(v4.structuredContent).toEqual(v3.structuredContent);
      expect(upstream).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
      await service.cleanup();
    }
  });

  it("uses authenticated bounded worker.fetch for initialize, tools, resources and prompts", async () => {
    const upstream = vi.fn(() => { throw Error("No upstream expected for fixture"); });
    vi.stubGlobal("fetch", upstream);
    const init = await callWorker(1, "initialize", {
      protocolVersion: "2025-11-25", capabilities: {},
      clientInfo: { name: "v4-http-test", version: "1" },
    });
    expect(init.response.status).toBe(200);
    expect(init.body).toContain('"serverInfo"');

    const tools = await callWorker(2, "tools/list");
    expect(tools.response.status).toBe(200);
    expect(tools.body).toContain('"diagnostics_read"');
    expect(tools.body).toContain('"raindrop_read"');
    expect(tools.body).toContain('"raindrop_list"');

    const local = await callWorker(3, "tools/call", { name: "diagnostics_read", arguments: { action: "local" } });
    expect(local.response.status).toBe(200);
    expect(local.body).toContain('"requestCount":0');

    const resources = await callWorker(4, "resources/list");
    expect(resources.response.status).toBe(200);
    expect(resources.body).toContain("diagnostics://server");
    const resource = await callWorker(5, "resources/read", { uri: "diagnostics://server" });
    expect(resource.response.status).toBe(200);
    expect(resource.body).toContain("Server diagnostics");

    const prompts = await callWorker(6, "prompts/list");
    expect(prompts.response.status).toBe(200);
    expect(prompts.body).toContain("export_markdown");
    const prompt = await callWorker(7, "prompts/get", { name: "export_markdown" });
    expect(prompt.response.status).toBe(200);
    expect(prompt.body).toContain("Format bookmarks");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("executes one v4 bookmark page over authenticated worker.fetch and rejects invalid action before upstream", async () => {
    const upstream = vi.fn((request: Request) => {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe("/rest/v1/raindrops/0");
      return Response.json({
        result: true,
        items: [{ _id: 17, title: "Read-only tracer", link: "https://example.test" }],
        count: 1,
      });
    });
    vi.stubGlobal("fetch", upstream);
    const valid = await callWorker(8, "tools/call", {
      name: "raindrop_read", arguments: { action: "list", perpage: 1 },
    });
    expect(valid.response.status).toBe(200);
    expect(valid.body).toContain('"requestCount":1');
    expect(valid.body).toContain("Read-only tracer");
    expect(upstream).toHaveBeenCalledTimes(1);

    const invalid = await callWorker(9, "tools/call", {
      name: "raindrop_read", arguments: { action: "delete", id: 17 },
    });
    expect(invalid.response.status).toBe(200);
    expect(invalid.body).toContain("Input validation error");
    expect(invalid.body).toContain('"isError":true');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("preserves the v3 upstream error envelope and never retries a failed read beyond its budget", async () => {
    const upstream = vi.fn((request: Request) => {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe("/rest/v1/raindrops/0");
      return new Response("unauthorized", { status: 401 });
    });
    vi.stubGlobal("fetch", upstream);
    const service = makeService();
    const v4 = await service.callTool("raindrop_read", { action: "list", perpage: 1 });
    const v3 = await makeService().callTool("raindrop_list", { perpage: 1 });
    expect(v4.structuredContent).toEqual(v3.structuredContent);
    expect(v4.isError).toBe(true);
    expect(v4.structuredContent).toMatchObject({
      ok: false,
      meta: { requestCount: 1, status: "not_executed" },
    });
    expect(upstream).toHaveBeenCalledTimes(2);
    await service.cleanup();
  });

  it("propagates an in-flight HTTP disconnect to the upstream fetch and never returns a successful read", async () => {
    const controller = new AbortController();
    let upstreamSawAbort = false;
    const upstream = vi.fn((request: Request) => new Promise<Response>((_resolve, reject) => {
      expect(request.method).toBe("GET");
      expect(request.signal.aborted).toBe(false);
      const onAbort = () => {
        upstreamSawAbort = true;
        reject(new DOMException("Synthetic upstream aborted", "AbortError"));
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      // Disconnect after the upstream request actually starts, not before ingress.
      controller.abort();
      if (request.signal.aborted && !upstreamSawAbort) onAbort();
    }));
    vi.stubGlobal("fetch", upstream);
    const request = new Request(workerUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${portalToken}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 12, method: "tools/call",
        params: { name: "raindrop_read", arguments: { action: "list", perpage: 1 } },
      }),
      signal: controller.signal,
    });
    // Stateless MCP may either return an error envelope or terminate on disconnect.
    const outcome = await worker.fetch(request, {
      ...workerEnv, RAINDROP_RATE_LIMIT_MAX_RETRIES: "0",
    }).then(async (response) => ({ status: response.status, body: await response.text() }));
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstreamSawAbort).toBe(true);
    expect(outcome.body).not.toContain('"ok":true');
    // A disconnected stateless transport may terminate with a 200/empty body.
    // Only an actual MCP payload must carry the structured error envelope.
    if (outcome.status === 200 && outcome.body.length > 0) {
      expect(outcome.body).toContain('"isError":true');
    }
  });

  it("keeps Portal auth and 128 KiB ingress limits before SDK tool execution", async () => {
    const noAuth = await worker.fetch(new Request(workerUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }), workerEnv);
    expect(noAuth.status).toBe(401);
    const oversized = await worker.fetch(new Request(workerUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${portalToken}`, "Content-Type": "application/json" },
      body: "x".repeat(131073),
    }), workerEnv);
    expect(oversized.status).toBe(413);
  });

  it("cancellation is request-local and never submits a v4 read after abort", async () => {
    const upstream = vi.fn(() => Response.json({ result: true, items: [] }));
    vi.stubGlobal("fetch", upstream);
    const controller = new AbortController();
    const cancelled = new RaindropMCPService({
      accessToken: "cancelled", maxReadRetries: 0, signal: controller.signal,
    });
    const other = makeService();
    controller.abort();
    const first = await cancelled.callTool("raindrop_read", { action: "list", perpage: 1 });
    expect(first.structuredContent).toMatchObject({ ok: false, meta: { requestCount: 0 } });
    const second = await other.callTool("raindrop_read", { action: "list", perpage: 1 });
    expect(second.structuredContent).toMatchObject({ ok: true, meta: { requestCount: 1 } });
    expect(upstream).toHaveBeenCalledTimes(1);
    await cancelled.cleanup();
    await other.cleanup();
  });
});
