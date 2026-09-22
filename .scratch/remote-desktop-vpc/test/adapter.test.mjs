// #178: deterministic transport contract only. The binding is MOCKED, not real VPC.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapter } from "../http-adapter.mjs";
import probe from "../vpc-probe-worker.mjs";

const token = "local-ci-only-adapter-token-at-least-24";
const clientToken = "local-ci-only-client-token-at-least-24";
const origin = "https://probe.example.invalid";
const body = (tool = "sandbox_ping", args = {}) => JSON.stringify({ tool, arguments: args });

async function start(options = {}) {
  const server = createAdapter({ token, fixedRoot: "/fixed-only", ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: "http://127.0.0.1:" + server.address().port + "/invoke" };
}
async function send(url, data, options = {}) {
  return fetch(url, { method: "POST", headers: {
    "authorization": "Bearer " + token, "content-type": "application/json", ...options.headers,
  }, body: data });
}
async function stop(server) { await new Promise((resolve) => server.close(resolve)); }

test("adapter: ping, fixed-root read, forbidden paths/tools, invalid body, token and size", async () => {
  const { server, url } = await start({ execute: async (root) => {
    assert.equal(root, "/fixed-only");
    return { source: "test-only", text: "proof-only.txt" };
  } });
  try {
    const ping = await send(url, body());
    assert.equal(ping.status, 200);
    assert.equal((await ping.json()).result.text, "pong");
    const directory = await send(url, body("sandbox_list_directory"));
    assert.equal(directory.status, 200);
    assert.equal((await directory.json()).result.text, "proof-only.txt");
    for (const value of [body("execute_command"), body("sandbox_list_directory", { path: "/etc" }),
      body("sandbox_list_directory", { extra: true }), JSON.stringify({ tool: "sandbox_ping" })]) {
      const res = await send(url, value);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, "forbidden_request");
    }
    assert.equal((await send(url, "{bad-json")).status, 400);
    assert.equal((await send(url, body(), { headers: { authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await send(url, body(), { headers: { "content-type": "text/plain" } })).status, 415);
    const huge = await send(url, body("sandbox_ping", { extra: "界".repeat(3000) }));
    assert.equal(huge.status, 413);
  } finally { await stop(server); }
});
test("adapter: sanitized upstream errors, result cap and timeout", async () => {
  const unavailable = await start({ execute: async () => { throw new Error("secret path: /home/user"); } });
  try {
    const res = await send(unavailable.url, body("sandbox_list_directory"));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "upstream_unavailable" });
  } finally { await stop(unavailable.server); }
  const big = await start({ execute: async () => ({ text: "x".repeat(9000) }) });
  try { assert.equal((await send(big.url, body("sandbox_list_directory"))).status, 502); }
  finally { await stop(big.server); }
  const timeout = await start({ execute: async () => new Promise(() => {}), timeoutMs: 15 });
  try { assert.equal((await send(timeout.url, body("sandbox_list_directory"))).status, 504); }
  finally { await stop(timeout.server); }
});
test("Worker mocked VPC binding: positive call, reject client, offline and malformed", async () => {
  const { server, url } = await start();
  const env = {
    PROTOTYPE_ALLOWED_ORIGIN: origin,
    PROTOTYPE_CLIENT_TOKEN: clientToken,
    PROTOTYPE_ADAPTER_TOKEN: token,
    PRIVATE_DEVICE: { fetch: (_url, init) => fetch(url, init) }, // local mock, NOT hosted VPC
  };
  async function invoke(value = body(), headers = {}) {
    return probe.fetch(new Request(origin + "/_probe/invoke", {
      method: "POST", body: value,
      headers: { authorization: "Bearer " + clientToken, "content-type": "application/json", ...headers },
    }), env);
  }
  try {
    const ok = await invoke();
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).result.text, "pong");
    assert.equal((await invoke(body(), { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await invoke(body(), { origin: "https://attacker.invalid" })).status, 403);
    assert.equal((await invoke(body("execute_command"))).status, 400);
    assert.equal((await invoke(body("sandbox_list_directory", { path: "/etc" }))).status, 400);
    assert.equal((await invoke("{malformed")).status, 400);
    assert.equal((await invoke(body("sandbox_ping", { extra: "界".repeat(3000) }))).status, 413);
    env.PRIVATE_DEVICE = { fetch: async () => { throw new Error("do-not-expose-private-host"); } };
    const failed = await invoke();
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: "private_device_unavailable" });
    env.PRIVATE_DEVICE = { fetch: async () => new Response("x".repeat(9000)) };
    const oversized = await invoke();
    assert.equal(oversized.status, 502);
    assert.deepEqual(await oversized.json(), { error: "upstream_result_too_large" });
    env.PRIVATE_DEVICE = { fetch: (_url, init) => fetch(url, init) };
    const recovered = await invoke();
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).result.text, "pong");
  } finally { await stop(server); }
});
test("CI ONLY: mocked VPC fetch → loopback adapter → real pinned isolated stdio read", {
  skip: process.env.RUN_REAL_UPSTREAM !== "1" ? "Requires explicit isolated Docker CI" : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "vpc-readonly-"));
  await chmod(root, 0o755);
  await writeFile(join(root, "proof-only.txt"), "test fixture\n", { mode: 0o644 });
  const { server, url } = await start({ fixedRoot: root });
  const env = {
    PROTOTYPE_ALLOWED_ORIGIN: origin, PROTOTYPE_CLIENT_TOKEN: clientToken,
    PROTOTYPE_ADAPTER_TOKEN: token,
    PRIVATE_DEVICE: { fetch: (_url, init) => fetch(url, init) }, // NOT Cloudflare VPC
  };
  try {
    const res = await probe.fetch(new Request(origin + "/_probe/invoke", {
      method: "POST", headers: { authorization: "Bearer " + clientToken,
        "content-type": "application/json" }, body: body("sandbox_list_directory"),
    }), env);
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.result.source, "desktop-commander-0.2.51");
    assert.ok(result.result.text.includes("proof-only.txt"));
    const forbidden = await probe.fetch(new Request(origin + "/_probe/invoke", {
      method: "POST", headers: { authorization: "Bearer " + clientToken,
        "content-type": "application/json" },
      body: body("sandbox_list_directory", { path: "/etc" }),
    }), env);
    assert.equal(forbidden.status, 400);
  } finally {
    await stop(server);
    await rm(root, { recursive: true, force: true });
  }
});
