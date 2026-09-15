import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/worker.js";

const workerUrl = "https://raindrop-mcp.example.test";
const originToken = "origin-secret-for-tests";
const raindropToken = "raindrop-secret-for-tests";
const originAuth = { Authorization: `Bearer ${originToken}` };

const env = (overrides: Record<string, string | undefined> = {}) => ({
  RAINDROP_ACCESS_TOKEN: raindropToken,
  MCP_ORIGIN_TOKEN: originToken,
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

describe("Cloudflare Worker origin authentication", () => {
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

  it("keeps /health public and free of secret material", async () => {
    const response = await worker.fetch(
      new Request(`${workerUrl}/health`),
      env({
        RAINDROP_ACCESS_TOKEN: undefined,
        MCP_ORIGIN_TOKEN: undefined,
      }) as never,
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"status":"healthy"');
    expect(body).not.toContain(originToken);
    expect(body).not.toContain(raindropToken);
  });

  it("fails closed when MCP_ORIGIN_TOKEN is not configured", async () => {
    const response = await worker.fetch(
      mcpRequest(),
      env({ MCP_ORIGIN_TOKEN: undefined }) as never,
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "MCP origin authentication is not configured",
    });
  });

  it("rejects a missing bearer credential before MCP handling", async () => {
    const response = await worker.fetch(mcpRequest(), env() as never);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("rejects an invalid bearer credential before checking Raindrop auth", async () => {
    const response = await worker.fetch(
      mcpRequest({ Authorization: "Bearer wrong-secret" }),
      env({ RAINDROP_ACCESS_TOKEN: undefined }) as never,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("rejects a non-bearer Authorization scheme", async () => {
    const response = await worker.fetch(
      mcpRequest({ Authorization: originToken }),
      env() as never,
    );

    expect(response.status).toBe(401);
  });

  it("fails closed when Raindrop auth is missing after origin auth succeeds", async () => {
    const response = await worker.fetch(
      mcpRequest(originAuth),
      env({ RAINDROP_ACCESS_TOKEN: undefined }) as never,
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Raindrop authentication is not configured",
    });
  });

  it("passes an authenticated MCP initialize request to the SDK", async () => {
    const response = await worker.fetch(
      mcpRequest(
        {
          ...originAuth,
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
    const body = await response.text();
    expect(body).toContain('"jsonrpc":"2.0"');
    expect(body).toContain('"serverInfo"');
  });

  it("accepts the temporary empty compatibility probe only after origin auth", async () => {
    const response = await worker.fetch(
      mcpRequest({
        ...originAuth,
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
          ...originAuth,
          "Content-Type": "application/json",
        },
        "{}",
      ),
      env() as never,
    );

    expect(response.status).not.toBe(204);
  });

  it("allows Authorization in CORS preflight", async () => {
    const response = await worker.fetch(
      new Request(`${workerUrl}/mcp`, {
        method: "OPTIONS",
        headers: { Origin: "https://client.example" },
      }),
      env() as never,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
      "Authorization",
    );
  });
});
