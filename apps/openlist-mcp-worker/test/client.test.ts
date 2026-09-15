import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenListClient } from "../src/openlist/client";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe("OpenListClient", () => {
  it("sends the OpenList token directly without Bearer", async () => {
    const mock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("token-value");
      return new Response(JSON.stringify({ code: 200, data: { content: [] } }), { status: 200 });
    });
    globalThis.fetch = mock as typeof fetch;
    const client = new OpenListClient(new URL("https://openlist.example.com"), "token-value", 1000);
    await client.request("POST", "fs/list", { body: { path: "/" } });
    expect(mock).toHaveBeenCalledOnce();
  });

  it("maps envelope authentication failures", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ code: 401, message: "unauthorized" }), { status: 200 })) as typeof fetch;
    const client = new OpenListClient(new URL("https://openlist.example.com"), "bad", 1000);
    await expect(client.request("GET", "me")).rejects.toMatchObject({ code: "UPSTREAM_AUTH_FAILED" });
  });

  it("uses raw OpenList File-Path semantics for upload", async () => {
    const mock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("File-Path")).toBe("/documents/hello world.txt");
      return new Response(JSON.stringify({ code: 200, data: {} }), { status: 200 });
    });
    globalThis.fetch = mock as typeof fetch;
    const client = new OpenListClient(new URL("https://openlist.example.com"), "token", 1000);
    await client.upload("/documents", "hello world.txt", new Uint8Array([1, 2, 3]));
  });
});
