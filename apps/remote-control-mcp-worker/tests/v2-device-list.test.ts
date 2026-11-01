import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import worker, { V2OwnerCoordinator } from "../src/worker.ts";

test("list_devices requires Portal bearer and reports only current, approved WSS devices", async () => {
  const onlineId = randomUUID(), staleId = randomUUID(), offlineId = randomUUID(), revokedId = randomUUID();
  const rows = new Map<string, unknown>();
  for (const [id, name, revoked] of [
    [onlineId, "home", false], [staleId, "stale", false],
    [offlineId, "office", false], [revokedId, "retired", true],
  ] as const) {
    rows.set("device:" + id, {
      device_id: id, name, revoked, public_key: "private-public-key",
      fingerprint: "f".repeat(24), approved_at: Date.now(),
      last_verified_online_at: Date.now(), idle_window_ms: 14 * 86_400_000,
    });
  }
  rows.set("session:epoch:" + onlineId, "new-epoch");
  rows.set("session:epoch:" + staleId, "new-epoch");
  const socket = (id: string, epoch: string): WebSocket => ({
    readyState: WebSocket.OPEN,
    deserializeAttachment() { return { device_id: id, epoch, last_auth_check_at: Date.now() - 1_000 }; },
  }) as unknown as WebSocket;
  const sockets = new Map([
    ["device:" + onlineId, [socket(onlineId, "old-epoch"), socket(onlineId, "new-epoch")]],
    ["device:" + staleId, [socket(staleId, "old-epoch")]],
    ["device:" + revokedId, [socket(revokedId, "any")]],
  ]);
  let deviceReads = 0;
  const storage = {
    async delete(key: string) { return rows.delete(key); },
    async get<T>(key: string) { deviceReads++; return rows.get(key) as T | undefined; },
    async list<T>({ prefix, limit }: { prefix: string; limit: number }) {
      return new Map([...rows].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) as Map<string, T>;
    },
  };
  const state = {
    storage,
    getWebSockets: (tag: string) => sockets.get(tag) ?? [],
  } as unknown as DurableObjectState;
  const owner = new V2OwnerCoordinator(state);
  let forwarded = 0;
  const V2_OWNER = {
    idFromName() { return "single-owner"; },
    get() {
      return {
        fetch(input: RequestInfo | URL, init?: RequestInit) {
          forwarded++;
          return owner.fetch(input instanceof Request ? input : new Request(input, init));
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  const env = {
    MCP_ACCESS_TOKEN: "owner-only",
    REMOTE_CONTROL_DEVICE_TOKEN: "v1-only",
    V2_OWNER,
  } as Env & { V2_OWNER: DurableObjectNamespace };
  const rpc = (name: string, args: unknown = {}, token = "owner-only") => worker.fetch(
    new Request("https://host.test/mcp", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name, arguments: args } }),
    }), env,
  );
  assert.equal((await rpc("list_devices", {}, "incorrect")).status, 401);
  assert.equal(forwarded, 0);
  const listed = await rpc("list_devices");
  assert.equal(listed.status, 200);
  const payload = await listed.json() as { result: { content: Array<{ text: string }> } };
  const devices = JSON.parse(payload.result.content[0]!.text) as Array<{
    device_id: string; name: string; status: string;
  }>;
  const publicDevices = devices.map(({ idle_expires_at, ...device }: {idle_expires_at?: number;[key:string]:unknown}) => device);
  assert.deepEqual(publicDevices, [
    { device_id: onlineId, name: "home", status: "online", grant_type: "permanent" },
    { device_id: staleId, name: "stale", status: "offline", grant_type: "permanent" },
    { device_id: offlineId, name: "office", status: "offline", grant_type: "permanent" },
  ].sort((a, b) => a.device_id.localeCompare(b.device_id)));
  assert.equal(payload.result.content[0]!.text.includes("private-public-key"), false);
  assert.equal(devices.some(d => d.device_id === revokedId && d.status === "online"), false);
  assert.equal(forwarded, 1);
  const before = deviceReads;
  const bad = await rpc("list_devices", { device_id: onlineId });
  assert.equal((await bad.json() as {result:{isError:boolean}}).result.isError, true);
  assert.equal(deviceReads, before, "unexpected list arguments must be rejected before any DO I/O");

  const tools = await worker.fetch(new Request("https://host.test/mcp", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer owner-only" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list" }),
  }), env);
  assert.equal((await tools.json() as {result:{tools:Array<{name:string}>}}).result.tools.some(t=>t.name==="list_devices"),true);
});

