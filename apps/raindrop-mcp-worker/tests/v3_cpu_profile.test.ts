/* global process, console */
import { describe, expect, it } from "vitest";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

// Diagnostic only: not a Cloudflare CPU measurement, performance target,
// or production gate. A fresh MCP service is constructed per HTTP request.
// This isolates its registration cost without any real account credentials.
describe("offline MCP server construction CPU profile", () => {
  it("reports approximate Node CPU time per fresh 26-tool registration", async () => {
    const warmups = 5;
    const samples = 40;
    const timingsUs: number[] = [];

    for (let i = 0; i < warmups + samples; i++) {
      const before = process.cpuUsage();
      const service = new RaindropMCPService({
        accessToken: "offline-profile-only",
        maxReadRetries: 0,
      });
      service.getServer();
      const after = process.cpuUsage(before);
      if (i >= warmups) timingsUs.push(after.user + after.system);
      await service.cleanup();
    }

    timingsUs.sort((a, b) => a - b);
    const at = (q: number) => timingsUs[Math.floor((timingsUs.length - 1) * q)];
    const toolNames = await new RaindropMCPService({
      accessToken: "offline-profile-only",
    }).listTools();
    expect(toolNames).toHaveLength(26);
    expect(timingsUs).toHaveLength(samples);

    console.log(
      `OFFLINE_MCP_CONSTRUCTION_CPU_N=40 p50_us=${at(0.5)} p95_us=${at(0.95)} min_us=${timingsUs[0]} max_us=${timingsUs.at(-1)}`,
    );
    console.log(
      "NOTE: Node process CPU; excludes Worker auth/transport, upstream and Cloudflare runtime. Not proof of Free-plan compatibility.",
    );
  });
});
