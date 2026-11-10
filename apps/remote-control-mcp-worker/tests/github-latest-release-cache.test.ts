import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.ts";
import { readLatestAgentRelease } from "../src/github-latest-agent-release.ts";

const origin = "https://rca.lirtual.dpdns.org";
const tag = "v0.4.0";
const targets = [
  ["linux-x64-glibc", "tar.gz"], ["linux-arm64-glibc", "tar.gz"],
  ["windows-x64", "zip"], ["darwin-arm64", "tar.gz"], ["darwin-x64", "tar.gz"],
] as const;

function release(patch: Record<string, unknown> = {}) {
  return {
    tag_name: tag, draft: false, prerelease: false, immutable: true,
    html_url: `https://github.com/lirtual/mcp-workers/releases/tag/${tag}`,
    body: "untrusted upstream release notes",
    assets: targets.map(([target, ext]) => {
      const name = `remote-control-agent-${tag}-${target}.${ext}`;
      return {
        name, state: "uploaded", size: 1024, digest: "sha256:" + "ae".repeat(32),
        browser_download_url: `https://github.com/lirtual/mcp-workers/releases/download/${tag}/${name}`,
      };
    }), ...patch,
  };
}

function fixture() {
  const values = new Map<string, Response>();
  let writes = 0;
  const cache = {
    match: async (request: Request) => values.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => { writes++; values.set(request.url, response.clone()); },
  } as unknown as Pick<Cache, "match" | "put">;
  return { cache, values, get writes() { return writes; } };
}

test("shared validated snapshot serves Linux and macOS with one upstream request", async () => {
  const shared = fixture();
  let calls = 0;
  const env = {
    MCP_ACCESS_TOKEN: "owner-only", REMOTE_CONTROL_INSTALL_ORIGIN: origin,
    DEVICE_COORDINATOR: { idFromName: () => "single-owner-v2", get: () => ({}) },
    AGENT_RELEASE_CACHE: shared.cache,
    AGENT_RELEASE_FETCH: async () => { calls++; return Response.json(release()); },
  } as unknown as Env;
  const linux = await worker.fetch(new Request(origin + "/install.sh"), env);
  const mac = await worker.fetch(new Request(origin + "/install-macos.sh"), env);
  assert.equal(linux.status, 200);
  assert.equal(mac.status, 200);
  assert.equal(calls, 1);
  assert.equal(shared.writes, 1);
  assert.equal(linux.headers.get("cache-control"), "no-store");
  assert.equal(mac.headers.get("cache-control"), "no-store");
  assert.match(await linux.text(), /v0\.4\.0-linux-x64-glibc/);
  assert.match(await mac.text(), /v0\.4\.0-darwin-arm64/);
  const stored = [...shared.values.values()][0];
  assert.ok(stored);
  assert.equal(stored.headers.get("cache-control"), "public, max-age=300");
  assert.doesNotMatch(await stored.clone().text(), /untrusted upstream release notes/);
});

test("cache is valid before but never at or after 300s and errors do not extend it", async () => {
  const shared = fixture();
  let tick = 1_700_000_000_000, status = 200, calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return status === 200 ? Response.json(release()) :
      new Response("limited", { status: 429, headers: { "retry-after": "15" } });
  };
  const now = () => tick;
  assert.equal((await readLatestAgentRelease(fetcher, shared.cache, now)).ok, true);
  status = 429;
  tick += 299_999;
  assert.equal((await readLatestAgentRelease(fetcher, shared.cache, now)).ok, true);
  assert.equal(calls, 1);
  tick += 1;
  assert.deepEqual(await readLatestAgentRelease(fetcher, shared.cache, now),
    { ok: false, stop: "rate_limited", retryAfter: "15" });
  assert.equal(calls, 2);
  assert.equal(shared.writes, 1);
});

test("403, 429, mutable or incomplete release never populates cache", async () => {
  const shared = fixture();
  for (const response of [
    new Response("forbidden", { status: 403 }),
    new Response("limited", { status: 429 }),
    Response.json(release({ immutable: false })),
    Response.json(release({ assets: [] })),
  ]) {
    assert.equal((await readLatestAgentRelease(async () => response.clone(), shared.cache)).ok, false);
  }
  assert.equal(shared.writes, 0);
  assert.equal(shared.values.size, 0);
});

test("corrupt/future cached data is never trusted and no stale fallback on 403", async () => {
  const shared = fixture();
  let tick = 1_700_000_000_000;
  const now = () => tick;
  await readLatestAgentRelease(async () => Response.json(release()), shared.cache, now);
  const [key, stored] = [...shared.values.entries()][0]!;
  const bad = JSON.parse(await stored.clone().text()) as { assets: unknown[] };
  bad.assets = [];
  shared.values.set(key, new Response(JSON.stringify(bad), {
    headers: { "x-rca-validated-at": String(tick), "cache-control": "public,max-age=300" },
  }));
  let calls = 0;
  const denied: typeof fetch = async () => { calls++; return new Response("forbidden", { status: 403 }); };
  assert.deepEqual(await readLatestAgentRelease(denied, shared.cache, now), { ok: false, stop: "forbidden" });
  shared.values.set(key, new Response(await stored.clone().text(), {
    headers: { "x-rca-validated-at": String(tick + 1000), "cache-control": "public,max-age=300" },
  }));
  assert.deepEqual(await readLatestAgentRelease(denied, shared.cache, now), { ok: false, stop: "forbidden" });
  tick += 301_000;
  assert.deepEqual(await readLatestAgentRelease(denied, shared.cache, now), { ok: false, stop: "forbidden" });
  assert.equal(calls, 3);
});

test("unavailable cache read/write does not break live success or fail-closed lookup", async () => {
  const failing = {
    match: async () => { throw new Error("cache read error"); },
    put: async () => { throw new Error("cache write error"); },
  } as unknown as Pick<Cache, "match" | "put">;
  assert.equal((await readLatestAgentRelease(async () => Response.json(release()), failing)).ok, true);
  assert.deepEqual(await readLatestAgentRelease(async () => new Response("429", { status: 429 }), failing),
    { ok: false, stop: "rate_limited" });
});
