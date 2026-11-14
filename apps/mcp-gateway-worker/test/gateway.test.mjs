import assert from "node:assert/strict";
import { test } from "node:test";
import { gatewayFetch } from "../src/worker.ts";

const origin = "https://gateway.example.test";
const portal = "https://portal.example.test/mcp";
const env = {
  CLERK_SECRET_KEY: "sk_test_example",
  CLERK_PUBLISHABLE_KEY: "pk_test_example",
  CLERK_OWNER_USER_ID: "user_Test123",
  CLERK_ISSUER: "https://issuer.example.test",
  GATEWAY_ORIGIN: origin,
  PORTAL_MCP_URL: portal,
  CF_ACCESS_CLIENT_ID: "gateway-machine-id",
  CF_ACCESS_CLIENT_SECRET: "gateway-machine-secret",
};
const message = (method, params = undefined) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });
const request = (server, method = "POST", body = message("tools/list"), headers = {}) =>
  new Request(origin + "/mcp/" + server, {
    method,
    headers: { authorization: "Bearer test-oauth", ...(method === "POST" ? { "content-type": "application/json" } : {}), ...headers },
    ...(method === "POST" ? { body } : {}),
  });
const jsonResponse = (payload) => Response.json(payload, { headers: { "content-type": "application/json" } });
const toolList = () => jsonResponse({
  jsonrpc: "2.0", id: 1, result: { tools: [
    { name: "sentry_issue_list" },
    { name: "raindrop_collection_list" },
    { name: "portal_toggle_single_server" },
  ] },
});

test("unauthenticated MCP GET exposes a resource-specific 401 challenge for Clerk discovery", async () => {
  const response = await gatewayFetch(new Request(origin + "/mcp/sentry"), env);
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /oauth-protected-resource\/mcp\/sentry/);
});

test("authenticated tool discovery projects the current server and strips caller credentials", async () => {
  let forwarded = 0;
  const response = await gatewayFetch(request("sentry"), env, {
    verifyOAuth: async (_, resource) => resource === origin + "/mcp/sentry",
    sendPortal: async (url, init) => {
      forwarded++;
      assert.equal(url, portal);
      assert.equal(init.redirect, "manual");
      assert.equal(init.headers.get("CF-Access-Client-Id"), "gateway-machine-id");
      assert.equal(init.headers.get("CF-Access-Client-Secret"), "gateway-machine-secret");
      assert.equal(init.headers.has("authorization"), false);
      assert.equal(init.headers.has("cookie"), false);
      return toolList();
    },
  });
  assert.equal(forwarded, 1);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result.tools.map((t) => t.name), ["sentry_issue_list"]);
  assert.equal(response.headers.has("CF-Access-Client-Secret"), false);
});

test("direct cross-server and Portal management calls never reach the shared machine identity", async () => {
  for (const name of ["raindrop_collection_list", "portal_toggle_single_server", "portal_codemode_execute"]) {
    let forwarded = false;
    const response = await gatewayFetch(request("sentry", "POST", message("tools/call", { name })), env, {
      verifyOAuth: async () => true,
      sendPortal: async () => { forwarded = true; return jsonResponse({}); },
    });
    assert.equal(response.status, 403, name);
    assert.equal(forwarded, false, name);
  }
});

test("wrong Audience/Owner or invalid OAuth is rejected before Portal access", async () => {
  let forwarded = false;
  const response = await gatewayFetch(request("sentry"), env, {
    verifyOAuth: async () => false,
    sendPortal: async () => { forwarded = true; return toolList(); },
  });
  assert.equal(response.status, 401);
  assert.equal(forwarded, false);
});

test("Portal 3xx is rejected without following a machine credential redirect", async () => {
  const response = await gatewayFetch(request("sentry"), env, {
    verifyOAuth: async () => true,
    sendPortal: async (_url, init) => {
      assert.equal(init.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "https://evil.example.test" } });
    },
  });
  assert.equal(response.status, 502);
  assert.equal(response.headers.has("location"), false);
});

