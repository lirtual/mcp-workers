import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

const expected = [
  "collection_list", "collection_get", "collection_create", "collection_update",
  "bookmark_search", "bookmark_get", "bookmark_exists", "bookmark_create",
  "bookmark_update", "bookmark_move", "bookmark_delete", "bookmark_filters_get",
  "tag_list", "highlight_list", "highlight_create", "highlight_update", "highlight_delete",
  "tag_rename", "tag_merge", "tag_delete", "bookmark_batch_update", "bookmark_batch_delete",
  "collection_delete", "collection_remove_empty", "bookmark_remove_duplicates",
].sort();
const removed = [
  "get_raindrop", "list_raindrops", "get_collection_tree", "collection_manage",
  "bookmark_manage", "tag_manage", "highlight_manage", "bulk_edit_raindrops",
  "empty_trash", "cleanup_collections", "remove_duplicates", "get_suggestions",
  "suggest_tags", "diagnostics", "library_audit", "trash_empty",
];

describe("Spec #145: Agent MCP public contract", () => {
  it("exposes exactly 25 atomic tools and refuses all 16 removed names before network access", async () => {
    const service = new RaindropMCPService({ accessToken: "mock-only" });
    const client = new Client({ name: "spec145-contract", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const fetch = vi.fn(() => { throw new Error("Unexpected upstream request"); });
    vi.stubGlobal("fetch", fetch);
    try {
      await Promise.all([service.getServer().connect(st), client.connect(ct)]);
      const { tools } = await client.listTools();
      expect(tools.map(t => t.name).sort()).toEqual(expected);
      expect(new Set(tools.map(t => t.name)).size).toBe(25);
      for (const name of removed) {
        await expect(client.callTool({ name, arguments: {} }))
          .rejects.toThrow(/not found/i);
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await client.close(); await service.cleanup(); vi.unstubAllGlobals();
    }
  });

  it("never accepts permanent deletion or public collection writes through MCP", async () => {
    const service = new RaindropMCPService({ accessToken: "mock-only" });
    const client = new Client({ name: "spec145-safety", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const fetch = vi.fn(() => { throw new Error("Unexpected upstream request"); });
    vi.stubGlobal("fetch", fetch);
    try {
      await Promise.all([service.getServer().connect(st), client.connect(ct)]);
      for (const [name, args] of [
        ["bookmark_delete", { id: 7, permanent: true }],
        ["collection_create", { title: "Private", public: true }],
        ["collection_update", { id: 19, public: true }],
      ] as const) {
        expect((await client.callTool({ name, arguments: args })).isError, name).toBe(true);
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await client.close(); await service.cleanup(); vi.unstubAllGlobals();
    }
  });
});
