import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

afterEach(() => vi.unstubAllGlobals());

describe("Worker-native diagnostics contract", () => {
  it("uses the same strict input validation for helper and real MCP calls", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = new RaindropMCPService({ accessToken: "fake" });
    const client = new Client({ name: "diagnostics-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        service.getServer().connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const helper = await service.callTool("diagnostics", { includeEnvironment: true });
      expect(helper).toMatchObject({
        isError: true,
        structuredContent: { ok: false, error: { code: "VALIDATION_ERROR" } },
      });
      const real = await client.callTool({
        name: "diagnostics",
        arguments: { includeEnvironment: true },
      });
      expect(real.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await service.cleanup();
    }
  });

  it("is entirely local by default and never invents protocol or library counts", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = new RaindropMCPService({ accessToken: "fake" });
    const result = await service.callTool("diagnostics", {});
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: {
        runtime: "cloudflare-workers",
        protocolVersion: null,
        libraryHealth: null,
      },
      meta: { requestCount: 0 },
    });
    expect(result.content).toEqual([{ type: "text", text: "Diagnostics collected" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads only /user/stats on explicit opt-in and preserves unknown counts", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/rest/v1/user/stats");
      return Response.json({
        result: true,
        items: [{ _id: 0, count: 10 }, { _id: -99, count: 2 }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new RaindropMCPService({ accessToken: "fake" });
    const result = await service.callTool("diagnostics", { includeUpstream: true });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: {
        libraryHealth: {
          totalBookmarks: 10,
          totalCollections: null,
          totalHighlights: null,
          totalTags: null,
        },
      },
      meta: { requestCount: 1 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
