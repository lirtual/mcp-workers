import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import worker from "../src/worker.ts";
import { OwnerCoordinator } from "../src/pairing.ts";
import { TEMPORARY_GRANT_MS } from "../src/session.ts";

test("MCP read_file with explicit device_id routes through DO WSS only to the approved current device", async () => {
  const dir = "/tmp/dispatch-fixture";
  const file = path.join(dir, "marker.txt");
  const a = randomUUID(), b = randomUUID(), unknown = randomUUID();
  const rows = new Map<string, unknown>([
    ["device:" + a, { device_id: a, name: "a", revoked: false, last_verified_online_at: Date.now(), idle_window_ms: 14 * 86_400_000 }],
    ["device:" + b, { device_id: b, name: "b", revoked: false, last_verified_online_at: Date.now(), idle_window_ms: 14 * 86_400_000 }],
    ["session:epoch:" + a, "epoch-a"], ["session:epoch:" + b, "epoch-b"],
  ]);
  const storage = { get: async <T>(key: string) => rows.get(key) as T | undefined };
  let owner!: OwnerCoordinator;
  // Scripted wire replies test Worker routing and public error mapping, not
  // a second file/search executor. Native behavior lives in native_read,
  // native_browse and native_file_wss Rust tests.
  const sentToServer: string[] = [];
  const fromServer: string[] = [];
  const searchId = randomUUID();
  const page = (offset: number) => JSON.stringify({
    session_id: searchId, has_more: true,
    results: Array.from({ length: 20 }, (_, i) => ({ path: `walk-${offset + i}.txt` })),
  });
  const expected = [
    [a, "read_file", { path: file, offset: 0, length: 1 }, { status: "completed", text: "private-A-marker" }],
    [a, "read_multiple_files", { paths: [file] }, { status: "completed", text: "private-A-marker" }],
    [a, "list_directory", { path: dir, depth: 1 }, { status: "completed", text: "file marker.txt" }],
    [a, "get_file_info", { path: file }, { status: "completed", text: "size: 17" }],
    [b, "get_file_info", { path: file }, { status: "completed", text: "size: 29" }],
    [a, "start_search", { path: dir, pattern: "walk-", search_type: "filename" }, { status: "completed", text: page(0) }],
    [b, "get_more_search_results", { session_id: searchId }, { status: "failed" }],
    [a, "get_more_search_results", { session_id: searchId }, { status: "completed", text: page(20) }],
    [a, "stop_search", { session_id: searchId }, { status: "completed", text: '{"stopped":true}' }],
    [a, "list_directory", { path: path.join(dir, "does-not-exist"), depth: 1 }, { status: "failed" }],
    [a, "list_sessions", {}, { status: "failed" }],
    [a, "read_file", { path: path.join(dir, "escaping-budget.txt") }, { status: "failed", error: "result_too_large" }],
    [a, "read_file", { path: path.join(dir, "batch-budget.txt") }, { status: "completed", text: "bounded reply" }],
    [a, "read_multiple_files", { paths: [path.join(dir, "batch-budget.txt"), path.join(dir, "batch-budget.txt")] }, { status: "failed", error: "result_too_large" }],
  ] as const;
  const createSocket = (device_id: string, epoch: string) => {
    const server = {
      readyState: WebSocket.OPEN,
      deserializeAttachment: () => ({ device_id, epoch }),
      send(message: string) {
        const item = expected[fromServer.length];
        fromServer.push(device_id);
        const frame = JSON.parse(message);
        assert.ok(item, "unexpected dispatch");
        const [device, tool, args, reply] = item;
        assert.equal(device_id, device);
        assert.match(frame.request_id, /^[a-f0-9-]{36}$/);
        assert.deepEqual(frame, { kind: "read", request_id: frame.request_id, tool, arguments: args });
        queueMicrotask(() => {
          sentToServer.push(device_id);
          void owner.webSocketMessage(server, JSON.stringify({
            kind: "read_result", request_id: frame.request_id, ...reply,
          }));
        });
      },
      close() { assert.fail("valid fixture reply closed the socket"); },
    } as unknown as WebSocket;
    return server;
  };
  const serverA = createSocket(a, "epoch-a");
  const serverB = createSocket(b, "epoch-b");
  const state = {
    storage,
    getWebSockets(tag: string) {
      return tag === "device:" + a ? [serverA] : tag === "device:" + b ? [serverB] : [];
    },
  } as unknown as DurableObjectState;
  owner = new OwnerCoordinator(state);
  let legacyCalls = 0, doCalls = 0;
  const DEVICE_COORDINATOR = {
    idFromName: () => "only-owner",
    get: () => ({
      fetch(input: RequestInfo | URL, init?: RequestInit) {
        doCalls++;
        return owner.fetch(input instanceof Request ? input : new Request(input, init));
      },
    }),
  } as unknown as DurableObjectNamespace;
  const env = {
    MCP_ACCESS_TOKEN: "portal-test",
    REMOTE_CONTROL_DEVICE_TOKEN: "legacy-v1-test",
    REMOTE_CONTROL_DEVICE: { fetch() { legacyCalls++; throw new Error("v1 must not be used"); } },
    DEVICE_COORDINATOR,
  } as unknown as Env;
  async function callTool(name: string, args: Record<string, unknown>, token = "portal-test") {
    const res = await worker.fetch(new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {
        name, arguments: args,
      } }),
    }), env);
    return { http: res.status, body: await res.text() };
  }
  const call = (device_id: unknown, token = "portal-test") =>
    callTool("read_file", { device_id, path: file, offset: 0, length: 1 }, token);
  {
    const forbidden = await call(a, "wrong");
    assert.equal(forbidden.http, 401);
    assert.equal(doCalls, 0);
    const success = await call(a);
    assert.equal(success.http, 200);
    assert.match(success.body, /private-A-marker/);
    assert.deepEqual(fromServer, [a]);
    assert.deepEqual(sentToServer, [a]);
    const many = await callTool("read_files", { device_id: a, paths: [file] });
    assert.match(many.body, /private-A-marker/);
    const dirList = await callTool("list_directory", { device_id: a, path: dir, depth: 1 });
    assert.match(dirList.body, /marker.txt/);
    const statInfo = await callTool("stat_file", { device_id: a, path: file });
    assert.match(statInfo.body, /marker.txt|size|regular/);
    assert.deepEqual(fromServer, [a,a,a,a]);
    assert.deepEqual(sentToServer, [a,a,a,a]);
    const onDeviceB = await callTool("stat_file", { device_id: b, path: file });
    assert.match(onDeviceB.body, /size/);
    assert.deepEqual(fromServer, [a,a,a,a,b]);
    assert.deepEqual(sentToServer, [a,a,a,a,b]);
    const search = await callTool("search_files", {
      device_id: a, path: dir, pattern: "walk-", search_type: "filename",
    });
    assert.equal(search.http, 200);
    const searchData = JSON.parse(JSON.parse(search.body).result.content[0].text) as {
      session_id?: string; has_more: boolean; results: unknown[];
    };
    assert.equal(searchData.has_more, true);
    assert.equal(searchData.results.length, 20);
    assert.match(searchData.session_id!, /^[0-9a-f-]{36}$/);
    const wrongNext = await callTool("search_next", { device_id: b, session_id: searchData.session_id });
    assert.match(wrongNext.body, /unavailable|failed|rejected/);
    assert.doesNotMatch(wrongNext.body, /walk-/);
    const next = await callTool("search_next", { device_id: a, session_id: searchData.session_id });
    const nextData = JSON.parse(JSON.parse(next.body).result.content[0].text) as { results: unknown[]; has_more: boolean };
    assert.equal(nextData.results.length, 20);
    assert.equal(nextData.has_more, true);
    const stopped = await callTool("stop_search", { device_id: a, session_id: searchData.session_id });
    assert.match(stopped.body, /stopped/);
    assert.deepEqual(fromServer, [a,a,a,a,b,a,b,a,a]);
    assert.deepEqual(sentToServer, [a,a,a,a,b,a,b,a,a]);
    const badPath = await callTool("read_files", { device_id: a, paths: ["https://example.invalid/"] });
    assert.match(badPath.body, /rejected/);
    const badDepth = await callTool("list_directory", { device_id: a, path: dir, depth: 100 });
    assert.match(badDepth.body, /rejected/);
    const badInfo = await callTool("stat_file", { device_id: a, path: file, command: "echo nope" });
    assert.match(badInfo.body, /rejected/);
    const absent = await call(unknown);
    assert.doesNotMatch(absent.body, /private-A-marker/);
    assert.match(absent.body, /unavailable/);
    const invalid = await call("../b");
    assert.match(invalid.body, /valid device_id/);
    assert.equal(legacyCalls, 0);
    assert.equal(fromServer.length, 9, "bad arguments and unknown targets must not reach any Agent");
    // A path-level failure must not be mislabeled as a disconnected device.
    const missingDirectory = await callTool("list_directory", {
      device_id: a, path: path.join(dir, "does-not-exist"), depth: 1,
    });
    assert.match(missingDirectory.body, /directory listing failed/i);
    assert.doesNotMatch(missingDirectory.body, /device is unavailable/i);

    // The default Agent has Shell/session access disabled; report that
    // capability failure without falsely claiming that its WSS is offline.
    const sessions = await callTool("list_sessions", { device_id: a });
    assert.match(sessions.body, /managed-session request failed/i);
    assert.match(sessions.body, /Shell\/session access enabled/i);
    assert.doesNotMatch(sessions.body, /device is unavailable/i);

    // The signed WSS frame budget includes JSON escaping, not just text.length.
    const escapingFile = path.join(dir, "escaping-budget.txt");
    const oversizedRead = await callTool("read_file", { device_id: a, path: escapingFile });
    assert.match(oversizedRead.body, /response budget/i);
    assert.doesNotMatch(oversizedRead.body, /escaping-budget\.txt/);
    assert.doesNotMatch(oversizedRead.body, /device is unavailable/i);

    const batchFile = path.join(dir, "batch-budget.txt");
    const single = await callTool("read_file", { device_id: a, path: batchFile });
    assert.equal(JSON.parse(single.body).result.isError, false);
    const oversizedBatch = await callTool("read_files", { device_id: a, paths: [batchFile, batchFile] });
    assert.match(oversizedBatch.body, /response budget/i);
    assert.doesNotMatch(oversizedBatch.body, /batch-budget\.txt/);
    assert.equal(fromServer.length, expected.length);
    assert.deepEqual(sentToServer, fromServer);
  }
});

