// THROWAWAY local workerd integration test for #173; upstream runs in a no-network Docker sandbox, never on the real host.
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { writeFile, rm, mkdtemp, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { connectSandboxBridge } from "../local-bridge.mjs";
import { readViaIsolatedDesktopCommander } from "../isolated-upstream.mjs";
import WebSocket from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const varsPath = resolve(root, ".dev.vars");
const token = () => randomBytes(32).toString("hex");
const mcpToken = token(), deviceToken = token(), adminToken = token();
const base = "http://127.0.0.1:18773";
let child, socket, fixtureRoot;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const auth = (value) => ({ authorization: `Bearer ${value}` });
const execFileAsync = promisify(execFile);
const inspectorBin = resolve(root, "node_modules/@modelcontextprotocol/inspector/clients/launcher/build/index.js");
async function inspector(method, extra = []) {
  // Do not print the process argv or its ephemeral Authorization header to CI.
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [
      inspectorBin, "--cli", base + "/mcp",
      "--transport", "http", "--protocol-era", "legacy",
      "--method", method, "--header", `Authorization: Bearer ${mcpToken}`,
      "--format", "json", ...extra,
    ], { cwd: root, timeout: 30000, maxBuffer: 65536 }));
  } catch (e) {
    throw new Error(`inspector_${method.replace("/", "_")}_failed_${e.code ?? "unknown"}`);
  }
  try { return JSON.parse(stdout).result; }
  catch { throw new Error("inspector_invalid_json_result"); }
}

