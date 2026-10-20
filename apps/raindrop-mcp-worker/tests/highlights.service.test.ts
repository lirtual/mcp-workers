import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RaindropService from "../src/services/raindrop.service.js";

const quote = {
  _id: "opaque-id",
  text: "quote",
  note: "note",
  color: "yellow",
  created: "original",
};
const adjacent = {
  _id: "adjacent",
  text: "keep",
  note: "untouched",
  color: "blue",
  custom: { location: 4 },
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const body = (highlights: unknown[] = [quote, adjacent], id = 42) => ({
  result: true,
  item: { _id: id, highlights },
});
const service = () =>
  new RaindropService({ accessToken: "mock-only", maxReadRetries: 0 });
function mock(writeBody: unknown = body(), readBody: unknown = body()) {
  const fetch = vi.fn(async (request: Request) =>
    json(request.method === "GET" ? readBody : writeBody),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unmocked network is forbidden in highlight tests");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("bookmark-scoped highlight Service", () => {
  it("lists via fresh owner-checked GET, accepting empty lists and string IDs", async () => {
    const fetch = mock();
    const svc = service();
    expect(await svc.getHighlights(42)).toEqual([quote, adjacent]);
    expect(await svc.getHighlights(42)).toEqual([quote, adjacent]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![0].url).toBe(
      "https://api.raindrop.io/rest/v1/raindrop/42",
    );
    mock(body([]), body([]));
    expect(await service().getHighlights(42)).toEqual([]);
  });

  it.each(["create", "update", "delete"] as const)(
    "sends only one targeted %s patch, returning the confirmed upstream ID",
    async (operation) => {
      const added = {
        _id: "new-string-id",
        text: "new quote",
        color: "red",
        note: "",
      };
      const updated = { ...quote, note: "" };
      const after =
        operation === "create"
          ? [quote, adjacent, added]
          : operation === "update"
            ? [updated, adjacent]
            : [adjacent];
      const fetch = mock(body(after));
      const svc = service();
      const clear = vi.spyOn((svc as any).cacheSearch, "clear");
      const invalidate = vi.spyOn((svc as any).cacheBookmarks, "delete");
      const result =
        operation === "create"
          ? await svc.createHighlight(42, {
              text: "new quote",
              color: "red",
              note: "",
            })
          : operation === "update"
            ? await svc.updateHighlight(42, quote._id, { note: "" })
            : await svc.deleteHighlight(42, quote._id);
      expect(result).toEqual({
        status: "succeeded",
        bookmarkId: 42,
        highlightId: operation === "create" ? added._id : quote._id,
        highlight:
          operation === "create"
            ? added
            : operation === "update"
              ? updated
              : null,
        deleted: operation === "delete",
      });
      expect(fetch.mock.calls.map(([r]) => r.method)).toEqual(["GET", "PUT"]);
      expect(
        fetch.mock.calls.every(([r]) => r.url.endsWith("/raindrop/42")),
      ).toBe(true);
      expect(await fetch.mock.calls[1]![0].json()).toEqual({
        highlights: [
          operation === "create"
            ? { text: "new quote", color: "red", note: "" }
            : operation === "update"
              ? { _id: quote._id, note: "" }
              : { _id: quote._id, text: "" },
        ],
      });
      expect(clear).toHaveBeenCalledOnce();
      expect(invalidate).toHaveBeenCalledExactlyOnceWith("id:42");
    },
  );

  it.each([
    undefined,
    null,
    "42",
    -1,
    0,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects bookmark ID %s for every action before HTTP", async (id) => {
    const fetch = mock();
    const svc = service();
    await expect(svc.getHighlights(id as number)).rejects.toThrow(
      /positive safe integer/,
    );
    await expect(
      svc.createHighlight(id as number, { text: "new" }),
    ).rejects.toThrow();
    await expect(
      svc.updateHighlight(id as number, quote._id, { note: "new" }),
    ).rejects.toThrow();
    await expect(
      svc.deleteHighlight(id as number, quote._id),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves the largest safe bookmark ID exactly", async () => {
    const fetch = mock(
      body([], Number.MAX_SAFE_INTEGER),
      body([], Number.MAX_SAFE_INTEGER),
    );
    await service().getHighlights(Number.MAX_SAFE_INTEGER);
    expect(fetch.mock.calls[0]![0].url).toContain(
      String(Number.MAX_SAFE_INTEGER),
    );
  });

  it.each([undefined, null, 123, "", " ", " id "])(
    "rejects invalid highlight ID %s without HTTP",
    async (id) => {
      const fetch = mock();
      const svc = service();
      await expect(
        svc.updateHighlight(42, id as string, { note: "new" }),
      ).rejects.toThrow();
      await expect(svc.deleteHighlight(42, id as string)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects empty text, invalid colors, extra fields and fieldless updates without HTTP", async () => {
    const fetch = mock();
    const svc = service();
    for (const fields of [
      {},
      { text: "" },
      { text: " " },
      { text: "new", color: "black" },
      { text: "new", _id: "injected" },
      { text: "new", note: 3 },
    ])
      await expect(svc.createHighlight(42, fields as any)).rejects.toThrow();
    for (const fields of [
      {},
      { note: undefined },
      { text: "" },
      { text: " " },
      { color: "black" },
      { other: 1 },
      { note: null },
    ])
      await expect(
        svc.updateHighlight(42, quote._id, fields as any),
      ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["update", "delete"] as const)(
    "refuses %s for a highlight absent from this bookmark",
    async (operation) => {
      const fetch = mock();
      const svc = service();
      await expect(
        operation === "update"
          ? svc.updateHighlight(42, "belongs-to-another-bookmark", {
              note: "new",
            })
          : svc.deleteHighlight(42, "belongs-to-another-bookmark"),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {},
    { result: false, item: { _id: 42, highlights: [] } },
    { result: true },
    body([], 43),
    { result: true, item: { _id: 42 } },
    body([{ _id: 12, text: "bad" }]),
    body([quote, quote]),
    body([{ _id: "id" }]),
  ])(
    "rejects malformed or wrong-owner preflight %j without writing",
    async (response) => {
      const fetch = mock(body(), response);
      await expect(
        service().deleteHighlight(42, quote._id),
      ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["create", "update", "delete"] as const)(
    "does not confirm %s if an adjacent highlight is lost or changed",
    async (operation) => {
      const fetch = mock(
        body([
          { ...quote, note: "new" },
          { ...adjacent, text: "oops" },
        ]),
      );
      const svc = service();
      const clear = vi.spyOn((svc as any).cacheSearch, "clear");
      const result =
        operation === "create"
          ? await svc.createHighlight(42, { text: "new" })
          : operation === "update"
            ? await svc.updateHighlight(42, quote._id, { note: "new" })
            : await svc.deleteHighlight(42, quote._id);
      expect(result.status).toBe("unknown");
      expect(clear).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    {},
    { result: true },
    body([], 43),
    body(),
    body([{ ...quote, note: "wrong" }, adjacent]),
  ])("returns unknown for unconfirmed update response %j", async (response) => {
    mock(response);
    const svc = service();
    const clear = vi.spyOn((svc as any).cacheSearch, "clear");
    const invalidate = vi.spyOn((svc as any).cacheBookmarks, "delete");
    expect(
      await svc.updateHighlight(42, quote._id, { note: "new" }),
    ).toMatchObject({
      status: "unknown",
      bookmarkId: 42,
      highlightId: quote._id,
    });
    expect(clear).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith("id:42");
  });

  it("refreshes a bookmark read after an ambiguous highlighter write", async () => {
    const fetch = mock({});
    const svc = service();
    const initial = await svc.getBookmark(42);
    expect(initial._id).toBe(42);

    const outcome = await svc.updateHighlight(42, quote._id, { note: "new" });
    expect(outcome.status).toBe("unknown");

    // The upstream may have committed even though its response was incomplete.
    // A fresh user read must not reuse the cached pre-write bookmark.
    const after = await svc.getBookmark(42);
    expect(after._id).toBe(42);
    expect(fetch.mock.calls.map(([request]) => request.method))
      .toEqual(["GET", "GET", "PUT", "GET"]);
  });

  it("does not guess the created ID when multiple new highlights match", async () => {
    mock(
      body([
        quote,
        adjacent,
        { _id: "a", text: "new" },
        { _id: "b", text: "new" },
      ]),
    );
    expect(await service().createHighlight(42, { text: "new" })).toMatchObject({
      status: "unknown",
    });
  });

  it("reports explicit result:false as rejection", async () => {
    mock({ result: false });
    const svc = service();
    const clear = vi.spyOn((svc as any).cacheSearch, "clear");
    await expect(svc.deleteHighlight(42, quote._id)).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    expect(clear).toHaveBeenCalledOnce();
  });
});

describe("highlight confirmation details", () => {
  it("bypasses a cached bookmark and verifies text/color patches while retaining notes", async () => {
    // Seed the public read cache with stale membership; highlights must still GET.
    const fetch = mock(
      body([{ ...quote, text: "revised", color: "red" }, adjacent]),
    );
    const svc = service();
    await svc.getBookmark(42);
    const result = await svc.updateHighlight(42, quote._id, {
      text: "revised",
      color: "red",
    });
    expect(result).toMatchObject({
      status: "succeeded",
      highlight: {
        _id: quote._id,
        text: "revised",
        color: "red",
        note: "note",
      },
    });
    expect(fetch.mock.calls.map(([r]) => r.method)).toEqual([
      "GET",
      "GET",
      "PUT",
    ]);
    expect(await fetch.mock.calls[2]![0].json()).toEqual({
      highlights: [{ _id: quote._id, text: "revised", color: "red" }],
    });
  });

  it.each([
    ["create", body([quote, adjacent])],
    ["create", body([adjacent, { _id: "new", text: "new" }])],
    ["create", body([quote, adjacent, { _id: "new", text: "wrong" }])],
    ["update", body([{ ...quote, note: "new" }])],
    ["update", body([{ ...quote, note: "new", text: "unexpected" }, adjacent])],
    ["update", body([{ ...quote, note: "new" }, adjacent], 43)],
    ["delete", body([quote, adjacent])],
    ["delete", body([])],
  ] as const)(
    "returns unknown for unconfirmed %s or lost unaffected fields",
    async (operation, response) => {
      mock(response);
      const svc = service();
      const result =
        operation === "create"
          ? await svc.createHighlight(42, { text: "new" })
          : operation === "update"
            ? await svc.updateHighlight(42, quote._id, { note: "new" })
            : await svc.deleteHighlight(42, quote._id);
      expect(result.status).toBe("unknown");
    },
  );

  it("does not dispatch a write after a failed network preflight", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("offline");
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      service().createHighlight(42, { text: "new" }),
    ).rejects.toThrow("offline");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