test("a second device cannot spoof a read reply and a superseded epoch cannot return stale content", async () => {
  const a = randomUUID(), b = randomUUID();
  const rows = new Map<string, unknown>([
    ["device:" + a, { device_id: a, revoked: false, last_verified_online_at: Date.now(), idle_window_ms: 14 * 86_400_000 }],
    ["device:" + b, { device_id: b, revoked: false, last_verified_online_at: Date.now(), idle_window_ms: 14 * 86_400_000 }],
    ["session:epoch:" + a, "current-a"],
    ["session:epoch:" + b, "current-b"],
  ]);
  let requestId: string | undefined;
  let received!: () => void;
  const hasRequest = new Promise<void>(resolve => { received = resolve; });
  let wrongClosed = false;
  const good = {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({ device_id: a, epoch: "current-a" }),
    send(data: string) {
      const request = JSON.parse(data) as { request_id: string; kind: string };
      assert.equal(request.kind, "read");
      requestId = request.request_id;
      received();
    },
  } as unknown as WebSocket;
  const wrong = {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({ device_id: b, epoch: "current-b" }),
    close(code: number) { assert.equal(code, 1008); wrongClosed = true; },
  } as unknown as WebSocket;
  const owner = new OwnerCoordinator({
    storage: { get: async <T>(key: string) => rows.get(key) as T | undefined },
    getWebSockets(tag: string) { return tag === "device:" + a ? [good] : [wrong]; },
  } as unknown as DurableObjectState);
  const pending = owner.fetch(new Request("https://device.internal/read", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: a, tool: "read_file", arguments: { path: "/tmp/safe" } }),
  }));
  await hasRequest;
  await owner.webSocketMessage(wrong, JSON.stringify({
    kind: "read_result", request_id: requestId, status: "completed", text: "FORGED-B",
  }));
  assert.equal(wrongClosed, true);
  // A new signed WSS session supersedes the original request before its reply.
  rows.set("session:epoch:" + a, "newer-a");
  await owner.webSocketMessage(good, JSON.stringify({
    kind: "read_result", request_id: requestId, status: "completed", text: "STALE-A",
  }));
  const response = await pending;
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /FORGED-B|STALE-A/);
});