test("silent network partition makes an OPEN socket offline after the server auth lease", async () => {
  const id = randomUUID();
  const rows = new Map<string, unknown>([
    ["device:" + id, { device_id: id, name: "partitioned", revoked: false,
      last_verified_online_at: Date.now(), idle_window_ms: 14 * 86_400_000 }],
    ["session:epoch:" + id, "epoch-1"],
  ]);
  let lastAuth: number | undefined = Date.now();
  const fakeSocket = {
    readyState: WebSocket.OPEN, // Blackholed transport: no close event arrives.
    deserializeAttachment: () => ({ device_id: id, epoch: "epoch-1", last_auth_check_at: lastAuth }),
  };
  const owner = new V2OwnerCoordinator({
    storage: {
      get: async (key: string) => rows.get(key),
      list: async ({ prefix }: { prefix: string }) => new Map([...rows].filter(([key]) => key.startsWith(prefix))),
    },
    getWebSockets: () => [fakeSocket],
  } as unknown as DurableObjectState);
  const status = async () => {
    // Model an actual trusted checkpoint, not an unauthenticated attachment timestamp.
    const row = rows.get("device:" + id) as object;
    rows.set("device:" + id, { ...row,
      last_verified_online_at: typeof lastAuth === "number" && lastAuth <= Date.now()
        ? lastAuth : Date.now() - 17 * 60_000 });
    const response = await owner.fetch(new Request("https://v2.internal/devices", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }));
    assert.equal(response.status, 200);
    const entries = await response.json() as Array<{ status: string }>;
    return entries[0]?.status;
  };
  assert.equal(await status(), "online", "fresh signed session should be selectable");
  lastAuth = Date.now() - 15 * 60_000;
  assert.equal(await status(), "online", "the existing 15-minute auth probe has room to refresh");
  lastAuth = Date.now() - 17 * 60_000;
  assert.equal(await status(), "offline", "stale OPEN socket must not remain indefinitely online");
  lastAuth = Date.now() + 60_000;
  assert.equal(await status(), "offline", "future/corrupt timestamps must fail closed");
  lastAuth = undefined;
  assert.equal(await status(), "offline", "old attachments without a verified timestamp fail closed");
  lastAuth = Date.now();
  assert.equal(await status(), "online", "a fresh authenticated epoch can recover without re-pairing");
});

test("v2 Preview lists per-device Shell and files but never implicitly routes to v1", async () => {
  let v1Requests = 0;
  const v2Stub = {
    fetch: async () => Response.json([]),
  };
  const env = {
    MCP_ACCESS_TOKEN: "preview-owner-token",
    REMOTE_CONTROL_V2_PREVIEW_ONLY: "true",
    V2_OWNER: { idFromName: () => "preview-owner", get: () => v2Stub },
    REMOTE_CONTROL_DEVICE: { fetch: () => { v1Requests++; throw new Error("v1 transport must not be used"); } },
    REMOTE_CONTROL_DEVICE_TOKEN: "v1-not-used",
  } as unknown as Env;
  const rpc = (method: string, params?: unknown) => worker.fetch(new Request("https://preview.test/mcp", {
    method: "POST", headers: { "authorization": "Bearer preview-owner-token", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 51, method, ...(params ? { params } : {}) }),
  }), env);

  const list = await (await rpc("tools/list")).json() as { result: { tools: Array<{
    name: string; inputSchema: { required?: string[] };
  }> } };
  const exposed = new Set(list.result.tools.map(x => x.name));
  for (const supported of ["run_command", "write_file", "delete_file", "move_file",
      "create_directory", "replace_text", "list_sessions", "read_session_output", "stop_session", "send_input"]) {
    assert.equal(exposed.has(supported), true, supported);
  }
  for (const item of list.result.tools.filter(x => !["pairing_lookup", "pairing_approve", "list_devices", "revoke_device"].includes(x.name))) {
    assert.ok(item.inputSchema.required?.includes("device_id"), item.name);
  }
  for (const [name, args] of [
    ["read_file", { path: "/tmp/test" }],
    ["run_command", { operation_id: "safe-1", command: "date" }],
    ["write_file", { operation_id: "safe-2", path: "/tmp/denied", content: "x" }],
  ] as const) {
    const response = await rpc("tools/call", { name, arguments: args });
    const body = await response.json() as { result: { isError: boolean } };
    assert.equal(body.result.isError, true, name);
  }
  assert.equal(v1Requests, 0);
  const read = await rpc("tools/call", { name: "read_file", arguments: { device_id: randomUUID(), path: "/tmp/test" } });
  assert.equal(read.status, 200);
  assert.equal(v1Requests, 0);
  assert.equal((await rpc("tools/call", { name: "list_devices", arguments: {} })).status, 200);
});
test("preview lacks owner secret => even Agent bootstrap is blocked before any DO request", async () => {
  let calls = 0;
  const env = {
    REMOTE_CONTROL_V2_PREVIEW_ONLY: "true",
    MCP_ACCESS_TOKEN: undefined,
    V2_OWNER: { idFromName: () => "isolated-preview", get: () => ({ fetch: () => {
      calls++; throw new Error("preview should remain disabled");
    } }) },
  } as unknown as Env;
  for (const uri of ["/mcp", "/agent/pair/start", "/agent/session/challenge",
      "/agent/session/recover", "/agent/pair/complete", "/agent/connect/" + randomUUID()]) {
    const res = await worker.fetch(new Request("https://preview.test" + uri, { method: "POST" }), env);
    assert.equal(res.status, 503, uri);
    assert.equal((await res.json() as { error: string }).error, "preview_unconfigured");
  }
  assert.equal(calls, 0);
});

