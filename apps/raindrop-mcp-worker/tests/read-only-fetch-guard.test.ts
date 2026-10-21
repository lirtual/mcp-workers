import { describe, expect, it, vi } from "vitest";
import { createReadOnlyRaindropFetch } from "./read-only-fetch-guard.js";

describe("opt-in live acceptance guard (credential-free)", () => {
  it("allows only HTTPS Raindrop GET without following redirects", async () => {
    const network = vi.fn<typeof fetch>(async () => new Response("ok"));
    const guarded = createReadOnlyRaindropFetch(network);
    const result = await guarded(new Request(
      "https://api.raindrop.io/rest/v1/collections",
      { headers: { Authorization: "Bearer dummy" } },
    ));
    expect(result.status).toBe(200);
    expect(network).toHaveBeenCalledTimes(1);
    const dispatched = network.mock.calls[0]![0] as Request;
    expect(dispatched.method).toBe("GET");
    expect(dispatched.redirect).toBe("error");
    expect(dispatched.headers.get("Authorization")).toBe("Bearer dummy");
  });

  it.each([
    ["POST", "https://api.raindrop.io/rest/v1/raindrop"],
    ["DELETE", "https://api.raindrop.io/rest/v1/raindrops/-99"],
    ["GET", "http://api.raindrop.io/rest/v1/collections"],
    ["GET", "https://api.raindrop.io.evil.test/rest/v1/collections"],
    ["GET", "https://api.raindrop.io/other"],
    ["GET", "https://example.test/rest/v1/collections"],
  ])("blocks %s %s before the network", async (method, url) => {
    const network = vi.fn<typeof fetch>(async () => new Response("ok"));
    await expect(createReadOnlyRaindropFetch(network)(url, { method }))
      .rejects.toThrow(/Read-only acceptance rejected/);
    expect(network).not.toHaveBeenCalled();
  });
});