test("old epoch and revoked device are rejected before WSS dispatch", async () => {
  const id = randomUUID();
  let sends = 0;
  const rows = new Map<string, unknown>([
    ["device:" + id, { device_id: id, revoked: false, last_verified_online_at: Date.now(), idle_window_ms: 14 * 86_400_000 }],
    ["session:epoch:" + id, "newer"],
  ]);
  const socket = {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({ device_id: id, epoch: "old" }),
    send() { sends++; },
  } as unknown as WebSocket;
  const owner = new OwnerCoordinator({
    storage: { get: async <T>(key: string) => rows.get(key) as T | undefined },
    getWebSockets: () => [socket],
  } as unknown as DurableObjectState);
  const request = () => owner.fetch(new Request("https://device.internal/read", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: id, tool: "read_file", arguments: { path: "/tmp/safe" } }),
  }));
  assert.equal((await request()).status, 503);
  rows.set("device:" + id, { device_id: id, revoked: true });
  assert.equal((await request()).status, 503);
  assert.equal(sends, 0);
});

test("five simultaneous DO reads admit only four bounded in-flight requests", async () => {
  const id = randomUUID();
  const rows = new Map<string, unknown>([
    ["device:" + id, { device_id: id, revoked: false, last_verified_online_at: Date.now(), idle_window_ms: 14 * 86_400_000 }],
    ["session:epoch:" + id, "current"],
  ]);
  const sent: string[] = [];
  let reachedFour!: () => void;
  const four = new Promise<void>(resolve => { reachedFour = resolve; });
  const socket = {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({ device_id: id, epoch: "current" }),
    send(text: string) {
      sent.push((JSON.parse(text) as { request_id: string }).request_id);
      if (sent.length === 4) reachedFour();
    },
  } as unknown as WebSocket;
  const owner = new OwnerCoordinator({
    storage: { get: async <T>(key: string) => rows.get(key) as T | undefined },
    getWebSockets: () => [socket],
  } as unknown as DurableObjectState);
  const makeRequest = () => owner.fetch(new Request("https://device.internal/read", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: id, tool: "read_file", arguments: { path: "/tmp/marker" } }),
  }));
  const requests = Array.from({ length: 5 }, makeRequest);
  await four;
  await Promise.resolve();
  for (const request_id of sent) {
    await owner.webSocketMessage(socket, JSON.stringify({
      kind: "read_result", request_id, status: "completed", text: "ok",
    }));
  }
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 200, 200, 200, 503]);
  assert.equal(sent.length, 4);
});


