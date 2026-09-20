import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

afterEach(() => vi.unstubAllGlobals());
const makeService = () => new RaindropMCPService({ accessToken: "fake", maxReadRetries: 0 });

describe("T08: strict dynamic resource templates", () => {
  it.each([
    "mcp://collection/0",
    "mcp://collection/-1",
    "mcp://collection/12junk",
    "mcp://collection/12/more",
    "mcp://collection/12?x=1",
    "mcp://collection/1.2",
    "mcp://collection/9007199254740993",
    "mcp://raindrop/0",
    "mcp://raindrop/7abc",
    "mcp://raindrop/7/extra",
    "mcp://raindrop/9007199254740993",
  ])("rejects malformed or unsafe %s before the upstream request", async (uri) => {
    const spy = vi.fn(() => { throw Error("Network access forbidden"); });
    vi.stubGlobal("fetch", spy);
    const app = makeService();
    try {
      await expect(app.readResource(uri)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await app.cleanup();
    }
  });

  it("reads an exact positive collection URI using one official endpoint", async () => {
    const spy = vi.fn((req: Request) => {
      expect(req.method).toBe("GET");
      expect(new URL(req.url).pathname).toBe("/rest/v1/collection/17");
      return Response.json({ result: true, item: { _id: 17, title: "test" } });
    });
    vi.stubGlobal("fetch", spy);
    const app = makeService();
    try {
      const result = await app.readResource("mcp://collection/17");
      expect(JSON.parse(result[0]!.text)).toMatchObject({ collection: { _id: 17, title: "test" } });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await app.cleanup();
    }
  });

  it.each([
    ["collection", "mcp://collection/17", "/rest/v1/collection/17"],
    ["raindrop", "mcp://raindrop/17", "/rest/v1/raindrop/17"],
  ])("never returns rejected %s detail as a successful resource", async (_kind, uri, path) => {
    const spy = vi.fn((req: Request) => {
      expect(new URL(req.url).pathname).toBe(path);
      return Response.json({ result: false, item: { _id: 17 } });
    });
    vi.stubGlobal("fetch", spy);
    const app = makeService();
    try {
      await expect(app.readResource(uri)).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await app.cleanup();
    }
  });

  it("lists static resources separately from URI templates at the MCP transport boundary", async () => {
    const service = makeService();
    const client = new Client({ name: "v3-resource-contract", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([service.getServer().connect(serverTransport), client.connect(clientTransport)]);
      const listed = await client.listResources();
      expect(listed.resources.map((resource) => resource.uri)).toContain("mcp://user/profile");
      expect(listed.resources.map((resource) => resource.uri)).not.toContain("mcp://collection/{id}");
      expect(listed.resources.map((resource) => resource.uri)).not.toContain("mcp://raindrop/{id}");
      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toEqual([
        "mcp://collection/{id}",
        "mcp://raindrop/{id}",
      ]);
    } finally {
      await client.close();
      await service.cleanup();
    }
  });
});
