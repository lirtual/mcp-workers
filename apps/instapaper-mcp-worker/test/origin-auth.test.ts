import { describe, expect, it } from "vitest";
import { authenticateOrigin } from "../src/auth/origin-auth.js";

describe("authenticateOrigin", () => {
  it("fails closed when the origin token is not configured", () => {
    const request = new Request("https://example.com/mcp");
    expect(authenticateOrigin(request, undefined)).toEqual({
      ok: false,
      reason: "misconfigured",
    });
  });

  it("rejects a missing or incorrect bearer credential", () => {
    const missing = new Request("https://example.com/mcp");
    expect(authenticateOrigin(missing, "expected")).toEqual({
      ok: false,
      reason: "unauthorized",
    });

    const wrong = new Request("https://example.com/mcp", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(authenticateOrigin(wrong, "expected")).toEqual({
      ok: false,
      reason: "unauthorized",
    });
  });

  it("accepts the Portal credential and strips Authorization before MCP handling", () => {
    const request = new Request("https://example.com/mcp", {
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
    expect(result.request.headers.get("content-type")).toContain("application/json");
  });
});
