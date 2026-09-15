import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../src/server.js";

describe("HTTP server", () => {
  it("reports the v2 protocol target", async () => {
    const response = await request(app).get("/health").set("Host", "localhost");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "healthy",
      service: "raindrop-mcp-worker",
      protocolTarget: "2026-07-28",
      httpMode: "per-request",
    });
  });

  it("rejects cross-origin browser requests", async () => {
    const response = await request(app)
      .post("/mcp")
      .set("Host", "localhost")
      .set("Origin", "https://evil.example")
      .send({ jsonrpc: "2.0", id: 1, method: "ping" });

    expect(response.status).toBe(403);
  });

  it("accepts same-origin preflight without wildcard CORS", async () => {
    const response = await request(app)
      .options("/mcp")
      .set("Host", "localhost")
      .set("Origin", "http://localhost:3002");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3002",
    );
  });
});
