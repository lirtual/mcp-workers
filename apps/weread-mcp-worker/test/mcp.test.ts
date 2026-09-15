import { describe, expect, it } from "vitest";
import { authenticateOrigin } from "../src/origin-auth.js";
import { createServer } from "../src/server.js";

describe("MCP server construction", () => {
  it("constructs the stateless server with a configured API key", () => {
    expect(createServer({ WEREAD_API_KEY: "wrk-test" })).toBeDefined();
  });
});

describe("Portal origin authentication", () => {
  it("fails closed when the origin token is not configured", () => {
    expect(authenticateOrigin(new Request("https://weread.example/mcp"), undefined)).toEqual({
      ok: false,
      reason: "misconfigured",
    });
  });

  it("rejects an invalid bearer credential", () => {
    const request = new Request("https://weread.example/mcp", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(authenticateOrigin(request, "expected")).toEqual({
      ok: false,
      reason: "unauthorized",
    });
  });

  it("accepts the origin bearer and removes it before MCP handling", () => {
    const request = new Request("https://weread.example/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer origin-secret",
        "MCP-Protocol-Version": "2025-11-25",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    const result = authenticateOrigin(request, "origin-secret");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.request.headers.has("authorization")).toBe(false);
    expect(result.request.headers.get("mcp-protocol-version")).toBe("2025-11-25");
  });
});
