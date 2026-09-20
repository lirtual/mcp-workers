import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { RaindropMCPService } from "../src/services/raindropmcp.service.js";

afterEach(() => vi.unstubAllGlobals());
const app = () => new RaindropMCPService({ accessToken: "fake", maxReadRetries: 0 });
const fake = (handler: (request: Request) => Promise<Response> | Response) => {
  const spy = vi.fn(handler);
  vi.stubGlobal("fetch", spy);
  return spy;
};

describe("T07: official Trash empty safety contract", () => {
  it("previews official -99 count without submitting deletion", async () => {
    const spy = fake((request) => {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe("/rest/v1/user/stats");
      return Response.json({ result: true, items: [{ _id: -99, count: 14 }], meta: { pro: false } });
    });
    const result = await app().callTool("trash_empty", {});
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      ok: true, data: { count: 14 }, meta: { status: "preview", requestCount: 1 },
    });
  });

  it("preserves unknown count rather than inventing zero", async () => {
    const spy = fake(() => Response.json({ result: true, items: [] }));
    const result = await app().callTool("trash_empty", {});
    expect(result.structuredContent).toMatchObject({ ok: true, data: { count: null } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("confirmed deletion uses one official DELETE /collection/-99 with no pre-read", async () => {
    const spy = fake((request) => {
      expect(request.method).toBe("DELETE");
      expect(new URL(request.url).pathname).toBe("/rest/v1/collection/-99");
      return Response.json({ result: true });
    });
    const result = await app().callTool("trash_empty", { confirm: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      ok: true, data: { modified: null }, meta: { status: "succeeded", modified: null, requestCount: 1 },
    });
  });

  it("a submitted 500 is unknown and not retried", async () => {
    const spy = fake(() => new Response(null, { status: 500 }));
    const result = await app().callTool("trash_empty", { confirm: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      ok: false, error: { code: "WRITE_OUTCOME_UNKNOWN", upstreamStatus: 500 },
      meta: { status: "unknown", requestCount: 1 },
    });
  });

  it("reports 200 without an acknowledgement as unknown", async () => {
    const spy = fake(() => Response.json({}));
    const result = await app().callTool("trash_empty", { confirm: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      ok: false, error: { code: "WRITE_OUTCOME_UNKNOWN" }, meta: { status: "unknown", requestCount: 1 },
    });
  });

  it("rejects unknown fields at the real MCP Client boundary before fetch", async () => {
    const spy = fake(() => { throw Error("must not send request"); });
    const service = app();
    const client = new Client({ name: "v3-trash-contract", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([service.getServer().connect(serverTransport), client.connect(clientTransport)]);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("trash_empty");
      const result = await client.callTool({ name: "trash_empty", arguments: { confirm: true, count: 0 } });
      expect(result.isError).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await service.cleanup();
    }
  });
});