test("invalid or unknown MCP methods fail closed before upstream requests", async () => {
  let forwarded = false;
  const response = await gatewayFetch(request("sentry", "POST", message("resources/read", { uri: "file://sentry" })), env, {
    verifyOAuth: async () => true,
    sendPortal: async () => { forwarded = true; return toolList(); },
  });
  assert.equal(response.status, 403);
  assert.equal(forwarded, false);
});

test("missing runtime configuration blocks upstream calls", async () => {
  const response = await gatewayFetch(request("sentry"), { ...env, CF_ACCESS_CLIENT_SECRET: "" });
  assert.equal(response.status, 503);
});

test("tools/call checks the live Portal tool list before performing a side effect", async () => {
  const calls = [];
  const resp = await gatewayFetch(request("sentry", "POST", message("tools/call", { name: "sentry_issue_list", arguments: {} })), env, {
    verifyOAuth: async () => true,
    sendPortal: async (_url, init) => {
      const req = JSON.parse(init.body);
      calls.push(req.method);
      assert.equal(init.redirect, "manual");
      if (req.method === "tools/list") return toolList();
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { content: [] } });
    },
  });
  assert.equal(resp.status, 200);
  assert.deepEqual(calls, ["tools/list", "tools/call"]);
});

test("tools/call rejects a Portal-disabled or inaccessible tool before execution", async () => {
  let forwardedExecution = false;
  const resp = await gatewayFetch(request("sentry", "POST", message("tools/call", { name: "sentry_issue_update", arguments: {} })), env, {
    verifyOAuth: async () => true,
    sendPortal: async (_url, init) => {
      if (JSON.parse(init.body).method === "tools/call") forwardedExecution = true;
      return toolList();
    },
  });
  assert.equal(resp.status, 403);
  assert.equal(forwardedExecution, false);
});

test("tools/call fails closed when live Portal tool discovery is unavailable", async () => {
  let executed = false;
  const resp = await gatewayFetch(request("sentry", "POST", message("tools/call", { name: "sentry_issue_list" })), env, {
    verifyOAuth: async () => true,
    sendPortal: async (_url, init) => {
      if (JSON.parse(init.body).method === "tools/call") executed = true;
      return new Response(null, { status: 302, headers: { location: "https://evil.example.test" } });
    },
  });
  assert.equal(resp.status, 502);
  assert.equal(executed, false);
});

test("tools/call follows live Portal tool pagination without a second tool catalog", async () => {
  const calls = [];
  const response = await gatewayFetch(request("sentry", "POST", message("tools/call", { name: "sentry_issue_list" })), env, {
    verifyOAuth: async () => true,
    sendPortal: async (_url, init) => {
      const req = JSON.parse(init.body);
      calls.push(req.method);
      if (req.method === "tools/call") return jsonResponse({ jsonrpc: "2.0", id: 1, result: { content: [] } });
      if (!req.params?.cursor) return jsonResponse({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "raindrop_collection_list" }], nextCursor: "next" } });
      assert.equal(req.params.cursor, "next");
      return toolList();
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["tools/list", "tools/list", "tools/call"]);
});

test("tools/call checks the live Portal list when Portal uses SSE", async () => {
  let executed = false;
  const response = await gatewayFetch(request("sentry", "POST", message("tools/call", { name: "sentry_issue_list" })), env, {
    verifyOAuth: async () => true,
    sendPortal: async (_url, init) => {
      const req = JSON.parse(init.body);
      if (req.method === "tools/call") {
        executed = true;
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { content: [] } });
      }
      const data = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "sentry_issue_list" }] } });
      return new Response(`event: message\ndata: ${data}\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  assert.equal(response.status, 200);
  assert.equal(executed, true);
});

test("tools/call fails closed on a cyclic Portal pagination cursor", async () => {
  let calls = 0;
  const response = await gatewayFetch(request("sentry", "POST", message("tools/call", { name: "sentry_issue_list" })), env, {
    verifyOAuth: async () => true,
    sendPortal: async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(init.body).method, "tools/list");
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { tools: [], nextCursor: "same" } });
    },
  });
  assert.equal(response.status, 502);
  assert.equal(calls, 2);
});
