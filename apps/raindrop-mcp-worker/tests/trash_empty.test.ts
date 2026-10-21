import { afterEach, describe, expect, it, vi } from "vitest";
import RaindropService from "../src/services/raindrop.service.js";
import type { TrashEmptyOutcome } from "../src/types/trash.schemas.js";

const json = (value: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
function fixture(total = 3, retries = 0) {
  const state = {
    ids: Array.from({ length: total }, (_, i) => total - i),
    writes: [] as Request[],
    override: undefined as undefined | ((r: Request) => Response | undefined),
  };
  const fetch = vi.fn(async (req: Request) => {
    const url = new URL(req.url);
    if (req.method !== "GET") {
      state.writes.push(req);
      expect(req.method).toBe("DELETE");
      expect(url.pathname).toBe("/rest/v1/collection/-99");
      expect(await req.clone().text()).toBe("");
    } else {
      expect(url.pathname).toBe("/rest/v1/raindrops/-99");
      expect(url.searchParams.get("perpage")).toBe("50");
      expect(url.searchParams.get("nested")).toBe("false");
    }
    const overridden = state.override?.(req);
    if (overridden) return overridden;
    if (req.method === "DELETE") return json({ result: true });
    const page = Number(url.searchParams.get("page"));
    return json({
      result: true,
      count: state.ids.length,
      items: state.ids
        .slice(page * 50, (page + 1) * 50)
        .map((_id) => ({ _id })),
    });
  });
  vi.stubGlobal("fetch", fetch);
  const service = () =>
    new RaindropService({ accessToken: "mock-only", maxReadRetries: retries });
  return { state, fetch, service };
}
function confirmation(p: TrashEmptyOutcome) {
  return {
    confirm: true as const,
    collectionId: -99 as const,
    expectedTotal: p.total!,
    digest: p.digest!,
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("T09 complete Trash preview and irreversible empty", () => {
  it.each([0, 1, 50, 51, 103, 2900])(
    "enumerates and sorts all %i IDs including terminal page, confirms once or skips empty",
    async (total) => {
      const f = fixture(total);
      const p = await f.service().emptyTrashPreviewFirst({});
      expect(p).toMatchObject({
        status: "preview",
        collectionId: -99,
        total,
        ids: Array.from({ length: total }, (_, i) => i + 1),
      });
      expect(p.digest).toMatch(/^trash-v1:sha256:[a-f0-9]{64}$/);
      expect(f.state.writes).toHaveLength(0);
      expect(f.fetch).toHaveBeenCalledTimes(Math.ceil(total / 50) + 1);
      const result = await f.service().emptyTrashPreviewFirst(confirmation(p));
      expect(result.status).toBe(total ? "succeeded" : "notExecuted");
      expect(f.state.writes).toHaveLength(total ? 1 : 0);
    },
  );

  it("uses dynamic feasibility: preview fits 60 reads but confirmation cannot reserve its write", async () => {
    const f = fixture(2950);
    const p = await f.service().emptyTrashPreviewFirst({});
    expect(p.status).toBe("preview");
    expect(f.fetch).toHaveBeenCalledTimes(60);
    f.fetch.mockClear();
    const result = await f.service().emptyTrashPreviewFirst(confirmation(p));
    expect(result).toMatchObject({
      status: "notExecuted",
      reason: expect.stringMatching(/budget.*bookmark_delete/),
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.state.writes).toHaveLength(0);
  });

  it("rejects >60 attempt scope immediately after count discovery", async () => {
    const f = fixture(3000);
    expect((await f.service().emptyTrashPreviewFirst({})).status).toBe(
      "notExecuted",
    );
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.state.writes).toHaveLength(0);
  });

  it.each([
    { result: false, count: 3, items: [{ _id: 1 }] },
    { result: true, items: [] },
    { result: true, count: -1, items: [] },
    { result: true, count: Number.MAX_SAFE_INTEGER + 1, items: [] },
    { result: true, count: "3", items: [] },
    { result: true, count: 3, items: [{ _id: 1 }] },
    { result: true, count: 3, items: [{ _id: 1 }, { _id: 1 }, { _id: 3 }] },
    { result: true, count: 1, items: [{ _id: 0 }] },
    { result: true, count: 1, items: [{ _id: Number.MAX_SAFE_INTEGER + 1 }] },
    { result: true, count: 1, items: [{ _id: "1" }] },
    { result: true, count: 0, items: null },
  ])("fails closed for malformed or incomplete list %j", async (data) => {
    const f = fixture();
    f.state.override = () => json(data);
    expect((await f.service().emptyTrashPreviewFirst({})).status).toBe(
      "notExecuted",
    );
    expect(f.state.writes).toHaveLength(0);
  });

  it.each(["drift", "overlap", "terminal", "truncated"])(
    "rejects %s during confirmation without writing",
    async (mode) => {
      const f = fixture(51);
      const p = await f.service().emptyTrashPreviewFirst({});
      f.state.override = (req) => {
        const page = new URL(req.url).searchParams.get("page");
        if (page === "1") {
          if (mode === "drift")
            return json({ result: true, count: 52, items: [{ _id: 1 }] });
          if (mode === "overlap")
            return json({ result: true, count: 51, items: [{ _id: 51 }] });
          if (mode === "truncated")
            return json({ result: true, count: 51, items: [] });
        }
        if (page === "2" && mode === "terminal")
          return json({ result: true, count: 51, items: [{ _id: 99 }] });
        return undefined;
      };
      expect(
        (await f.service().emptyTrashPreviewFirst(confirmation(p))).status,
      ).toBe("notExecuted");
      expect(f.state.writes).toHaveLength(0);
    },
  );

  it("fresh reads bind membership despite equal count and ignore reordering", async () => {
    const f = fixture();
    const api = f.service();
    const p = await api.emptyTrashPreviewFirst({});
    f.state.ids.reverse();
    expect((await api.emptyTrashPreviewFirst({})).digest).toBe(p.digest);
    f.state.ids[0] = 100;
    expect((await api.emptyTrashPreviewFirst(confirmation(p))).status).toBe(
      "notExecuted",
    );
    expect(f.state.writes).toHaveLength(0);
    expect(
      (
        await f
          .service()
          .emptyTrashPreviewFirst({ ...confirmation(p), expectedTotal: 4 })
      ).status,
    ).toBe("notExecuted");
    await expect(api.emptyTrash()).rejects.toThrow(/disabled/);
  });

  it.each([
    400,
    401,
    403,
    404,
    422,
    429,
    500,
    "false",
    "lost",
    "missing",
    "invalid-json",
  ])("classifies write acknowledgement %s without replay", async (ack) => {
    const f = fixture(1, 3);
    const p = await f.service().emptyTrashPreviewFirst({});
    f.state.override = (req) => {
      if (req.method !== "DELETE") return undefined;
      if (ack === "lost") throw new TypeError("Mock lost acknowledgement");
      if (ack === "false") return json({ result: false });
      if (ack === "missing") return json({});
      if (ack === "invalid-json") return new Response("not json");
      if (typeof ack !== "number")
        throw new Error("Unexpected mock acknowledgement");
      return json({ result: false }, ack);
    };
    const result = await f.service().emptyTrashPreviewFirst(confirmation(p));
    expect(result.status).toBe(
      [400, 401, 403, 404, 422, "false"].includes(ack) ? "failed" : "unknown",
    );
    expect(f.state.writes).toHaveLength(1);
    expect(f.fetch).toHaveBeenCalledTimes(5); // preview two, confirm two, write one
    if (result.status === "unknown")
      expect(result.reason).toMatch(/never blindly retry/);
  });

  it("read 429 denies execution; retry consumes the same budget", async () => {
    const f = fixture(1);
    const p = await f.service().emptyTrashPreviewFirst({});
    f.state.override = () => json({}, 429, { "retry-after": "60" });
    expect(
      (await f.service().emptyTrashPreviewFirst(confirmation(p))).status,
    ).toBe("notExecuted");
    expect(f.state.writes).toHaveLength(0);
  });

  it("retries read 429 safely but refuses pagination when retry exhausted remaining capacity", async () => {
    vi.useFakeTimers();
    const f = fixture(2900, 3);
    let denials = 0;
    f.state.override = (req) => {
      if (req.method === "GET" && denials++ < 2)
        return json({}, 429, { "retry-after": "0" });
      return undefined;
    };
    const run = f.service().emptyTrashPreviewFirst({
      confirm: true,
      collectionId: -99,
      expectedTotal: 2900,
      digest: `trash-v1:sha256:${"0".repeat(64)}`,
    });
    await vi.runAllTimersAsync();
    expect((await run).status).toBe("notExecuted");
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.state.writes).toHaveLength(0);
  });

  it("rechecks remaining page/write planning on a mid-scan retry", async () => {
    vi.useFakeTimers();
    const f = fixture(2900, 3);
    f.state.override = (req) =>
      new URL(req.url).searchParams.get("page") === "1"
        ? json({}, 429, { "retry-after": "0" })
        : undefined;
    const run = f.service().emptyTrashPreviewFirst({
      confirm: true,
      collectionId: -99,
      expectedTotal: 2900,
      digest: `trash-v1:sha256:${"0".repeat(64)}`,
    });
    await vi.runAllTimersAsync();
    expect(await run).toMatchObject({
      status: "notExecuted",
      reason: expect.stringMatching(/budget/),
    });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.state.writes).toHaveLength(0);
  });

  it("successfully retries a read 429 and performs one write", async () => {
    vi.useFakeTimers();
    const f = fixture(1, 3);
    const p = await f.service().emptyTrashPreviewFirst({});
    let denied = false;
    f.state.override = (req) => {
      if (req.method === "GET" && !denied) {
        denied = true;
        return json({}, 429, { "retry-after": "0" });
      }
      return undefined;
    };
    const run = f.service().emptyTrashPreviewFirst(confirmation(p));
    await vi.runAllTimersAsync();
    expect((await run).status).toBe("succeeded");
    expect(f.state.writes).toHaveLength(1);
  });
});
