import { describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";
import { prepareToolSchema } from "../src/services/tool-schema.js";
import { z } from "zod";

const EXPECTED_TOOL_NAMES = [
  "raindrop_list",
  "raindrop_get",
  "raindrop_create",
  "raindrop_update",
  "raindrop_delete",
  "raindrop_bulk_update",
  "raindrop_bulk_delete",
  "raindrop_suggest",
  "collection_list",
  "collection_tree",
  "collection_get",
  "collection_create",
  "collection_update",
  "collection_delete",
  "tag_list",
  "tag_rename",
  "tag_merge",
  "tag_delete",
  "highlight_list",
  "highlight_create",
  "highlight_update",
  "highlight_delete",
  "library_audit",
  "duplicates_delete",
  "trash_empty",
  "diagnostics",
].sort();

describe("Raindrop MCP v3 public contract", () => {
  it("keeps credentials, cancellation and budgets isolated across schema-sharing servers", async () => {
    const controller = new AbortController();
    const first = new RaindropMCPService({ accessToken: "first-fixture", signal: controller.signal });
    const second = new RaindropMCPService({ accessToken: "second-fixture" });
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.headers.get("Authorization")).toBe("Bearer second-fixture");
      return Response.json({ result: true, items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      controller.abort();
      expect((await first.callTool("raindrop_list", {})).structuredContent.ok).toBe(false);
      expect((await second.callTool("raindrop_list", {})).structuredContent.ok).toBe(true);
      expect(first.raindropService.budget.requestCount).toBe(0);
      expect(second.raindropService.budget.requestCount).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("reuses immutable schema metadata without skipping validation or defaults", async () => {
    const original = z.object({ page: z.number().int().min(0).default(0) }).strict();
    const prepared = prepareToolSchema(original);
    const options = { target: "draft-2020-12" };
    const input = prepared["~standard"].jsonSchema.input(options);
    expect(input).toEqual(original["~standard"].jsonSchema.input(options));
    expect(prepared["~standard"].jsonSchema.output(options))
      .toEqual(original["~standard"].jsonSchema.output(options));
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.properties)).toBe(true);
    expect(prepared["~standard"].jsonSchema.input(options)).toBe(input);
    expect(await prepared["~standard"].validate({})).toEqual({ value: { page: 0 } });
    expect((await prepared["~standard"].validate({ page: -1 })).issues).toBeDefined();
    expect((await prepared["~standard"].validate({ unexpected: true })).issues).toBeDefined();
    const transformed = prepareToolSchema(z.object({
      ids: z.array(z.number()).transform((ids) => [...new Set(ids)]),
    }));
    expect(await transformed["~standard"].validate({ ids: [1, 1, 2] }))
      .toEqual({ value: { ids: [1, 2] } });
  });
  it("exposes exactly the approved 26 tools with no legacy alias", async () => {
    const service = new RaindropMCPService({ accessToken: "test-token" });
    try {
      const tools = await service.listTools();
      const actual = tools.map((tool) => tool.id).sort();
      expect(actual).toEqual(EXPECTED_TOOL_NAMES);
      expect(new Set(actual).size).toBe(26);
      expect(actual).toHaveLength(26);
      expect(actual).toContain("diagnostics");
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.outputSchema).toBeDefined();
      }
    } finally {
      await service.cleanup();
    }
  });
  it("rejects unknown fields for every one of the 26 tools through MCP Client", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("Schema must reject inputs before any upstream request");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const service = new RaindropMCPService({ accessToken: "offline-token" });
    const client = new Client({ name: "v3-exact-tool-validation", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        service.getServer().connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOL_NAMES);
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.outputSchema).toBeDefined();
        const result = await client.callTool({
          name: tool.name,
          arguments: { __contractProbe: true },
        });
        expect(result.isError, `tool ${tool.name} should reject an unknown field`).toBe(true);
        expect(fetchSpy, `tool ${tool.name} must not contact upstream`).not.toHaveBeenCalled();
      }
    } finally {
      await client.close();
      await service.cleanup();
      vi.unstubAllGlobals();
    }
  });

});
