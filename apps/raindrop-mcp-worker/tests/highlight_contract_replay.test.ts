import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Full public MCP -> Service -> official HTTP endpoint, no token or network.
describe("production highlight 404 regression over Draft MCP", () => {
  it("uses official bookmark PUT for highlight_create, never obsolete POST /highlights", async () => {
      const bookmarkId = 42;
      const highlight = {
        _id: "opaque-highlight-id", text: "Acceptance-only quote",
        note: "", color: "yellow",
      };
      const network = vi.fn(async (request: Request) => {
        const url = new URL(request.url);
        expect(url.pathname).toBe("/rest/v1/raindrop/42");
        if (request.method === "GET")
          return json({ result: true, item: { _id: bookmarkId, highlights: [] } });
        expect(request.method).toBe("PUT");
        expect(await request.json()).toEqual({
          highlights: [{ text: highlight.text, color: "yellow" }],
        });
        return json({ result: true, item: { _id: bookmarkId, highlights: [highlight] } });
      });
      vi.stubGlobal("fetch", network);
      const service = new RaindropMCPService({
        accessToken: "mock-only", maxReadRetries: 0,
      });
      const client = new Client({ name: "highlight-regression", version: "1.0.0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([service.getServer().connect(st), client.connect(ct)]);
        const result = await client.callTool({
          name: "highlight_create",
          arguments: { bookmarkId, text: highlight.text, color: "yellow" },
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          status: "succeeded", bookmarkId, highlightId: highlight._id,
          highlight: { text: highlight.text },
        });
        expect(network.mock.calls.map(([r]) => r.method)).toEqual(["GET", "PUT"]);
        expect(network.mock.calls.every(([r]) =>
          !new URL(r.url).pathname.startsWith("/rest/v1/highlights"),
        )).toBe(true);
      } finally {
        await client.close();
        await service.cleanup();
      }
    },
  );

  it("fails closed on a missing bookmarked target without PUT or retries", async () => {
    const network = vi.fn(async (request: Request) => {
      expect(request.method).toBe("GET");
      return json({ errorMessage: "Resource not found" }, 404);
    });
    vi.stubGlobal("fetch", network);
    const service = new RaindropMCPService({
      accessToken: "mock-only", maxReadRetries: 0,
    });
    const client = new Client({ name: "highlight-404", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([service.getServer().connect(st), client.connect(ct)]);
      const response = await client.callTool({
        name: "highlight_create",
        arguments: { bookmarkId: 42, text: "Only a disposable quote" },
      });
      expect(response.isError).toBe(true);
      expect(network).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await service.cleanup();
    }
  });
});
