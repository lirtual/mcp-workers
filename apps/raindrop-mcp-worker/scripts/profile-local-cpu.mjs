/* global process, URL, fetch, AbortSignal, console */
/**
 * Local-only, read-only request driver for Wrangler DevTools CPU profiles (#119).
 * This does NOT measure native Cloudflare CPU and must never target a deployed Worker.
 * Run each operation in a separate process/profile for clear attribution.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const localUrl = process.env.RAINDROP_LOCAL_PROFILE_URL ?? "http://127.0.0.1:8787";
const url = new URL(localUrl);
const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
if (url.protocol !== "http:" || !localHosts.has(url.hostname) ||
    url.username || url.password || url.search || url.hash ||
    (url.pathname !== "/" && url.pathname !== "")) {
  throw new Error("Local profile URL must be a plain HTTP loopback origin; remote targets are forbidden");
}

const operation = process.argv[2];
const requests = {
  initialize: {
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "raindrop-v3-local-cpu", version: "1.0.0" },
    },
  },
  tools_list: { method: "tools/list", params: {} },
  diagnostics_local: {
    method: "tools/call",
    params: { name: "diagnostics", arguments: { includeUpstream: false } },
  },
};
if (!Object.hasOwn(requests, operation)) {
  throw new Error("Select one operation: initialize | tools_list | diagnostics_local");
}
const count = Number(process.env.RAINDROP_LOCAL_PROFILE_SAMPLES ?? "10");
const warmups = Number(process.env.RAINDROP_LOCAL_PROFILE_WARMUPS ?? "2");
if (![count, warmups].every(Number.isInteger) || count < 1 || count > 50 || warmups < 0 || warmups > 10) {
  throw new Error("Samples must be 1..50 and warmups 0..10");
}
const token = process.env.RAINDROP_LOCAL_MCP_TOKEN ?? "local-mcp-profile-token";
if (!token || /[\r\n]/.test(token)) throw new Error("Invalid local token");
const timeoutMs = 10000;

async function callMcp({ method, params }) {
  const id = randomUUID();
  const response = await fetch(new URL("/mcp", url), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  assert.equal(response.status, 200, `${method}: unexpected HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  let payload;
  if (contentType.includes("text/event-stream")) {
    payload = text.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => { try { return JSON.parse(line.slice(5).trim()); } catch { return null; } })
      .find((message) => message?.jsonrpc === "2.0" && message.id === id);
  } else if (contentType.includes("application/json")) {
    payload = JSON.parse(text);
  } else {
    throw new Error(`${method}: unexpected Content-Type`);
  }
  assert(payload && payload.id === id, `${method}: no matching JSON-RPC response`);
  assert(!payload.error, `${method}: JSON-RPC error ${payload.error?.code}`);
  if (method === "initialize") assert(payload.result?.serverInfo, "Missing serverInfo");
  else if (method === "tools/list") assert.equal(payload.result?.tools?.length, 26, "Unexpected tool count");
  else assert.equal(payload.result?.structuredContent?.ok, true, "Local diagnostics failed");
}

console.log(`LOCAL_PROFILE_START op=${operation} samples=${count} warmups=${warmups} utc=${new Date().toISOString()}`);
for (let i = 0; i < warmups + count; i++) {
  const phase = i < warmups ? "warmup" : "sample";
  const n = i < warmups ? i + 1 : i - warmups + 1;
  console.log(`LOCAL_PROFILE_BEGIN op=${operation} phase=${phase} sample=${n} utc=${new Date().toISOString()}`);
  await callMcp(requests[operation]);
  console.log(`LOCAL_PROFILE_END op=${operation} phase=${phase} sample=${n} utc=${new Date().toISOString()}`);
}
console.log(`LOCAL_PROFILE_PASS op=${operation} utc=${new Date().toISOString()} (no upstream reads/writes, no response bodies logged)`);
