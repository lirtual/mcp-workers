import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker.js";

const workerUrl = "https://raindrop-mcp-worker.example.test";
const portalToken = "portal-secret-for-tests";
const raindropToken = "raindrop-secret-for-tests";
const portalAuth = { Authorization: `Bearer ${portalToken}` };

const env = (overrides: Record<string, string | undefined> = {}) => ({
  RAINDROP_ACCESS_TOKEN: raindropToken,
  MCP_ACCESS_TOKEN: portalToken,
  ...overrides,
});

const mcpRequest = (
  headers: Record<string, string> = {},
  body: string | null = null,
) =>
  new Request(`${workerUrl}/mcp`, {
    method: "POST",
    headers,
    body,
  });

describe("Cloudflare Worker Portal authentication", () => {
  const originalRaindropToken = process.env.RAINDROP_ACCESS_TOKEN;

  beforeEach(() => {
    process.env.RAINDROP_ACCESS_TOKEN = raindropToken;
  });

  afterEach(() => {
    if (originalRaindropToken === undefined) {
      delete process.env.RAINDROP_ACCESS_TOKEN;
    } else {
      process.env.RAINDROP_ACCESS_TOKEN = originalRaindropToken;
    }
  });

  it("keeps /health public, minimal, and free of CORS/secret material", async () => {
    const response = await worker.fetch(
      new Request(`${workerUrl}/health`, {
        headers: { Origin: "https://browser.example" },
      }),
      env({
        RAINDROP_ACCESS_TOKEN: undefined,
        MCP_ACCESS_TOKEN: undefined,
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const body = await response.text();
    expect(body).toContain('"status":"healthy"');
    expect(body).toContain('"service":"raindrop-mcp-worker"');
    expect(body).not.toContain(portalToken);
    expect(body).not.toContain(raindropToken);
  });

  it("fails closed with 503 when MCP_ACCESS_TOKEN is not configured", async () => {
    const response = await worker.fetch(
      mcpRequest(),
      env({ MCP_ACCESS_TOKEN: undefined }) as never,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "portal_auth_not_configured",
    });
  });

  it("rejects a missing bearer credential before MCP handling", async () => {
    const response = await worker.fetch(mcpRequest(), env() as never);

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    await expect(response.json()).resolves.toMatchObject({ error: "unauthorized" });
  });

  it("rejects an invalid bearer credential before checking Raindrop auth", async () => {
    const response = await worker.fetch(
      mcpRequest({ Authorization: "Bearer wrong-secret" }),
      env({ RAINDROP_ACCESS_TOKEN: undefined }) as never,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "unauthorized" });
  });

  it("rejects a non-bearer Authorization scheme", async () => {
    const response = await worker.fetch(
      mcpRequest({ Authorization: portalToken }),
      env() as never,
    );

    expect(response.status).toBe(401);
  });

  it("rejects browser Origin and emits no CORS headers", async () => {
    const response = await worker.fetch(
      mcpRequest({
        ...portalAuth,
        Origin: "https://client.example",
      }),
      env() as never,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Headers")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_origin" });
  });

  it("does not provide a browser CORS preflight path", async () => {
    const response = await worker.fetch(
      new Request(`${workerUrl}/mcp`, {
        method: "OPTIONS",
        headers: { Origin: "https://client.example" },
      }),
      env() as never,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
  });

  it("fails closed with 503 when Raindrop auth is missing after Portal auth succeeds", async () => {
    const response = await worker.fetch(
      mcpRequest(portalAuth),
      env({ RAINDROP_ACCESS_TOKEN: undefined }) as never,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "raindrop_auth_not_configured",
    });
  });

  it("passes an authenticated MCP initialize request to the SDK", async () => {
    const response = await worker.fetch(
      mcpRequest(
        {
          ...portalAuth,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: {
              name: "worker-security-test",
              version: "1.0.0",
            },
          },
        }),
      ),
      env() as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const body = await response.text();
    expect(body).toContain('"jsonrpc":"2.0"');
    expect(body).toContain('"serverInfo"');
  });

  it("runs successful read and write tools/call via the authenticated HTTP Worker and fake upstream", async () => {
    const item = { _id: 17, link: "https://example.test/", note: "fixture" };
    const upstream = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(request.headers.get("Authorization")).toBe(`Bearer ${raindropToken}`);
      if (request.method === "GET" && url.pathname === "/rest/v1/raindrop/17") {
        return Response.json({ result: true, item });
      }
      if (request.method === "POST" && url.pathname === "/rest/v1/raindrop") {
        expect(await request.json()).toEqual({
          link: item.link, collection: { $id: -1 }, pleaseParse: {},
        });
        return Response.json({ result: true, item });
      }
      throw new Error(`Unexpected upstream route: ${request.method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", upstream);
    const decode = async (response: Response) => {
      expect(response.status).toBe(200);
      const text = await response.text();
      const json = text.trim().startsWith("{")
        ? text
        : text.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
      expect(json).toBeDefined();
      return JSON.parse(json!) as {
        result?: { isError?: boolean; structuredContent?: unknown };
      };
    };
    try {
      const cases = [
        { name: "raindrop_get", arguments: { id: 17 }, method: "GET" },
        { name: "raindrop_create", arguments: { link: item.link }, method: "POST" },
      ];
      for (const [index, entry] of cases.entries()) {
        const request = mcpRequest({
          ...portalAuth,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-03-26",
        }, JSON.stringify({
          jsonrpc: "2.0", id: index + 1, method: "tools/call",
          params: { name: entry.name, arguments: entry.arguments },
        }));
        const rpc = await decode(await worker.fetch(request, env() as never));
        expect(rpc.result?.isError).not.toBe(true);
        expect(rpc.result?.structuredContent).toMatchObject({
          ok: true, data: { item: { _id: 17 } },
          meta: entry.method === "POST" ? { status: "succeeded", requestCount: 1 } : { requestCount: 1 },
        });
      }
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(upstream.mock.calls.map(([request]) => request.method)).toEqual(["GET", "POST"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts the temporary empty compatibility probe only after Portal auth", async () => {
    const response = await worker.fetch(
      mcpRequest({
        ...portalAuth,
        "Content-Type": "application/octet-stream",
        "Content-Length": "0",
      }),
      env() as never,
    );

    expect(response.status).toBe(204);
  });

  it("does not treat normal JSON MCP traffic as a compatibility probe", async () => {
    const response = await worker.fetch(
      mcpRequest(
        {
          ...portalAuth,
          "Content-Type": "application/json",
        },
        "{}",
      ),
      env() as never,
    );

    expect(response.status).not.toBe(204);
  });
});
