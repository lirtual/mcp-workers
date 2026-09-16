import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

const ctx = {} as ExecutionContext;

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    OPENLIST_URL: "https://openlist.example",
    OPENLIST_TOKEN: "openlist-token",
    OPENLIST_ALLOWED_PATHS: "/documents",
    OPENLIST_READONLY: "true",
    MCP_ACCESS_TOKEN: "portal-secret",
    ...overrides,
  };
}

describe("Portal-only authentication", () => {
  it("fails closed when MCP_ACCESS_TOKEN is not configured", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example/mcp", { method: "POST" }),
      baseEnv({ MCP_ACCESS_TOKEN: undefined }),
      ctx,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "portal_auth_not_configured",
      message: "MCP Portal authentication is not configured.",
    });
  });

  it("rejects missing or incorrect Portal bearer", async () => {
    for (const authorization of [undefined, "Bearer wrong-token"]) {
      const headers = new Headers();
      if (authorization) headers.set("authorization", authorization);
      const response = await worker.fetch(
        new Request("https://worker.example/mcp", { method: "POST", headers }),
        baseEnv(),
        ctx,
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    }
  });

  it("does not accept the retired Cloudflare Access assertion path", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example/mcp", {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": "legacy-access-assertion" },
      }),
      baseEnv(),
      ctx,
    );
    expect(response.status).toBe(401);
  });

  it("rejects browser Origin because no direct browser client is supported", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer portal-secret",
          origin: "https://client.example",
        },
      }),
      baseEnv(),
      ctx,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_origin",
      message: "Request Origin is not allowed.",
    });
  });

  it("valid Portal auth still fails closed when OpenList business config is missing", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example/mcp", {
        method: "POST",
        headers: { authorization: "Bearer portal-secret" },
      }),
      baseEnv({ OPENLIST_TOKEN: "" }),
      ctx,
    );
    expect(response.status).toBe(503);
  });
});