async function call(method, params, id = 1, credential = mcpToken) {
  const response = await fetch(base + "/mcp", {
    method: "POST",
    headers: { ...auth(credential), "content-type": "application/json",
      accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: response.status, data: await response.json() };
}
function device(credentials = deviceToken) {
  return new WebSocket(base.replace("http:", "ws:") + "/device",
    { headers: auth(credentials) });
}

try {
  await writeFile(varsPath, [
    `PROTOTYPE_MCP_TOKEN="${mcpToken}"`,
    `PROTOTYPE_DEVICE_TOKEN="${deviceToken}"`,
    `PROTOTYPE_ADMIN_TOKEN="${adminToken}"`,
    `PROTOTYPE_ALLOWED_ORIGIN="${base}"`,
    "",
  ].join("\n"), { mode: 0o600 });
  child = spawn("pnpm", [
    "--filter", "workflow-mcp-worker", "exec", "wrangler", "dev",
    "--config", "../../.scratch/remote-desktop-mcp/wrangler.jsonc",
    "--ip", "127.0.0.1", "--port", "18773", "--local",
  ], { cwd: resolve(root, "../.."), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (bytes) => { output += bytes.toString().slice(0, 2000); });
  child.stderr.on("data", (bytes) => { output += bytes.toString().slice(0, 2000); });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error("wrangler exited before startup: " + output.slice(-2000));
    try {
      const response = await fetch(base + "/mcp");
      if (response.status === 401) { ready = true; break; }
      if (response.status === 503) throw new Error("prototype secrets not loaded");
    } catch (e) {
      if (e.message?.includes("secrets")) throw e;
    }
    await sleep(400);
  }
  assert.equal(ready, true, "local Worker failed to become ready: " + output.slice(-2000));
  assert.equal((await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).data.result.serverInfo.name,
    "throwaway-remote-desktop-prototype");
  const list = await call("tools/list", {});
  assert.deepEqual(list.data.result.tools.map((x) => x.name), ["sandbox_ping", "sandbox_list_directory"]);
  // Official MCP Inspector CLI, not a hand-crafted JSON-RPC client.
  // The prototype deliberately negotiates the pre-2026-07 legacy protocol.
  const inspected = await inspector("tools/list", ["--strict"]);
  assert.deepEqual(inspected.tools.map((tool) => tool.name),
    ["sandbox_ping", "sandbox_list_directory"]);
  assert.equal((await call("tools/call", { name: "sandbox_list_directory", arguments: { path: "/" } }, 6)).data.error.code, -32602);
  assert.equal((await call("tools/call", { name: "sandbox_list_directory", arguments: {} }, 7)).data.error.message, "offline");
  assert.equal((await call("tools/list", {}, 5, "wrong-token")).status, 401);
  // Exercise unauthenticated and malformed requests without dispatching a tool.
  assert.equal((await fetch(base + "/admin/revoke", { method: "POST",
    headers: auth("wrong-admin") })).status, 401);
  const wrongDevice = device("wrong-device");
  wrongDevice.on("error", () => {});
  const refused = await once(wrongDevice, "unexpected-response");
  assert.equal(refused[1].statusCode, 401);
  wrongDevice.terminate();
  const raw = async (text) => fetch(base + "/mcp", {
    method: "POST",
    headers: { ...auth(mcpToken), "content-type": "application/json" },
    body: text,
  });
  assert.equal((await raw("{invalid-json")).status, 400);
  // Same-origin request is allowed, cross-origin and forged/new MCP versions
  // fail before a tool can be dispatched; future Portal origins need review.
  const originCall = async (origin) => fetch(base + "/mcp", {
    method: "POST",
    headers: { ...auth(mcpToken), origin, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 203, method: "ping" }),
  });
  assert.equal((await originCall("https://untrusted.invalid")).status, 403);
  // A forged Host paired with a matching evil Origin is still forbidden.
  const rebound = await fetch(base + "/mcp", {
    method: "POST",
    headers: { ...auth(mcpToken), host: "untrusted.invalid",
      origin: "http://untrusted.invalid", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 205, method: "ping" }),
  });
  assert.equal(rebound.status, 403);
  assert.equal((await originCall("null")).status, 403);
  assert.equal((await originCall(base)).status, 200);
  const versionCall = async (version) => fetch(base + "/mcp", {
    method: "POST",
    headers: { ...auth(mcpToken), "content-type": "application/json",
      "mcp-protocol-version": version },
    body: JSON.stringify({ jsonrpc: "2.0", id: 204, method: "ping" }),
  });
  assert.equal((await versionCall("2026-07-28")).status, 400);
  assert.equal((await versionCall("2025-11-25")).status, 400);
  assert.equal((await versionCall("2025-06-18")).status, 200);
  assert.equal((await raw("x".repeat(9000))).status, 400);
  const encoded = "界".repeat(3000); // chars < LIMIT, UTF-8 bytes > LIMIT
  assert.equal((await raw(JSON.stringify({ jsonrpc: "2.0", id: 200,
    method: "ping", padding: encoded }))).status, 400);
  assert.equal((await call("tools/call", { name: "execute_command",
    arguments: { command: "true" } }, 201)).data.error.code, -32602);
  assert.equal((await call("tools/call", { name: "sandbox_ping",
    arguments: { echo: "ok", command: "true" } }, 202)).data.error.code, -32602);
  assert.equal((await call("tools/call", { name: "sandbox_ping",
    arguments: { echo: "offline" } })).data.error.message, "offline");

  socket = device();
  await once(socket, "open");
  const pair = [];
  socket.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.tool === "sandbox_list_directory") {
      assert.deepEqual(msg.arguments, {});
      socket.send(JSON.stringify({ type: "result", id: msg.id, result: { entries: ["test-only.txt"] } }));
      return;
    }
    if (msg.arguments.echo === "timeout") return;
    if (msg.arguments.echo === "disconnect") { socket.close(); return; }
    if (msg.arguments.echo === "first" || msg.arguments.echo === "second") {
      pair.push(msg);
      if (pair.length === 2) {
        for (const item of pair.splice(0).reverse()) {
          socket.send(JSON.stringify({ type: "result", id: item.id, result: { echo: item.arguments.echo } }));
        }
      }
      return;
    }
    socket.send(JSON.stringify({ type: "result", id: msg.id, result: { echo: msg.arguments.echo } }));
  });
  const echoed = await call("tools/call", { name: "sandbox_ping", arguments: { echo: "hello" } }, 10);
  assert.deepEqual(JSON.parse(echoed.data.result.content[0].text), { echo: "hello" });
  const inspectedPing = await inspector("tools/call", [
    "--tool-name", "sandbox_ping", "--tool-args-json", '{"echo":"inspector"}',
  ]);
  assert.deepEqual(JSON.parse(inspectedPing.content[0].text), { echo: "inspector" });
  const listed = await call("tools/call", { name: "sandbox_list_directory", arguments: {} }, 17);
  assert.deepEqual(JSON.parse(listed.data.result.content[0].text), { entries: ["test-only.txt"] });

  const [first, second] = await Promise.all([
    call("tools/call", { name: "sandbox_ping", arguments: { echo: "first" } }, 11),
    call("tools/call", { name: "sandbox_ping", arguments: { echo: "second" } }, 12),
  ]);
  assert.equal(JSON.parse(first.data.result.content[0].text).echo, "first");
  assert.equal(JSON.parse(second.data.result.content[0].text).echo, "second");
  assert.equal((await call("tools/call", { name: "sandbox_ping", arguments: { echo: "timeout" } }, 13)).data.error.message, "timeout");
  assert.equal((await call("tools/call", { name: "sandbox_ping", arguments: { echo: "disconnect" } }, 14)).data.error.message, "offline");

  // A bad device result must close only that device connection, not the Worker.
  // Verify actual workerd WebSocket size enforcement (UTF-8 bytes, not characters).
  const oversizedSocket = device();
  await once(oversizedSocket, "open");
  const tooLargeClosed = once(oversizedSocket, "close");
  oversizedSocket.send(JSON.stringify({ type: "result", id: "unknown",
    result: { text: "界".repeat(3000) } }));
  assert.equal((await Promise.race([
    tooLargeClosed, sleep(5000).then(() => { throw new Error("oversized_socket_did_not_close"); }),
  ]))[0], 1009);

  const malformedSocket = device();
  await once(malformedSocket, "open");
  const malformedClosed = once(malformedSocket, "close");
  malformedSocket.send("{invalid-json");
  assert.equal((await Promise.race([
    malformedClosed, sleep(5000).then(() => { throw new Error("malformed_socket_did_not_close"); }),
  ]))[0], 1007);

  // A real local read-only bridge now reads ONLY its fixed temporary directory,
  // while the previous synthetic device exercises timed calls and reordering.
  fixtureRoot = await mkdtemp(join(tmpdir(), "remote-desktop-173-"));
  await writeFile(join(fixtureRoot, "test-only.txt"), "safe fixture");
  socket = await connectSandboxBridge({
    endpoint: base.replace("http:", "ws:") + "/device",
    token: deviceToken,
    sandboxRoot: fixtureRoot,
  });
  assert.equal(JSON.parse((await call("tools/call",
    { name: "sandbox_ping", arguments: { echo: "reconnected" } }, 15)).data.result.content[0].text).echo, "reconnected");
  const actualFiles = await call("tools/call", { name: "sandbox_list_directory", arguments: {} }, 18);
  assert.deepEqual(JSON.parse(actualFiles.data.result.content[0].text), { entries: ["test-only.txt"] });
  assert.equal((await call("tools/call", { name: "sandbox_list_directory",
    arguments: { path: "/etc" } }, 19)).data.error.code, -32602);

  // Actual upstream round trip: MCP -> Worker -> DO -> outbound WebSocket ->
  // Docker-isolated Desktop Commander 0.2.51 stdio -> WebSocket -> MCP.
  // Docker runs with --network none, read-only root, no capabilities, non-root.
  await chmod(fixtureRoot, 0o755); // Allow fixed non-root container UID to read mount.
  await writeFile(join(fixtureRoot, "proof-only.txt"), "upstream fixture", { mode: 0o644 });
  socket = await connectSandboxBridge({
    endpoint: base.replace("http:", "ws:") + "/device",
    token: deviceToken,
    sandboxRoot: fixtureRoot,
    directoryReader: readViaIsolatedDesktopCommander,
  });
  const upstream = await call("tools/call", { name: "sandbox_list_directory", arguments: {} }, 20);
  assert.equal(upstream.status, 200);
  assert.equal(upstream.data.error, undefined, JSON.stringify(upstream.data.error));
  const upstreamResult = JSON.parse(upstream.data.result.content[0].text);
  assert.equal(upstreamResult.source, "desktop-commander-0.2.51");
  assert.ok(upstreamResult.text.includes("proof-only.txt"), "upstream_reply_missing_fixture");
  assert.equal((await call("tools/call", { name: "sandbox_list_directory",
    arguments: { path: "/etc" } }, 21)).data.error.code, -32602);

  const revoked = await fetch(base + "/admin/revoke", { method: "POST", headers: auth(adminToken) });
  assert.equal(revoked.status, 200);
  assert.equal((await call("tools/call", { name: "sandbox_ping", arguments: { echo: "after-revoke" } }, 16)).data.error.message, "revoked");
  const forbidden = device();
  forbidden.on("error", () => {}); // ws also emits ECONNRESET-style errors after rejected handshakes.
  const response = await once(forbidden, "unexpected-response");
  assert.equal(response[1].statusCode, 403);
  forbidden.terminate();
  console.log("PASS local workerd: official MCP Inspector legacy tool listing/call, Origin/version rejection, MCP initialize/list, real isolated upstream stdio round trip, fixed directory read, invalid path, unauthorized admin/device, oversized HTTP/WebSocket UTF-8, malformed WebSocket/JSON, forbidden tools, auth, offline, WebSocket echo, concurrency, timeout, disconnect, reconnect, revoke");
} finally {
  socket?.terminate();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), sleep(2500)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await rm(varsPath, { force: true });
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
}
