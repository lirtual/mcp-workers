import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { handleRequest } from "../src/worker.js";

const baseEnv: Env = {
  INSTAPAPER_CONSUMER_KEY: "consumer",
  INSTAPAPER_CONSUMER_SECRET: "consumer-secret",
  INSTAPAPER_OAUTH_TOKEN: "oauth-token",
  INSTAPAPER_OAUTH_TOKEN_SECRET: "oauth-token-secret",
  MCP_ACCESS_TOKEN: "portal-secret",
};

const ctx = {} as ExecutionContext;

describe("Worker Portal authentication", () => {
  it("does not expose non-MCP routes", async () => {
    const response = await handleRequest(new Request("https://example.com/"), baseEnv, ctx);
    expect(response.status).toBe(404);
  });

  it("fails closed when Portal authentication is not configured", async () => {
    const response = await handleRequest(
      new Request("https://example.com/mcp", { method: "POST" }),
      { ...baseEnv, MCP_ACCESS_TOKEN: "" },
      ctx,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "portal_auth_not_configured" });
  });

  it("rejects direct MCP calls without the Portal bearer", async () => {
    const response = await handleRequest(
      new Request("https://example.com/mcp", { method: "POST" }),
      baseEnv,
      ctx,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await response.json()).toMatchObject({ error: "unauthorized" });
  });

  it("rejects browser Origin when no browser origin is allowed", async () => {
    const response = await handleRequest(
      new Request("https://example.com/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer portal-secret",
          Origin: "https://example.app",
        },
      }),
      baseEnv,
      ctx,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "invalid_origin" });
  });
});
