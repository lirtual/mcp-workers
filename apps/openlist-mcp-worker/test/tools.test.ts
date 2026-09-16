import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/types";
import type { OpenListClient } from "../src/openlist/client";
import { registerTools } from "../src/tools/register";

class FakeServer {
  tools = new Map<string, (args: any) => Promise<any>>();
  registerTool(name: string, _config: unknown, handler: (args: any) => Promise<any>) {
    this.tools.set(name, handler);
  }
}

class FakeClient {
  calls: Array<{ method: string; endpoint: string; options: any }> = [];
  async request(method: string, endpoint: string, options: any = {}) {
    this.calls.push({ method, endpoint, options });
    return { ok: true };
  }
  async upload() { return { task: "1" }; }
}

function config(readonly: boolean): AppConfig {
  return {
    openListUrl: new URL("https://openlist.example.com"),
    allowedPaths: ["/documents"],
    readonly,
    uploadMaxBytes: 5 * 1024 * 1024,
    timeoutMs: 15000,
  };
}

describe("tool registration and policy", () => {
  it("omits mutation tools in read-only mode", () => {
    const server = new FakeServer();
    registerTools(server as any, config(true), new FakeClient() as unknown as OpenListClient);
    expect(server.tools.has("list_files")).toBe(true);
    expect(server.tools.has("remove")).toBe(false);
    expect(server.tools.has("upload_file")).toBe(false);
  });

  it("registers mutation tools when writable", () => {
    const server = new FakeServer();
    registerTools(server as any, config(false), new FakeClient() as unknown as OpenListClient);
    expect(server.tools.has("remove")).toBe(true);
    expect(server.tools.has("upload_file")).toBe(true);
  });

  it("does not call OpenList when destructive confirmation is absent", async () => {
    const server = new FakeServer();
    const client = new FakeClient();
    registerTools(server as any, config(false), client as unknown as OpenListClient);
    const result = await server.tools.get("remove")!({ directory: "/documents", names: ["a.txt"], confirm: false });
    expect(result.isError).toBe(true);
    expect(client.calls).toHaveLength(0);
  });

  it("blocks disallowed paths before upstream calls", async () => {
    const server = new FakeServer();
    const client = new FakeClient();
    registerTools(server as any, config(false), client as unknown as OpenListClient);
    const result = await server.tools.get("list_files")!({ path: "/private", page: 1, per_page: 50, refresh: false, password: "" });
    expect(result.isError).toBe(true);
    expect(client.calls).toHaveLength(0);
  });
});
