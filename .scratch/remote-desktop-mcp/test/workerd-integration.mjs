// THROWAWAY local workerd integration test for #173. Never connects to a real desktop.
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import WebSocket from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const varsPath = resolve(root, ".dev.vars");
const token = () => randomBytes(32).toString("hex");
const mcpToken = token(), deviceToken = token(), adminToken = token();
const base = "http://127.0.0.1:18773";
let child, socket;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const auth = (value) => ({ authorization: `Bearer ${value}` });

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
  assert.deepEqual(list.data.result.tools.map((x) => x.name), ["sandbox_ping"]);
  assert.equal((await call("tools/list", {}, 5, "wrong-token")).status, 401);
  assert.equal((await call("tools/call", { name: "sandbox_ping", arguments: { echo: "offline" } })).data.error.message, "offline");

  socket = device();
  await once(socket, "open");
  const pair = [];
  socket.on("message", (data) => {
    const msg = JSON.parse(data.toString());
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

  const [first, second] = await Promise.all([
    call("tools/call", { name: "sandbox_ping", arguments: { echo: "first" } }, 11),
    call("tools/call", { name: "sandbox_ping", arguments: { echo: "second" } }, 12),
  ]);
  assert.equal(JSON.parse(first.data.result.content[0].text).echo, "first");
  assert.equal(JSON.parse(second.data.result.content[0].text).echo, "second");
  assert.equal((await call("tools/call", { name: "sandbox_ping", arguments: { echo: "timeout" } }, 13)).data.error.message, "timeout");
  assert.equal((await call("tools/call", { name: "sandbox_ping", arguments: { echo: "disconnect" } }, 14)).data.error.message, "offline");

  socket = device();
  await once(socket, "open");
  socket.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    socket.send(JSON.stringify({ type: "result", id: msg.id, result: { echo: msg.arguments.echo } }));
  });
  assert.equal(JSON.parse((await call("tools/call",
    { name: "sandbox_ping", arguments: { echo: "reconnected" } }, 15)).data.result.content[0].text).echo, "reconnected");
  const revoked = await fetch(base + "/admin/revoke", { method: "POST", headers: auth(adminToken) });
  assert.equal(revoked.status, 200);
  assert.equal((await call("tools/call", { name: "sandbox_ping", arguments: { echo: "after-revoke" } }, 16)).data.error.message, "revoked");
  const forbidden = device();
  forbidden.on("error", () => {}); // ws also emits ECONNRESET-style errors after rejected handshakes.
  const response = await once(forbidden, "unexpected-response");
  assert.equal(response[0].statusCode, 403);
  forbidden.terminate();
  console.log("PASS local workerd: MCP initialize/list, auth, offline, WebSocket echo, concurrency, timeout, disconnect, reconnect, revoke");
} finally {
  socket?.terminate();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), sleep(2500)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await rm(varsPath, { force: true });
}
