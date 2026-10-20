import { afterEach, describe, expect, it, vi } from "vitest";
import RaindropService from "../src/services/raindrop.service.js";
import { AuthError } from "../src/types/mcpErrors.js";

// No real credentials, network, user bookmark data or AI-invented fallback.
afterEach(() => vi.unstubAllGlobals());

describe("Raindrop suggestions upstream 403 (both documented routes)", () => {
  it.each([
    [123, "GET", "/rest/v1/raindrop/123/suggest"],
    ["https://example.com", "POST", "/rest/v1/raindrop/suggest"],
  ] as const)("reports an upstream refusal for %s without retry or fabricated result", async (target, method, path) => {
    const network = vi.fn(async (request: Request) => {
      expect(request.method).toBe(method);
      expect(new URL(request.url).pathname).toBe(path);
      return new Response(JSON.stringify({ result: false, status: 403, errorMessage: "No access" }), {
        status: 403, headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", network);
    const service = new RaindropService({ accessToken: "test-only", maxReadRetries: 3 });
    await expect(service.getOfficialSuggestions(target)).rejects.toMatchObject({
      code: "AUTH_ERROR",
      message: "Raindrop API denied this operation (HTTP 403 Forbidden); cause not specified",
    } satisfies Partial<AuthError>);
    expect(network).toHaveBeenCalledTimes(1);
  });
});