test("device enumeration is bounded and fails closed when the small-owner limit is exceeded", async () => {
  const rows = new Map<string, unknown>();
  for (let i = 0; i < 65; i++) {
    const id = `12345678-1234-4123-8123-${i.toString(16).padStart(12, "0")}`;
    rows.set("device:" + id, {
      device_id: id, name: "test-device", revoked: false, public_key: "unavailable",
      last_verified_online_at: Date.now(), idle_window_ms: 14 * 86_400_000,
    });
  }
  const owner = new V2OwnerCoordinator({
    storage: {
      list: async <T>({ prefix, limit }: { prefix: string; limit: number }) =>
        new Map([...rows].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) as Map<string, T>,
    },
    getWebSockets: () => { assert.fail("Over-capacity listing must not inspect sockets"); },
  } as unknown as DurableObjectState);
  const result = await owner.fetch(new Request("https://v2.internal/devices", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }));
  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { error: "capacity" });
});

test("device status fails closed for corrupt Hibernation attachment", async () => {
  const id = randomUUID();
  const owner = new V2OwnerCoordinator({
    storage: {
      list: async () => new Map([["device:" + id, {
        device_id: id, name: "damaged", revoked: false,
        last_verified_online_at: Date.now(), idle_window_ms: 14 * 86_400_000,
      }]]),
      get: async () => "fresh",
    },
    getWebSockets: () => [{
      deserializeAttachment: () => { throw new Error("attachment unavailable"); },
    }],
  } as unknown as DurableObjectState);
  const response = await owner.fetch(new Request("https://v2.internal/devices", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as Array<{idle_expires_at?: number}>).map(({idle_expires_at,...d})=>d), [{ device_id: id, name: "damaged", status: "offline", grant_type: "permanent" }]);
});

test("WSL2 distro shutdown is offline after WSS close; restored signed epoch can come online again", async () => {
  const id = randomUUID(), other = randomUUID();
  const stateRows = new Map<string, unknown>([
    ["device:" + id, { device_id: id, name: "wsl2", revoked: false, last_verified_online_at: Date.now(), idle_window_ms: 14 * 86_400_000 }],
    ["device:" + other, { device_id: other, name: "linux", revoked: false, last_verified_online_at: Date.now(), idle_window_ms: 14 * 86_400_000 }],
    ["session:epoch:" + id, "wsl-epoch-1"],
    ["session:epoch:" + other, "linux-epoch"],
  ]);
  let wslReady: number = WebSocket.OPEN;
  const wslSocket = (epoch: string) => ({
    get readyState() { return wslReady; },
    deserializeAttachment: () => ({ device_id: id, epoch, last_auth_check_at: Date.now() - 1_000 }),
  }) as unknown as WebSocket;
  const nativeSocket = ({
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({ device_id: other, epoch: "linux-epoch", last_auth_check_at: Date.now() - 1_000 }),
  }) as unknown as WebSocket;
  const sockets = new Map<string, WebSocket[]>([
    ["device:" + id, [wslSocket("wsl-epoch-1")]],
    ["device:" + other, [nativeSocket]],
  ]);
  const owner = new V2OwnerCoordinator({
    storage: {
      get: async <T>(key: string) => stateRows.get(key) as T | undefined,
      list: async <T>({ prefix, limit }: { prefix: string; limit: number }) =>
        new Map([...stateRows].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) as Map<string, T>,
    },
    getWebSockets: (tag: string) => sockets.get(tag) ?? [],
  } as unknown as DurableObjectState);
  const statuses = async () => {
    const answer = await owner.fetch(new Request("https://v2.internal/devices", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }));
    assert.equal(answer.status, 200);
    return new Map((await answer.json() as Array<{ device_id: string; status: string }>)
      .map(device => [device.device_id, device.status]));
  };
  assert.equal((await statuses()).get(id), "online");
  wslReady = WebSocket.CLOSED; // WSL distro stopped; owner observed socket closure
  assert.equal((await statuses()).get(id), "offline");
  assert.equal((await statuses()).get(other), "online", "unrelated host remains available");
  const denied = await owner.fetch(new Request("https://v2.internal/read", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: id, tool: "read_file", arguments: { path: "/tmp/fixture" } }),
  }));
  assert.equal(denied.status, 503, "no commands queue while WSL2 is stopped");
  stateRows.set("session:epoch:" + id, "wsl-epoch-2");
  sockets.set("device:" + id, [wslSocket("wsl-epoch-1")]);
  wslReady = WebSocket.OPEN;
  assert.equal((await statuses()).get(id), "offline", "stale socket is never proof of WSL recovery");
  sockets.set("device:" + id, [wslSocket("wsl-epoch-2")]);
  assert.equal((await statuses()).get(id), "online", "new signed WSS epoch restores availability");
});
