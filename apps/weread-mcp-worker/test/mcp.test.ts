import { authenticatePortalRequest } from "@mcp-workers/portal-auth";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index.js";
import { createServer } from "../src/server.js";

const ctx = {} as ExecutionContext;

describe("MCP server construction", () => {
  it("constructs the stateless server with a configured API key", () => {
    expect(createServer({ WEREAD_API_KEY: "wrk-test" })).toBeDefined();
  });
});

describe("Portal authentication", () => {
  it("fails closed when the Portal access token is not configured", async () => {
    const response = await handleRequest(
      new Request("https://weread.example/mcp"),
      { WEREAD_API_KEY: "wrk-test", MCP_ACCESS_TOKEN: "" },
      ctx,
    );
    expect(response.status).toBe(503);
  });

  it("rejects an invalid bearer credential", async () => {
    const response = await handleRequest(
      new Request("https://weread.example/mcp", {
        headers: { Authorization: "Bearer wrong" },
      }),
      { WEREAD_API_KEY: "wrk-test", MCP_ACCESS_TOKEN: "expected" },
      ctx,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("rejects browser Origin by default while allowing Origin-less server requests", async () => {
    const rejected = await handleRequest(
      new Request("https://weread.example/mcp", {
        headers: {
          Authorization: "Bearer expected",
          Origin: "https://browser.example",
        },
      }),
      { WEREAD_API_KEY: "wrk-test", MCP_ACCESS_TOKEN: "expected" },
      ctx,
    );
    expect(rejected.status).toBe(403);

    const accepted = await authenticatePortalRequest(
      new Request("https://weread.example/mcp", {
        headers: { Authorization: "Bearer expected" },
      }),
      { expectedToken: "expected", allowedOrigins: [] },
    );
    expect(accepted.ok).toBe(true);
  });

  it("removes the Portal bearer before MCP handling and preserves MCP metadata", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const result = await authenticatePortalRequest(
      new Request("https://weread.example/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer portal-secret",
          "MCP-Protocol-Version": "2025-11-25",
          "Content-Type": "application/json",
        },
        body,
      }),
      { expectedToken: "portal-secret" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.request.headers.has("authorization")).toBe(false);
    expect(result.request.headers.get("mcp-protocol-version")).toBe("2025-11-25");
    expect(await result.request.text()).toBe(body);
  });
});
