import { describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";
import { prepareToolSchema } from "../src/services/tool-schema.js";
import { ToolEnvelopeSchema } from "../src/tools/common.js";
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
  it("requires distinct success and failure fields in every public output schema", async () => {
    const invalid = [
      { ok: true, meta: {} },
      { ok: false, meta: {} },
      { ok: true, data: {}, error: { code: "X", message: "x" }, meta: {} },
      { ok: false, data: null, error: { code: "X", message: "x" }, meta: {} },
      { ok: true, data: undefined, meta: {} },
      { ok: false, error: { code: "X" }, meta: {} },
    ];
    for (const value of invalid) {
      expect(ToolEnvelopeSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
    expect(ToolEnvelopeSchema.safeParse({ ok: true, data: { items: [] }, meta: {} }).success).toBe(true);
    expect(ToolEnvelopeSchema.safeParse({
      ok: false, error: { code: "UPSTREAM_ERROR", message: "Unavailable" }, meta: {},
    }).success).toBe(true);

    const app = new RaindropMCPService({ accessToken: "offline-token" });
    const client = new Client({ name: "v3-output-schema", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([app.getServer().connect(serverTransport), client.connect(clientTransport)]);
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOL_NAMES);
      for (const tool of tools) {
        const requiredSets: string[][] = [];
        const inspect = (value: unknown): void => {
          if (!value || typeof value !== "object") return;
          if (Array.isArray(value)) {
            value.forEach(inspect);
            return;
          }
          const object = value as Record<string, unknown>;
          if (Array.isArray(object.required)) {
            requiredSets.push(object.required.filter((key): key is string => typeof key === "string"));
          }
          Object.values(object).forEach(inspect);
        };
        inspect(tool.outputSchema);
        for (const mandatory of [["ok", "data", "meta"], ["ok", "error", "meta"]]) {
          expect(requiredSets.some((set) => mandatory.every((field) => set.includes(field))),
            `tool ${tool.name} output schema must require ${mandatory.join(", ")}`).toBe(true);
        }
      }
    } finally {
      await client.close();
      await app.cleanup();
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


  it("routes valid arguments for all 26 tools through MCP Client without live upstream", async () => {
    // A failed fake upstream response is intentional here: the purpose of this
    // matrix is proving the real MCP boundary reaches each handler without
    // accidentally performing an account mutation. Feature-gated execution
    // remains denied locally. Successful HTTP contracts live in feature suites.
    const cases: Array<{
      name: string;
      args: Record<string, unknown>;
      expectedPath: string | null;
      expectedMethod?: string;
      expectedCode?: string;
    }> = [
      { name: "raindrop_list", args: {}, expectedPath: "/rest/v1/raindrops/0" },
      { name: "raindrop_get", args: { id: 7 }, expectedPath: "/rest/v1/raindrop/7" },
      { name: "raindrop_create", args: { link: "https://example.test/" }, expectedPath: "/rest/v1/raindrop", expectedMethod: "POST" },
      { name: "raindrop_update", args: { id: 7, note: "" }, expectedPath: "/rest/v1/raindrop/7", expectedMethod: "PUT" },
      { name: "raindrop_delete", args: { id: 7 }, expectedPath: "/rest/v1/raindrop/7" },
      { name: "raindrop_bulk_update", args: { collectionId: 7, ids: [8], important: false }, expectedPath: "/rest/v1/raindrops/7", expectedMethod: "PUT" },
      { name: "raindrop_bulk_delete", args: { collectionId: 7, ids: [8], confirm: true }, expectedPath: "/rest/v1/raindrops/7", expectedMethod: "DELETE" },
      { name: "raindrop_suggest", args: { id: 7 }, expectedPath: "/rest/v1/raindrop/7/suggest" },
      { name: "collection_list", args: {}, expectedPath: "/rest/v1/collections" },
      { name: "collection_tree", args: {}, expectedPath: "/rest/v1/collections" },
      { name: "collection_get", args: { id: 7 }, expectedPath: "/rest/v1/collection/7" },
      { name: "collection_create", args: { title: "fixture" }, expectedPath: "/rest/v1/collection", expectedMethod: "POST" },
      { name: "collection_update", args: { id: 7, title: "fixture" }, expectedPath: "/rest/v1/collection/7", expectedMethod: "PUT" },
      { name: "collection_delete", args: { id: 7 }, expectedPath: "/rest/v1/collections" },
      { name: "tag_list", args: {}, expectedPath: "/rest/v1/tags" },
      { name: "tag_rename", args: { scope: "collection", collectionId: 7, tags: ["old"], replace: "new", confirm: true }, expectedPath: "/rest/v1/tags/7", expectedMethod: "PUT" },
      { name: "tag_merge", args: { scope: "collection", collectionId: 7, tags: ["a", "b"], replace: "c", confirm: true }, expectedPath: "/rest/v1/tags/7", expectedMethod: "PUT" },
      { name: "tag_delete", args: { scope: "collection", collectionId: 7, tags: ["old"], confirm: true }, expectedPath: "/rest/v1/tags/7", expectedMethod: "DELETE" },
      { name: "highlight_list", args: {}, expectedPath: "/rest/v1/highlights" },
      { name: "highlight_create", args: { raindropId: 7, text: "fixture" }, expectedPath: "/rest/v1/raindrop/7", expectedMethod: "PUT" },
      { name: "highlight_update", args: { raindropId: 7, _id: "hl-7", note: "" }, expectedPath: "/rest/v1/raindrop/7", expectedMethod: "PUT" },
      { name: "highlight_delete", args: { raindropId: 7, _id: "hl-7" }, expectedPath: "/rest/v1/raindrop/7" },
      { name: "library_audit", args: { kind: "untagged" }, expectedPath: "/rest/v1/raindrops/0" },
      { name: "duplicates_delete", args: { collectionId: 7, ids: [8], confirm: true }, expectedPath: null, expectedCode: "FEATURE_UNVERIFIED" },
      { name: "trash_empty", args: {}, expectedPath: "/rest/v1/user/stats" },
      { name: "diagnostics", args: {}, expectedPath: null },
    ];
    expect(cases.map(({ name }) => name).sort()).toEqual(EXPECTED_TOOL_NAMES);
    for (const entry of cases) {
      const fetchSpy = vi.fn(async (_request: Request) => new Response(null, { status: 503 }));
      vi.stubGlobal("fetch", fetchSpy);
      const app = new RaindropMCPService({ accessToken: "fake", maxReadRetries: 0 });
      const client = new Client({ name: "v3-all-valid-arguments", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([app.getServer().connect(serverTransport), client.connect(clientTransport)]);
        const result = await client.callTool({ name: entry.name, arguments: entry.args });
        const envelope = result.structuredContent as {
          ok: boolean; error?: { code?: string }; meta?: Record<string, unknown>;
        } | undefined;
        expect(envelope, entry.name).toBeDefined();
        expect(envelope?.error?.code, entry.name).not.toBe("VALIDATION_ERROR");
        if (entry.expectedCode) expect(envelope?.error?.code, entry.name).toBe(entry.expectedCode);
        if (entry.expectedPath === null) {
          expect(fetchSpy, entry.name).not.toHaveBeenCalled();
        } else {
          expect(fetchSpy, entry.name).toHaveBeenCalled();
          const paths = fetchSpy.mock.calls.map(([request]) => new URL(request.url).pathname);
          expect(paths, entry.name).toContain(entry.expectedPath);
          if (entry.expectedMethod) {
            expect(fetchSpy.mock.calls.some(([request]) =>
              request.method === entry.expectedMethod &&
              new URL(request.url).pathname === entry.expectedPath
            ), entry.name).toBe(true);
          }
        }
      } finally {
        await client.close();
        await app.cleanup();
        vi.unstubAllGlobals();
      }
    }
  });

  it("rejects score sorting without a search before an upstream request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const app = new RaindropMCPService({ accessToken: "fake", maxReadRetries: 0 });
    const client = new Client({ name: "v3-score-guard", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([app.getServer().connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: "raindrop_list", arguments: { sort: "score" } });
      expect(result.isError).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await app.cleanup();
      vi.unstubAllGlobals();
    }
  });


  it.each([
    ["raindrop_get", { id: 7 }, { result: true, item: "invalid" }, "UPSTREAM_ERROR"],
    ["raindrop_list", {}, { result: true, items: ["invalid"] }, "UPSTREAM_ERROR"],
    ["highlight_list", {}, { result: true, items: ["invalid"] }, "UPSTREAM_ERROR"],
    ["collection_get", { id: 7 }, { result: true, item: "invalid" }, "UPSTREAM_ERROR"],
    ["raindrop_get", { id: 7 }, { result: true, item: { title: "missing _id" } }, "UPSTREAM_ERROR"],
    ["raindrop_list", {}, { result: true, items: [{ link: "https://example.test/missing-id" }] }, "UPSTREAM_ERROR"],
    ["highlight_list", {}, { result: true, items: [{ _id: "hl-7" }] }, "UPSTREAM_ERROR"],
    ["collection_get", { id: 7 }, { result: true, item: { _id: 7 } }, "UPSTREAM_ERROR"],
    ["tag_list", {}, { result: true, items: [{ _id: "tag-without-count" }] }, "UPSTREAM_ERROR"],
  ])("rejects malformed %s business results through a real MCP Client", async (name, args, payload, code) => {
    const fetchSpy = vi.fn(async () => Response.json(payload));
    vi.stubGlobal("fetch", fetchSpy);
    const app = new RaindropMCPService({ accessToken: "offline-token", maxReadRetries: 0 });
    const client = new Client({ name: "v3-malformed-read", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([app.getServer().connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, name).toBe(true);
      expect(result.structuredContent, name).toMatchObject({
        ok: false, error: { code }, meta: { requestCount: 1 },
      });
      expect(fetchSpy, name).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await app.cleanup();
      vi.unstubAllGlobals();
    }
  });

  it.each(["raindrop_create", "raindrop_update"])(
    "preserves acknowledged %s writes with malformed business results without replaying",
    async (name) => {
      const fetchSpy = vi.fn(async () => Response.json({ result: true, item: "invalid" }));
      vi.stubGlobal("fetch", fetchSpy);
      const app = new RaindropMCPService({ accessToken: "offline-token", maxReadRetries: 0 });
      const client = new Client({ name: "v3-malformed-write", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([app.getServer().connect(serverTransport), client.connect(clientTransport)]);
        const result = await client.callTool({
          name,
          arguments: name === "raindrop_create" ? { link: "https://example.test/" } : { id: 7, note: "" },
        });
        expect(result.structuredContent, name).toMatchObject({
          ok: true, data: null,
          meta: { status: "succeeded", outputOmitted: true, requestCount: 1 },
        });
        expect(fetchSpy, name).toHaveBeenCalledTimes(1);
      } finally {
        await client.close();
        await app.cleanup();
        vi.unstubAllGlobals();
      }
    },
  );

});
