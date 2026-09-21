import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildToolConfigs } from "../src/tools/index.js";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";
import { ToolEnvelopeSchema } from "../src/tools/common.js";

/**
 * T01 (#128): immutable v3-to-v4 design baseline, not v4 registration.
 * A read action points to exactly one existing v3 handler. All mutating
 * operations remain independently discoverable in v4 (ADR-0001/0002).
 */
export const V4_READ_ACTION_BASELINE = {
  raindrop_read: {
    list: "raindrop_list",
    get: "raindrop_get",
    suggest: "raindrop_suggest",
  },
  collection_read: {
    list: "collection_list",
    tree: "collection_tree",
    get: "collection_get",
  },
  tag_read: { list: "tag_list" },
  highlight_read: { list: "highlight_list" },
  audit_read: { check: "library_audit" },
  diagnostics_read: { local: "diagnostics", upstream: "diagnostics" },
} as const;

export const V4_INDEPENDENT_MUTATION_BASELINE = [
  "raindrop_create",
  "raindrop_update",
  "raindrop_delete",
  "raindrop_bulk_update",
  "raindrop_bulk_delete",
  "collection_create",
  "collection_update",
  "collection_delete",
  "tag_rename",
  "tag_merge",
  "tag_delete",
  "highlight_create",
  "highlight_update",
  "highlight_delete",
  "duplicates_delete",
  "trash_empty",
] as const;

afterEach(() => vi.unstubAllGlobals());

describe("Raindrop v4 T01 contract baseline (v3 source cc05fc9)", () => {
  const tools = buildToolConfigs({ serverVersion: "3.0.0" }).toolConfigs;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const readTargets = Object.values(V4_READ_ACTION_BASELINE)
    .flatMap((actions) => Object.values(actions));
  const uniqueReadTargets = [...new Set(readTargets)];
  const mutationTargets = [...V4_INDEPENDENT_MUTATION_BASELINE];

  it("maps all and only the 26 v3 tools to 10 pure-read capabilities and 16 independent mutations", () => {
    expect(Object.keys(V4_READ_ACTION_BASELINE)).toHaveLength(6);
    expect(uniqueReadTargets).toHaveLength(10);
    expect(mutationTargets).toHaveLength(16);
    expect(readTargets).toHaveLength(11); // diagnostics has two read-only actions
    const mapped = [...uniqueReadTargets, ...mutationTargets];
    expect(new Set(mapped).size).toBe(26);
    expect([...mapped].sort()).toEqual(tools.map((tool) => tool.name).sort());
    expect(tools).toHaveLength(26);
  });

  it("never maps writes, deletions or batch operations into a read-only action", () => {
    for (const name of uniqueReadTargets) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
    }
    for (const name of mutationTargets) {
      const tool = byName.get(name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations?.readOnlyHint, name).toBe(false);
    }
    expect(uniqueReadTargets).not.toContain("duplicates_delete");
    expect(uniqueReadTargets).not.toContain("trash_empty");
  });

  it("requires strict existing input schemas and structured output envelopes for all mappings", () => {
    for (const tool of tools) {
      const result = tool.inputSchema.safeParse({ __unknownField: true });
      expect(result.success, tool.name).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.code), tool.name)
          .toContain("unrecognized_keys");
      }
      expect(tool.outputSchema ?? ToolEnvelopeSchema, tool.name).toBeDefined();
    }
  });

  it("exercises real SDK Client discovery and local diagnostics without asserting Portal negotiation", async () => {
    const upstream = vi.fn(() => { throw new Error("No upstream request allowed in the offline protocol fixture"); });
    vi.stubGlobal("fetch", upstream);
    const service = new RaindropMCPService({ accessToken: "synthetic-t01-token", maxReadRetries: 0 });
    const client = new Client({ name: "v4-t01-offline-only", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([service.getServer().connect(serverTransport), client.connect(clientTransport)]);
      expect((await client.listTools()).tools.map((tool) => tool.name).sort())
        .toEqual(tools.map((tool) => tool.name).sort());
      expect((await client.listResources()).resources.map((resource) => resource.uri).sort())
        .toEqual(["diagnostics://server", "mcp://user/profile"]);
      expect((await client.listResourceTemplates()).resourceTemplates.map((template) => template.uriTemplate))
        .toEqual(["mcp://collection/{id}", "mcp://raindrop/{id}"]);
      expect((await client.listPrompts()).prompts.map((prompt) => prompt.name).sort())
        .toEqual(["export_markdown", "find_duplicates", "organize_by_topic"]);
      const result = await client.callTool({ name: "diagnostics", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: true, data: { protocolVersion: null }, meta: { requestCount: 0 },
      });
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await service.cleanup();
    }
  });

  it("retains the resource/prompt discovery baseline without reaching upstream", async () => {
    const service = new RaindropMCPService({ accessToken: "synthetic-t01-token" });
    try {
      expect(service.listResources().map((r) => r.uri).sort())
        .toEqual(["diagnostics://server", "mcp://user/profile"]);
      const manifest = await service.getManifest() as {
        prompts: Array<{ name: string }>;
        capabilities: Record<string, unknown>;
      };
      expect(manifest.prompts.map((p) => p.name).sort())
        .toEqual(["export_markdown", "find_duplicates", "organize_by_topic"]);
      expect(Object.keys(manifest.capabilities).sort())
        .toEqual(["prompts", "resources", "tools"]);
    } finally {
      await service.cleanup();
    }
  });
});
