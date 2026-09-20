import { config } from "dotenv";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

// Explicit opt-in only. This file is excluded from the default offline suite.
// It never submits a mutation or prints personal bookmark/profile content.
config();
const enabled = process.env.RUN_LIVE_API_TESTS === "true";
const describeLive = enabled ? describe : describe.skip;
const requiredTools = [
  "raindrop_list", "raindrop_get", "raindrop_create", "raindrop_update",
  "raindrop_delete", "raindrop_bulk_update", "raindrop_bulk_delete",
  "raindrop_suggest", "collection_list", "collection_tree", "collection_get",
  "collection_create", "collection_update", "collection_delete",
  "tag_list", "tag_rename", "tag_merge", "tag_delete",
  "highlight_list", "highlight_create", "highlight_update", "highlight_delete",
  "library_audit", "duplicates_delete", "trash_empty", "diagnostics",
];

describeLive("T09 real-account read-only MCP smoke (never changes existing data)", () => {
  let service: RaindropMCPService;
  let client: Client;

  beforeAll(async () => {
    const token = process.env.RAINDROP_ACCESS_TOKEN?.trim();
    if (!token) {
      throw new Error("RAINDROP_ACCESS_TOKEN must be set locally for the opted-in live smoke");
    }
    service = new RaindropMCPService({ accessToken: token });
    client = new Client({ name: "raindrop-v3-live-readonly", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      service.getServer().connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterAll(async () => {
    await client?.close();
    await service?.cleanup();
  });

  it("discovers exactly the expected 26 v3 tools from a real MCP Client", async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([...requiredTools].sort());
    expect(tools.every((tool) => tool.inputSchema && tool.outputSchema)).toBe(true);
  });

  const reads: Array<[string, Record<string, unknown>]> = [
    ["diagnostics", { includeUpstream: true }],
    ["collection_list", { page: 0, perpage: 1 }],
    ["raindrop_list", { collectionId: 0, page: 0, perpage: 1 }],
    ["tag_list", { page: 0, perpage: 1 }],
    ["highlight_list", { page: 0, perpage: 1 }],
    ["library_audit", { kind: "untagged", collectionId: 0, page: 0, perpage: 1 }],
  ];

  it.each(reads)("%s: makes only an authorized read and returns a valid envelope", async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    // Deliberately avoid asserting on/printing real profile, bookmark or tag data.
    expect(result.isError === true).toBe(false);
    expect(result.structuredContent?.ok).toBe(true);
    expect(result.structuredContent?.meta).toBeDefined();
  });

  it("reads profile resource without logging the user's identity", async () => {
    const contents = await client.readResource({ uri: "mcp://user/profile" });
    expect(contents.contents).toHaveLength(1);
    expect(contents.contents[0]?.uri).toBe("mcp://user/profile");
    const content = contents.contents[0];
    expect(content && "text" in content && typeof content.text === "string").toBe(true);
  });

  it.each(["duplicates", "broken"] as const)(
    "checks the %s filter without inferring semantics or plan access",
    async (kind, context) => {
      const result = await client.callTool({
        name: "library_audit",
        arguments: { kind, collectionId: 0, page: 0, perpage: 1 },
      });
      if (result.isError === true) {
        const error = result.structuredContent?.error as { code?: string } | undefined;
        if (error?.code === "FEATURE_UNAVAILABLE" || error?.code === "FEATURE_UNVERIFIED") {
          // Report the blocked capability separately, rather than turning a
          // subscription limitation into a false passing assertion.
          context.skip();
          return;
        }
      }
      expect(result.isError === true).toBe(false);
      expect(result.structuredContent?.ok).toBe(true);
    },
  );
});
