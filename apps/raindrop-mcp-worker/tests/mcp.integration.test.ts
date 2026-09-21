import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

describe("MCP v3 protocol integration (offline)", () => {
  let client: Client;
  let service: RaindropMCPService;
  const upstream = vi.fn();

  beforeAll(async () => {
    // This suite validates MCP transport and advertised contracts, not a live
    // account. No real token is loaded or needed.
    vi.stubGlobal("fetch", upstream);
    service = new RaindropMCPService({ accessToken: "offline-token" });
    client = new Client({ name: "raindrop-v3-integration", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([service.getServer().connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client?.close();
    await service?.cleanup();
    vi.unstubAllGlobals();
  });

  it("advertises only the approved 26 public tools and a real output schema", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(26);
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(26);
    for (const name of ["diagnostics", "collection_list", "raindrop_list", "duplicates_delete", "trash_empty"]) {
      expect(names).toContain(name);
      expect(tools.find((tool) => tool.name === name)?.outputSchema).toBeDefined();
    }
    for (const name of ["bookmark_search", "list_raindrops", "suggest_tags", "empty_trash", "cleanup_collections"]) {
      expect(names).not.toContain(name);
    }
  });

  it("returns truthful local diagnostics without fabricating an upstream count or protocol version", async () => {
    const result = await client.callTool({ name: "diagnostics", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: {
        runtime: "cloudflare-workers",
        protocolVersion: null,
        libraryHealth: null,
      },
      meta: { requestCount: 0 },
    });
    expect(upstream).not.toHaveBeenCalled();
  });
});
