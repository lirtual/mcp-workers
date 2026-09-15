import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { handleRequest } from "../src/worker.js";

const baseEnv: Env = {
  INSTAPAPER_CONSUMER_KEY: "consumer",
  INSTAPAPER_CONSUMER_SECRET: "consumer-secret",
  INSTAPAPER_OAUTH_TOKEN: "oauth-token",
  INSTAPAPER_OAUTH_TOKEN_SECRET: "oauth-token-secret",
  MCP_ORIGIN_TOKEN: "origin-secret",
};

const ctx = {} as ExecutionContext;

describe("Worker origin authentication", () => {
  it("does not expose non-MCP routes", async () => {
    const response = await handleRequest(new Request("https://example.com/"), baseEnv, ctx);
    expect(response.status).toBe(404);
  });

  it("fails closed when origin authentication is not configured", async () => {
    const response = await handleRequest(
      new Request("https://example.com/mcp", { method: "POST" }),
      { ...baseEnv, MCP_ORIGIN_TOKEN: "" },
      ctx,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "origin_auth_not_configured" });
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
});
