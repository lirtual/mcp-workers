import { describe, expect, it } from "vitest";
import { verifyPortalOrigin } from "../src/auth/origin-verifier";

describe("Portal origin authentication", () => {
  it("returns not-present so the legacy Access JWT path can run", () => {
    expect(verifyPortalOrigin(new Request("https://openlist.example/mcp"), "origin-secret")).toEqual({
      ok: false,
      reason: "not-present",
    });
  });

  it("rejects a malformed or incorrect bearer instead of falling through", () => {
    const request = new Request("https://openlist.example/mcp", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(verifyPortalOrigin(request, "origin-secret")).toEqual({
      ok: false,
      reason: "unauthorized",
    });
  });

  it("accepts Portal bearer and strips Authorization before MCP/domain handling", () => {
    const request = new Request("https://openlist.example/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer origin-secret",
        "MCP-Protocol-Version": "2025-11-25",
      },
    });
    const result = verifyPortalOrigin(request, "origin-secret");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.headers.has("authorization")).toBe(false);
    expect(result.request.headers.get("mcp-protocol-version")).toBe("2025-11-25");
  });
});