test("#72 temporary expiry rejects new work on old WSS and after DO reconstruction at exact deadline", async () => {
  const realNow=Date.now;
  const id=randomUUID(), epoch="signed-session-epoch";
  const expiresAt=realNow()+120_000;
  const rows=new Map<string, unknown>([
    ["device:"+id, {device_id:id, name:"temporary-dispatch-fixture", revoked:false, last_verified_online_at: Date.now(), idle_window_ms: 14 * 86_400_000,
      grant_type:"temporary", approved_at:expiresAt-TEMPORARY_GRANT_MS, expires_at:expiresAt}],
    ["session:epoch:"+id,epoch],
  ]);
  let sent=0;
  let owner!: OwnerCoordinator;
  const socket={
    readyState:WebSocket.OPEN,
    deserializeAttachment:()=>({device_id:id, epoch}),
    send(message:string) {
      sent++;
      const incoming=JSON.parse(message) as {request_id:string};
      queueMicrotask(()=>{void owner.webSocketMessage(socket as unknown as WebSocket,
        JSON.stringify({kind:"read_result",request_id:incoming.request_id,
          status:"completed",text:"admitted-before-expiry"}));});
    },
  } as unknown as WebSocket;
  const state={
    storage:{get:async <T>(key:string)=>rows.get(key) as T|undefined},
    getWebSockets:(tag:string)=>tag==="device:"+id?[socket]:[],
  } as unknown as DurableObjectState;
  const request=()=>new Request("https://device.internal/read",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({device_id:id,tool:"read_file",arguments:{path:"/tmp/harmless"}}),
  });
  try {
    Date.now=()=>expiresAt-1;
    owner=new OwnerCoordinator(state);
    const allowed=await owner.fetch(request());
    assert.equal(allowed.status,200);
    assert.match(await allowed.text(),/admitted-before-expiry/);
    assert.equal(sent,1);

    // Authorization uses the server clock at dispatch, even when the
    // authenticated old WSS is still open with a matching durable epoch.
    Date.now=()=>expiresAt;
    const denied=await owner.fetch(request());
    assert.equal(denied.status,503);
    assert.equal((await denied.json() as {error:string}).error,"offline");
    assert.equal(sent,1,"old socket must not receive post-expiry work");

    // Hibernation discards JS in-memory maps but preserves socket attachments.
    owner=new OwnerCoordinator(state);
    const afterWake=await owner.fetch(request());
    assert.equal(afterWake.status,503);
    assert.equal((await afterWake.json() as {error:string}).error,"offline");
    assert.equal(sent,1);
  } finally {
    Date.now=realNow;
  }
});

