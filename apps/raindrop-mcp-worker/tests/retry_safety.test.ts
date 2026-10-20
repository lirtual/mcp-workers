import { afterEach, describe, expect, it, vi } from "vitest";
import RaindropService from "../src/services/raindrop.service.js";

describe("RaindropService retry safety", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("caps upstream HTTP requests at 60 even when callers bypass the cache", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ result: true, items: [], count: 0 }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const service = new RaindropService({ accessToken: "test-token", maxReadRetries: 0 });

    for (let index = 0; index < 60; index++) {
      await expect(service.getBookmarks({ page: 0 }, true)).resolves.toEqual({
        items: [], count: 0,
      });
    }
    await expect(service.getBookmarks({ page: 0 }, true))
      .rejects.toThrow(/upstream request budget/i);
    expect(fetchMock).toHaveBeenCalledTimes(60);
  });

  it("charges a transient read retry against the same 60-request cap", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("failure", {
        status: 500, statusText: "Internal Server Error",
      }))
      .mockImplementation(async () => new Response(
        JSON.stringify({ result: true, items: [], count: 0 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    vi.stubGlobal("fetch", fetchMock);
    const service = new RaindropService({ accessToken: "test-token", maxReadRetries: 1 });

    const first = service.getBookmarks({ page: 0 }, true);
    await vi.runAllTimersAsync();
    await expect(first).resolves.toEqual({ items: [], count: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 2 HTTP attempts already consumed (including the first failed read).
    for (let index = 0; index < 58; index++) {
      await service.getBookmarks({ page: 0 }, true);
    }
    await expect(service.getBookmarks({ page: 0 }, true))
      .rejects.toThrow(/upstream request budget/i);
    expect(fetchMock).toHaveBeenCalledTimes(60);
  });

  it("does not retry an upstream failure after submitting a write", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("upstream failure", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const service = new RaindropService({ accessToken: "test-token", maxReadRetries: 1 });
    (service as any).rateLimiter = undefined;

    await expect(service.createCollection("one-shot")).rejects.toThrow(
      "API Error: 500 Internal Server Error",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps bounded transient retries for reads", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("upstream failure", {
          status: 500,
          statusText: "Internal Server Error",
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const service = new RaindropService({ accessToken: "test-token", maxReadRetries: 1 });
    (service as any).rateLimiter = undefined;

    const resultPromise = service.getCollections(true);
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a read before a Retry-After that exceeds its budget", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "60" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const service = new RaindropService({ accessToken: "test-token", maxReadRetries: 1 });
    (service as any).rateLimiter = undefined;

    await expect(service.getCollections(true)).rejects.toThrow(
      /exceeds remaining read retry budget/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never replays a failed collection-scoped single-bookmark DELETE", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      if (request.method === "GET")
        return new Response(JSON.stringify({ result: true, item: {
          _id: 78, collection: { $id: 11 },
        } }), { headers: { "content-type": "application/json" } });
      return new Response("upstream failure", {
        status: 500, statusText: "Internal Server Error",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new RaindropService({ accessToken: "test-token", maxReadRetries: 3 });
    await expect(service.deleteBookmark(78, 11)).rejects.toThrow();
    const deletes = fetchMock.mock.calls.filter(([request]) => request.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(new URL(deletes[0]![0].url).pathname).toBe("/rest/v1/raindrops/11");
  });

  it("never turns an ordinary deletion into permanent deletion after a Trash race", async () => {
    let location = 11;
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (request.method === "GET")
        return new Response(JSON.stringify({ result: true, item: {
          _id: 78, collection: { $id: location },
        } }), { headers: { "content-type": "application/json" } });
      expect(request.method).toBe("DELETE");
      expect(url.pathname).toBe("/rest/v1/raindrops/11");
      expect(url.searchParams.get("nested")).toBe("false");
      expect(await request.json()).toEqual({ ids: [78] });
      // Another client moved this bookmark to Trash after our last GET.
      location = -99;
      // Scoped DELETE of collection 11 no longer targets the moved item.
      return new Response(JSON.stringify({ result: true, modified: 0 }), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new RaindropService({ accessToken: "test-token", maxReadRetries: 0 });
    await expect(service.deleteBookmark(78, 11)).rejects.toThrow(/individually acknowledged/);
    expect(location).toBe(-99);
    expect(fetchMock.mock.calls.filter(([r]) => r.method === "DELETE")).toHaveLength(1);
    // A stale former source is rejected before dispatching another write.
    await expect(service.deleteBookmark(78, 11)).rejects.toThrow(/source changed/);
    expect(fetchMock.mock.calls.filter(([r]) => r.method === "DELETE")).toHaveLength(1);
  });

  it("does not retry an upstream 429 after submitting a write", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "1" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const service = new RaindropService({ accessToken: "test-token", maxReadRetries: 1 });
    (service as any).rateLimiter = undefined;

    await expect(service.createCollection("one-shot")).rejects.toThrow(
      /Rate limited by Raindrop.io/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

const items = ["a", "b", "target"].map((_id) => ({ _id, count: 2 }));
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
function mockHttp(
  write: () => Response | Promise<Response> = () => json({ result: true }),
) {
  const fetch = vi.fn(async (request: Request) =>
    request.method === "GET" ? json({ result: true, items }) : write(),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const newService = () =>
  new RaindropService({ accessToken: "test", maxReadRetries: 0 });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tag Service HTTP contract", () => {
  it.each([undefined, 0, 42])(
    "lists and renames with exact path/body in scope %s",
    async (scope) => {
      const fetch = mockHttp();
      const service = newService();
      expect(await service.getTags(scope)).toEqual(items);
      expect(await service.renameTag(scope, "a", "fresh")).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(3);
      for (const [request] of fetch.mock.calls) {
        expect(request.url).toBe(
          `https://api.raindrop.io/rest/v1/tags/${scope ?? 0}`,
        );
      }
      expect(fetch.mock.calls.map(([request]) => request.method)).toEqual([
        "GET",
        "GET",
        "PUT",
      ]);
      expect(await fetch.mock.calls[2]![0].json()).toEqual({
        tags: ["a"],
        replace: "fresh",
      });
    },
  );

  it.each([undefined, 0, 17])(
    "merges into an existing target and deletes explicit names in scope %s",
    async (scope) => {
      const fetch = mockHttp();
      const service = newService();
      await expect(
        service.mergeTags(scope, ["a", "b"], "target"),
      ).resolves.toBe(true);
      await expect(service.deleteTags(scope, ["a", "b"])).resolves.toBe(true);
      expect(fetch.mock.calls.map(([request]) => request.method)).toEqual([
        "GET",
        "PUT",
        "GET",
        "DELETE",
      ]);
      expect(await fetch.mock.calls[1]![0].json()).toEqual({
        tags: ["a", "b"],
        replace: "target",
      });
      expect(await fetch.mock.calls[3]![0].json()).toEqual({
        tags: ["a", "b"],
      });
      for (const [request] of fetch.mock.calls)
        expect(request.url).toContain(`/tags/${scope ?? 0}`);
    },
  );

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "42", null])(
    "rejects invalid scope %s before any HTTP",
    async (scope) => {
      const fetch = mockHttp();
      const service = newService();
      await expect(service.getTags(scope as number)).rejects.toThrow(
        /safe integer/,
      );
      await expect(service.deleteTags(scope as number, ["a"])).rejects.toThrow(
        /safe integer/,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("accepts the largest safe integer scope without rounding", async () => {
    const fetch = mockHttp();
    await newService().getTags(Number.MAX_SAFE_INTEGER);
    expect(fetch.mock.calls[0]![0].url).toContain(
      `/tags/${Number.MAX_SAFE_INTEGER}`,
    );
  });

  it("rejects missing sources, rename conflicts and ambiguous merge inputs without writing", async () => {
    const fetch = mockHttp();
    const service = newService();
    await expect(service.renameTag(12, "missing", "fresh")).rejects.toThrow(
      /does not exist.*12/,
    );
    await expect(service.renameTag(12, "a", "target")).rejects.toThrow(
      /tag_merge/,
    );
    await expect(service.renameTag(12, "a", "a")).rejects.toThrow();
    for (const names of [
      [],
      [""],
      [" "],
      ["a", "a"],
      [" a"],
      ["a", "missing"],
    ]) {
      await expect(service.deleteTags(12, names)).rejects.toThrow();
      await expect(service.mergeTags(12, names, "fresh")).rejects.toThrow();
    }
    await expect(service.mergeTags(12, ["a"], "fresh")).rejects.toThrow();
    await expect(service.mergeTags(12, ["a", "b"], "a")).rejects.toThrow();
    await expect(service.mergeTags(12, ["a", "b"], " ")).rejects.toThrow();
    expect(
      fetch.mock.calls.every(([request]) => request.method === "GET"),
    ).toBe(true);
  });

  it.each([
    { result: false, items },
    {},
    { result: true },
    { result: true, items: [{ _id: "a", count: "2" }] },
    { result: true, items: [items[0], items[0]] },
  ])("fails closed on invalid preflight %j", async (body) => {
    const fetch = vi.fn(async () => json(body));
    vi.stubGlobal("fetch", fetch);
    await expect(newService().deleteTags(42, ["a"])).rejects.toThrow(
      /preflight/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses scoped existence, never global fallback", async () => {
    const fetch = vi.fn(async () => json({ result: true, items: [] }));
    vi.stubGlobal("fetch", fetch);
    await expect(newService().deleteTags(42, ["a"])).rejects.toThrow(
      /does not exist/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toBeDefined();
  });

  it.each(["rename", "merge", "delete"] as const)(
    "invalidates caches only after confirmed %s",
    async (operation) => {
      for (const confirmed of [false, true]) {
        mockHttp(() => json({ result: confirmed }));
        const service = newService();
        const search = vi.spyOn((service as any).cacheSearch, "clear");
        const bookmarks = vi.spyOn((service as any).cacheBookmarks, "clear");
        const result =
          operation === "rename"
            ? await service.renameTag(0, "a", "fresh")
            : operation === "merge"
              ? await service.mergeTags(0, ["a", "b"], "target")
              : await service.deleteTags(0, ["a"]);
        expect(result).toBe(confirmed);
        expect(search).toHaveBeenCalledTimes(confirmed ? 1 : 0);
        expect(bookmarks).toHaveBeenCalledTimes(confirmed ? 1 : 0);
      }
    },
  );

  it.each(["network", "500", "malformed", "missing", "truthy", "429"])(
    "never replays %s after dispatch",
    async (failure) => {
      const fetch = mockHttp(() => {
        if (failure === "network") throw new TypeError("connection lost");
        if (failure === "500") return new Response("error", { status: 500 });
        if (failure === "429")
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "1" },
          });
        if (failure === "malformed")
          return new Response("{", {
            headers: { "content-type": "application/json" },
          });
        return json(failure === "truthy" ? { result: "true" } : {});
      });
      const service = new RaindropService({
        accessToken: "test",
        maxReadRetries: 3,
      });
      const clear = vi.spyOn((service as any).cacheSearch, "clear");
      await expect(service.deleteTags(0, ["a"])).rejects.toMatchObject({
        code: failure === "429" ? "RATE_LIMITED" : "UNKNOWN_WRITE_RESULT",
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(clear).not.toHaveBeenCalled();
    },
  );

  it("does not dispatch a write after failed 429 preflight", async () => {
    const fetch = vi.fn(
      async () => new Response("rate limited", { status: 429 }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(newService().renameTag(0, "a", "fresh")).rejects.toMatchObject(
      { code: "RATE_LIMITED" },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("highlight write retry safety", () => {
  const existing = { _id: "string-id", text: "quote", color: "yellow" };
  const snapshot = { result: true, item: { _id: 42, highlights: [existing] } };
  it.each(["create", "update", "delete"] as const)(
    "dispatches %s once and distinguishes ambiguous and explicit failures",
    async operation => {
      for (const failure of ["network", "500", "malformed", "missing", "false", "403", "404", "429", "401"]) {
        const fetch = vi.fn(async (request: Request) => {
          if (request.method === "GET") return json(snapshot);
          if (failure === "network") throw new TypeError("connection lost after dispatch");
          if (failure === "malformed") return new Response("{");
          if (failure === "missing") return json({ result: true });
          if (failure === "false") return json({ result: false });
          return new Response("failure", { status: Number(failure), headers: { "retry-after": "1" } });
        });
        vi.stubGlobal("fetch", fetch);
        const service = new RaindropService({ accessToken: "mock-only", maxReadRetries: 3 });
        const clear = vi.spyOn((service as any).cacheSearch, "clear");
        const invalidate = vi.spyOn((service as any).cacheBookmarks, "delete");
        const result = operation === "create" ? service.createHighlight(42, { text: "new" })
          : operation === "update" ? service.updateHighlight(42, existing._id, { note: "new" })
          : service.deleteHighlight(42, existing._id);
        const code = failure === "403" || failure === "401" ? "AUTH_ERROR"
          : failure === "404" ? "NOT_FOUND" : failure === "429" ? "RATE_LIMITED"
          : failure === "false" ? "UPSTREAM_ERROR" : undefined;
        if (code) await expect(result).rejects.toMatchObject({ code });
        else await expect(result).resolves.toMatchObject({ status: "unknown", bookmarkId: 42 });
        expect(fetch.mock.calls.map(([r]) => r.method)).toEqual(["GET", "PUT"]);
        // Even an ambiguous PUT may have committed; no stale reads afterward.
        expect(clear).toHaveBeenCalledOnce();
        expect(invalidate).toHaveBeenCalledExactlyOnceWith("id:42");
      }
    },
  );

  it.each([401, 403, 404, 429])("never writes after %s preflight, or retries permission/not-found failures", async status => {
    const fetch = vi.fn(async () => new Response("denied", { status, headers: { "retry-after": "60" } }));
    vi.stubGlobal("fetch", fetch);
    const service = new RaindropService({ accessToken: "mock-only", maxReadRetries: 3 });
    await expect(service.deleteHighlight(42, existing._id)).rejects.toMatchObject({
      code: status === 401 || status === 403 ? "AUTH_ERROR" : status === 404 ? "NOT_FOUND" : "RATE_LIMITED",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Official collection mutation acknowledgments", () => {
  afterEach(() => vi.unstubAllGlobals());

  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" },
  });

  it.each([
    ["result:false with item", { result: false, item: { _id: 42, title: "Disposable" } }],
    ["missing success field", { item: { _id: 42, title: "Disposable" } }],
    ["invalid collection ID", { result: true, item: { _id: 0, title: "Disposable" } }],
  ])("rejects collection_create %s without claiming success", async (_label, response) => {
    const fetch = vi.fn(async (_request: Request) => json(response));
    vi.stubGlobal("fetch", fetch);
    const service = new RaindropService({ accessToken: "test-token", maxReadRetries: 3 });
    await expect(service.createCollection("Disposable")).rejects.toThrow(/could not be verified/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0].method).toBe("POST");
  });

  it.each([
    ["result:false with item", { result: false, item: { _id: 42, title: "Renamed" } }],
    ["mismatched collection ID", { result: true, item: { _id: 43, title: "Renamed" } }],
    ["stale field in response", { result: true, item: { _id: 42, title: "Old name" } }],
  ])("rejects collection_update %s without claiming success", async (_label, response) => {
    const fetch = vi.fn(async (_request: Request) => json(response));
    vi.stubGlobal("fetch", fetch);
    const service = new RaindropService({ accessToken: "test-token", maxReadRetries: 3 });
    await expect(service.updateCollection(42, { title: "Renamed" })).rejects.toThrow(/not confirmed|could not be verified/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0].method).toBe("PUT");
  });

  it("accepts an identity-matched collection update with result:true", async () => {
    const fetch = vi.fn(async () => json({ result: true, item: { _id: 42, title: "Renamed" } }));
    vi.stubGlobal("fetch", fetch);
    const service = new RaindropService({ accessToken: "test-token", maxReadRetries: 0 });
    await expect(service.updateCollection(42, { title: "Renamed" })).resolves.toMatchObject({ _id: 42, title: "Renamed" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
