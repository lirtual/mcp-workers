import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/worker.js";

const workerUrl = "https://raindrop-mcp.example.test";
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