test("#72: admitted uncertain operation receipt can settle across expiry without any replay", async () => {
  const originalNow = Date.now;
  const deviceId = randomUUID(), epoch = "prior-authorized-epoch", operationId = "existing-operation-1";
  const expiry = originalNow() + 60_000;
  const rows = new Map<string, unknown>([
    ["device:" + deviceId, { device_id: deviceId, name: "temporary-inflight", revoked: false, last_verified_online_at: Date.now(), idle_window_ms: 14 * 86_400_000,
      grant_type: "temporary", approved_at: expiry - TEMPORARY_GRANT_MS, expires_at: expiry }],
    ["session:epoch:" + deviceId, epoch],
  ]);
  let requestId: string | undefined;
  let sent = 0;
  let resolveSent!: () => void;
  const dispatched = new Promise<void>(resolve => { resolveSent = resolve; });
  const socket = {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({ device_id: deviceId, epoch }),
    send(frame: string) {
      sent++;
      const msg = JSON.parse(frame) as {kind:string;operation_id:string;request_id:string};
      assert.equal(msg.kind, "operation");
      assert.equal(msg.operation_id, operationId);
      requestId = msg.request_id;
      resolveSent();
    },
  } as unknown as WebSocket;
  const owner = new OwnerCoordinator({
    storage: { get: async <T>(key:string) => rows.get(key) as T | undefined },
    getWebSockets: (tag:string) => tag === "device:" + deviceId ? [socket] : [],
  } as unknown as DurableObjectState);
  const request = () => new Request("https://device.internal/operation", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: deviceId, tool:"get_operation_status",
      operation_id: operationId, arguments: {operation_id: operationId} }),
  });
  try {
    Date.now = () => expiry - 1;
    const prior = owner.fetch(request());
    await dispatched;
    assert.equal(sent, 1);
    Date.now = () => expiry;
    const denied = await owner.fetch(request());
    assert.equal(denied.status, 503);
    assert.deepEqual(await denied.json(), {error:"offline"});
    assert.equal(sent, 1, "no new work is dispatched after expiry");
    // An operation admitted BEFORE expiry can still return its original
    // uncertain receipt. Its existing effects must not be silently replayed.
    const response = JSON.stringify({
      kind: "operation_result", request_id: requestId,
      result: {operation_id: operationId, status:"unknown",
        receipt: {operation_id: operationId, tool_name:"start_process", state:"unknown",
          safe_result_summary:"Effect cannot be established", private_data:"MUST_NOT_LEAK"}},
    });
    await owner.webSocketMessage(socket, response);
    const settled = await prior;
    assert.equal(settled.status, 200);
    const value = await settled.json() as {operation_id:string; status:string;
      receipt:Record<string,string>};
    assert.equal(value.operation_id, operationId);
    assert.equal(value.status, "unknown");
    assert.equal(value.receipt.state, "unknown");
    assert.equal(value.receipt.operation_id, operationId);
    assert.equal("private_data" in value.receipt, false);
    await owner.webSocketMessage(socket, response);
    assert.equal(sent, 1, "late or duplicate reply never replays a write");
  } finally { Date.now = originalNow; }
});
