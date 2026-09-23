import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

describe("T03 (#130) SDK-backed read-only vertical tracer", () => {
  it("discovers only the two new v4 tracer tools alongside the frozen 26 v3 tools", async () => {
    const service = new RaindropMCPService({ accessToken: "offline-token", maxReadRetries: 0 });
    const client = new Client({ name: "v4-tracer-contract", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        service.getServer().connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("diagnostics_read");
      expect(names).toContain("raindrop_read");
      expect(names).toHaveLength(28);
      expect(new Set(names).size).toBe(28);
      expect(names).toContain("diagnostics");
      expect(names).toContain("raindrop_list");
    } finally {
      await client.close();
      await service.cleanup();
    }
  });
});
