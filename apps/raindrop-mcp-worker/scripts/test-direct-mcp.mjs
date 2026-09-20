/* global process, AbortController, AbortSignal, setTimeout, clearTimeout, fetch, URL, console */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

const baseUrl = process.env.RAINDROP_V3_TEST_URL || "https://raindrop-mcp-worker-v3-test.aiyaya.workers.dev";
const token = process.env.MCP_ACCESS_TOKEN;
if (!token) throw new Error("MCP_ACCESS_TOKEN is required for direct MCP smoke");
const names = [
  "collection_create", "collection_delete", "collection_get", "collection_list",
  "collection_tree", "collection_update", "diagnostics", "duplicates_delete",
  "highlight_create", "highlight_delete", "highlight_list", "highlight_update",
  "library_audit", "raindrop_bulk_delete", "raindrop_bulk_update", "raindrop_create",
  "raindrop_delete", "raindrop_get", "raindrop_list", "raindrop_suggest",
  "raindrop_update", "tag_delete", "tag_list", "tag_merge", "tag_rename", "trash_empty",
].sort();

const timeoutMs = 15000;
async function mcp(method, params = {}, authAttempt = 0) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL("/mcp", baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
      signal: controller.signal,
    });
    const readOnly = method === "initialize" || method === "tools/list" ||
      (method === "tools/call" && ["diagnostics", "collection_list"].includes(params.name));
    if (res.status === 401 && readOnly && authAttempt < 11) {
      // Only replay read-only handshake operations while a rotated secret
      // propagates. Mutations must NEVER be retried after submission.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return mcp(method, params, authAttempt + 1);
    }
    if (!res.ok) throw new Error(`MCP ${method}: HTTP ${res.status}`);
    const type = res.headers.get("content-type") || "";
    if (type.includes("text/event-stream")) {
      const lines = (await res.text()).split(/\r?\n/);
      const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trim());
      const payload = data.map(s => { try { return JSON.parse(s); } catch { return null; } }).find(j => j?.jsonrpc === "2.0" && (j?.result || j?.error));
      if (!payload) throw new Error(`MCP ${method}: no valid SSE response`);
      if (payload.error) throw new Error(`MCP ${method}: JSON-RPC error ${payload.error.code}`);
      return payload.result;
    }
    const payload = await res.json();
    if (payload.error) throw new Error(`MCP ${method}: JSON-RPC error ${payload.error.code}`);
    return payload.result;
  } finally {
    clearTimeout(timeout);
  }
}

const healthResponse = await fetch(new URL("/health", baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
assert.equal(healthResponse.status, 200, "Test Worker /health HTTP status");
const health = await healthResponse.json();
assert.equal(health.version, "3.0.0", "Test Worker must be v3; never test production by mistake");
console.log("PASS: isolated test Worker reports v3.0.0");

const unauth = await fetch(new URL("/mcp", baseUrl), {
  method: "POST",
  headers: { Accept: "application/json", "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  signal: AbortSignal.timeout(timeoutMs),
});
assert.equal(unauth.status, 401, "Unauthenticated direct MCP must fail closed");
console.log("PASS: direct MCP rejects unauthenticated request");

let initialized;
for (let attempt = 0; attempt < 12; attempt++) {
  try {
    initialized = await mcp("initialize", {
      protocolVersion: "2025-11-25", capabilities: {},
      clientInfo: { name: "raindrop-v3-isolated-direct", version: "1.0.0" },
    });
    break;
  } catch (error) {
    // A successful deploy can precede propagation of the new per-run secret.
    // Retry ONLY authentication; never replay a submitted mutation.
    if (!String(error).includes("MCP initialize: HTTP 401") || attempt === 11) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}
assert(initialized?.serverInfo, "Direct MCP initialization must return serverInfo");
console.log("PASS: direct MCP initialize");

const listed = await mcp("tools/list");
const actual = (listed.tools || []).map(tool => tool.name).sort();
assert.deepEqual(actual, names, "Direct MCP must expose exactly 26 v3 tools");
console.log("PASS: direct MCP tools/list has exactly 26 v3 tools");

const diagnostics = await mcp("tools/call", { name: "diagnostics", arguments: { includeUpstream: true } });
assert(diagnostics?.structuredContent?.ok === true, "Authenticated live upstream diagnostics must succeed");
console.log("PASS: direct MCP authenticated upstream diagnostics (account details withheld)");

const collectionList = await mcp("tools/call", {
  name: "collection_list", arguments: { page: 0, perpage: 1 },
});
assert(collectionList?.structuredContent?.ok === true, "Direct collection read must succeed");
console.log("PASS: direct MCP read-only collection_list (content withheld)");
