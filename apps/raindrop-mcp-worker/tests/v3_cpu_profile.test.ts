/* global process, console */
import { describe, expect, it } from "vitest";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";
import worker from "../src/worker.js";

// Diagnostic only: not a Cloudflare CPU measurement, performance target,
// or production gate. A fresh MCP service is constructed per HTTP request.
// This isolates its registration cost without any real account credentials.
describe("offline MCP server construction CPU profile", () => {
  it("reports offline CPU for complete authenticated read-only Worker requests", async () => {
    const samples = 15;
    const warmups = 3;
    const serverUrl = "https://offline-profile.invalid";
    const env = {
      MCP_ACCESS_TOKEN: "offline-transport-only",
      RAINDROP_ACCESS_TOKEN: "offline-upstream-only",
      RAINDROP_RATE_LIMIT_MAX_RETRIES: "0",
    } as never;

    const operations = [
      {
        name: "health",
        method: "GET",
        path: "/health",
        body: undefined,
      },
      {
        name: "initialize",
        method: "POST",
        path: "/mcp",
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "offline-cpu", version: "1" },
          },
        },
      },
      {
        name: "tools_list",
        method: "POST",
        path: "/mcp",
        body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      },
    ] as const;

    for (const op of operations) {
      const samplesUs: number[] = [];
      for (let i = 0; i < warmups + samples; i++) {
        const request = new Request(`${serverUrl}${op.path}`, {
          method: op.method,
          headers: op.body ? {
            Authorization: "Bearer offline-transport-only",
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
          } : undefined,
          body: op.body ? JSON.stringify(op.body) : undefined,
        });
        const before = process.cpuUsage();
        const response = await worker.fetch(request, env);
        await response.text();
        const after = process.cpuUsage(before);
        expect(response.status).toBe(200);
        if (i >= warmups) samplesUs.push(after.user + after.system);
      }
      samplesUs.sort((a, b) => a - b);
      const at = (q: number) => samplesUs[Math.floor((samplesUs.length - 1) * q)];
      console.log(
        `OFFLINE_WORKER_CPU_${op.name.toUpperCase()}_N=15 p50_us=${at(0.5)} p95_us=${at(0.95)} min_us=${samplesUs[0]} max_us=${samplesUs.at(-1)}`,
      );
    }
    console.log(
      "NOTE: Offline Node CPU includes Worker auth/SDK but excludes network and Cloudflare CPU/runtime; no upstream calls or real credentials.",
    );
  });

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
