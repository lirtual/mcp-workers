import { config } from "dotenv";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

config();
const hasAccessToken = Boolean(process.env.RAINDROP_ACCESS_TOKEN?.trim());
const runLiveApiTests = process.env.RUN_LIVE_API_TESTS === "true";
const runLive = hasAccessToken && runLiveApiTests;
const describeLive = runLive ? describe : describe.skip;

const USER_PROFILE_URI = "mcp://user/profile";
const DIAGNOSTICS_URI = "diagnostics://server";

describe("RaindropMCPService", () => {
  let mcpService: RaindropMCPService;

  beforeEach(async () => {
    if (mcpService && typeof mcpService.cleanup === "function") {
      await mcpService.cleanup();
    }
    mcpService = new RaindropMCPService({ accessToken: process.env.RAINDROP_ACCESS_TOKEN ?? "" });
  });

  afterEach(async () => {
    if (typeof mcpService?.cleanup === "function") {
      await mcpService.cleanup();
    }
    mcpService = undefined as unknown as RaindropMCPService;
  });

  // Only readonly API calls and metadata/resource checks are tested below

  it("should successfully initialize McpServer", () => {
    const server = mcpService.getServer();
    expect(server).toBeDefined();
  });

  it("should list available tools", async () => {
    const tools = await mcpService.listTools();
    expect(tools).toBeDefined();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
    // Check that each tool has required properties and types
    for (const tool of tools) {
      expect(tool).toHaveProperty("id");
      expect(typeof tool.id).toBe("string");
      expect(tool).toHaveProperty("name");
      expect(typeof tool.name).toBe("string");
      expect(tool).toHaveProperty("description");
      expect(typeof tool.description).toBe("string");
      expect(tool).toHaveProperty("inputSchema");
      expect(tool).toHaveProperty("outputSchema");
    }
    // Check for a known tool
    const diagnosticsTool = tools.find((t: any) => t.id === "diagnostics");
    expect(diagnosticsTool).toBeDefined();
    expect(diagnosticsTool?.name.toLowerCase()).toContain("diagnostic");
  });

  it("should read the diagnostics resource via a public API", async () => {
    if (typeof mcpService.readResource !== "function") {
      throw new Error(
        "readResource(uri: string) public method not implemented on RaindropMCPService",
      );
    }
    const result = await mcpService.readResource(DIAGNOSTICS_URI);
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    const first = result[0];
    if (!first) throw new Error("No diagnostics content returned");
    expect(first.uri).toBe(DIAGNOSTICS_URI);
    expect(first.text).toContain("diagnostics");
  });

  it("should list all registered resources with metadata", () => {
    const resources = mcpService.listResources();
    expect(resources).toBeDefined();
    expect(Array.isArray(resources)).toBe(true);
    expect(resources.length).toBeGreaterThan(0);
    for (const resource of resources) {
      expect(resource).toHaveProperty("id");
      expect(resource).toHaveProperty("uri");
    }
  });

  it("should return true for healthCheck", async () => {
    const healthy = await mcpService.healthCheck();
    expect(healthy).toBe(true);
  });

  it("should return correct server info", () => {
    const info = mcpService.getInfo();
    expect(info).toBeDefined();
    expect(info).toHaveProperty("name");
    expect(info).toHaveProperty("version");
    expect(info).toHaveProperty("description");
    expect(typeof info.name).toBe("string");
    expect(info.name).toBe("raindrop-mcp-worker");
    expect(typeof info.version).toBe("string");
    expect(typeof info.description).toBe("string");
  });

  it("should expose diagnostics tool in available tools", async () => {
    const tools = await mcpService.listTools();
    const diagnosticsTool = tools.find((t: any) => t.id === "diagnostics");

    expect(diagnosticsTool).toBeDefined();
    if (!diagnosticsTool) {
      throw new Error("Diagnostics tool not found in tool list");
    }
    expect(diagnosticsTool.name).toBe("diagnostics");
    expect(diagnosticsTool.description).toContain("Diagnostics");
  });
});

describeLive("RaindropMCPService live read-only resource checks", () => {
  let mcpService: RaindropMCPService;

  beforeEach(() => {
    mcpService = new RaindropMCPService({
      accessToken: process.env.RAINDROP_ACCESS_TOKEN ?? "",
    });
  });

  afterEach(async () => {
    await mcpService.cleanup();
  });

  it("reads the authenticated profile resource", async () => {
    const result = await mcpService.readResource(USER_PROFILE_URI);
    expect(result[0]?.uri).toBe(USER_PROFILE_URI);
    expect(JSON.parse(result[0]!.text).profile).toBeDefined();
  });

  it("reads a currently listed collection by strict resource URI when one exists", async () => {
    const list = await mcpService.callTool("collection_list", {});
    expect(list.structuredContent?.ok).toBe(true);
    const data = list.structuredContent?.data as { items?: Array<{ _id: number }> } | undefined;
    const first = data?.items?.[0];
    if (!first) return; // An empty isolated account is valid.
    const uri = `mcp://collection/${first._id}`;
    const resource = await mcpService.readResource(uri);
    expect(JSON.parse(resource[0]!.text).collection._id).toBe(first._id);
  });

  it("reads a currently listed bookmark by strict resource URI when one exists", async () => {
    const list = await mcpService.callTool("raindrop_list", { collectionId: 0, perpage: 1 });
    expect(list.structuredContent?.ok).toBe(true);
    const data = list.structuredContent?.data as { items?: Array<{ _id: number }> } | undefined;
    const first = data?.items?.[0];
    if (!first) return; // No fallback to a hardcoded or personal bookmark.
    const uri = `mcp://raindrop/${first._id}`;
    const resource = await mcpService.readResource(uri);
    expect(JSON.parse(resource[0]!.text).raindrop._id).toBe(first._id);
  });
});
