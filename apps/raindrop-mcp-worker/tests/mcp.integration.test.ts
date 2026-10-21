import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";


const hasToken = Boolean(process.env.RAINDROP_ACCESS_TOKEN?.trim());
const explicitlyEnabled = process.env.RUN_LIVE_API_TESTS === "true";
const describeIf = hasToken && explicitlyEnabled ? describe : describe.skip;

describeIf("MCP protocol integration", () => {
  let client: Client;
  let service: RaindropMCPService;

  beforeAll(async () => {
    service = new RaindropMCPService({ accessToken: process.env.RAINDROP_ACCESS_TOKEN!.trim(), maxReadRetries: 0 });
    client = new Client({ name: "raindrop-mcp-test-client", version: "1.0.0" });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      service.getServer().connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterAll(async () => {
    await client?.close();
    await service?.cleanup();
  });

  it("exposes core tools through the MCP client", async () => {
    const { tools } = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).not.toContain("diagnostics");
    expect(toolNames).toContain("collection_list");
    expect(toolNames).toContain("bookmark_search");
    for (const name of ["collection_list", "bookmark_search"]) {
      expect(
        tools.find((tool) => tool.name === name)?.outputSchema,
      ).toBeDefined();
    }
  });


});
